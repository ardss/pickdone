/**
 * External-write watcher — moved verbatim from src/main/index.js (size-ratchet split, no behavior change).
 * When the CLI writes the DB directly, the running App refreshes automatically: fs.watchFile poll on
 * todos.db / todos.db-wal + the CLI tomato/sync/settings command channels that ride the same poll.
 * Factory form because the watcher carries per-instance closure state (mtime baseline, command
 * watermarks, resync/stop hooks) that index.js previously held as module lets.
 */
const path = require('path')
const fs = require('fs')

// 2026-09-28 r2: the abandon/seed policy (TTL constant + fresh-vs-stale decision) lives in
// cli-slot-policy.js as a shared pure function — it was previously hand-copied here AND in
// cli-sync-channel.js (TTL constant defined twice, kept in sync only by a comment). The
// compare-and-delete of the slot stays a caller-side callback (see seedSlotWatermark).
const { CLI_SLOT_ABANDON_TTL_MS, seedSlotWatermark } = require('./cli-slot-policy')

/** Seed the tomato command watermark at startup. Returns the initial lastTomatoSeq.
 *  Pure/injected so the seed policy (including the abandonment TTL) is unit-testable without
 *  Electron. getMeta/deleteMeta talk to the machine-local meta table; deleteMeta is optional
 *  (tests without a meta writer just get the watermark back, slot left in place). */
function seedTomatoWatermark ({ getMeta, deleteMeta }) {
  return seedSlotWatermark({
    counter: (() => { try { return Number(getMeta('cliTomatoSeq')) || 0 } catch { return 0 } })(),
    slotRaw: (() => { try { return getMeta('cliTomatoCmd') } catch { return null } })(),
    now: Date.now(),
    onAbandon: (queued) => {
      try {
        if (typeof deleteMeta === 'function') {
          const cur = JSON.parse(getMeta('cliTomatoCmd') || 'null')
          // Compare-and-delete: never eat a NEWER command that landed while we seeded.
          if (cur && Number(cur.seq) === Number(queued.seq)) deleteMeta('cliTomatoCmd')
        }
      } catch { /* best-effort cleanup */ }
    },
  })
}

function createExternalDbWatch (deps) {
  const {
    app, log, dbm, fixUtil, extWatchGate, nextWatchBaseline, scheduler,
    getMainWindow, isLocked, dbApi,
    broadcastTodosChanged, broadcastTomatoRecordsChanged, BrowserWindow
  } = deps
  let resyncDbWatch = null // set by watchDbForExternalWrites: re-baselines lastMtime after OUR OWN db writes (P1 2026-09-11)
  let stopDbWatch = null // set by watchDbForExternalWrites: unwatchFile both files on the quit chain (P2 2026-09-11)
  function watchDbForExternalWrites () {
    const ud = app.getPath('userData')
    const dbFile = path.join(ud, 'todos.db')
    const walFile = dbFile + '-wal'
    // In WAL mode CLI writes only land in -wal and the main DB's mtime stays unchanged (once broke the 2s broadcast, leaving stale UI data); watch both files
    // P2 2026-09-12 torn read: two independent statSync calls raced a concurrent CLI wal write — the
    // baseline absorbed half a write (missed event) or saw a transient value (false external-write
    // reload). Take the value only when two consecutive reads agree (fix-util.stableRead); persistent
    // disagreement (extremely rare) yields null and this poll is skipped, the next one re-reads.
    const readWatchMtime = () => {
      const statOne = () => Math.max(fs.statSync(dbFile).mtimeMs, fs.existsSync(walFile) ? fs.statSync(walFile).mtimeMs : 0)
      return fixUtil.stableRead(statOne)
    }
    // P2 2026-09-19: `readWatchMtime() || 0` mapped a null baseline (torn read at startup) to 0, so
    // the first poll was a GUARANTEED false external-write (full reload + undo-stack wipe) the moment
    // the real mtime came in. Keep the baseline null instead and let onChange establish it from the
    // first non-null read WITHOUT kicking — a null baseline means "disarmed", not "everything changed".
    let lastMtime = readWatchMtime()
    if (lastMtime == null) log.warn('[TodoDB] 启动基线读取未定（torn read），首轮轮询仅建立基线不触发刷新')
    let lastTomatoCmdRaw = null
    // Round-1 P0 (2026-09-21): seed the tomato command watermark from the persisted cliTomatoSeq
    // counter (same restart-replay fix as the cliSyncCmd channel) — a stale slot command must not
    // re-execute on every app restart.
    let lastTomatoSeq = seedTomatoWatermark({
      getMeta: k => dbm.call('getMeta', k),
      deleteMeta: k => require('./command-bus').commit('meta', 'delete', k, { preserveStamp: true })
    })
    // CLI settings hot-sync baseline: the first poll only builds the baseline and does not push (otherwise startup would push a full diff by mistake)
    let lastSettingsSavedAt = 0
    let lastSettingsDoc = null
    try {
      const rawS = dbm.call('getMeta', 'db.settingsState')
      if (rawS) { const d = JSON.parse(rawS); lastSettingsSavedAt = (d && d._savedAt) || 0; lastSettingsDoc = d }
    } catch {}
    let debounce = null
    // CLI sync command channel (feat/cli-sync-pair): same polling surface as cliTomatoCmd — the CLI
    // writes meta cliSyncCmd, we dispatch into db-sync-ops (the Device Center's own registry) and
    // write the receipt to cliSyncState. Handled in the MAIN process directly: LAN sync state lives
    // here, not in the renderer, so no window forwarding is involved (and the security lock, which
    // only gates todo-db:call IPC, must not wedge headless pairing of an idle machine).
    let forwardSyncCmd = () => {}
    try {
      const syncChannel = require('./cli-sync-channel')
      const syncOps = require('./db-sync-ops')
      const channel = syncChannel.createSyncCmdHandler({
        dispatch: (op, p) => syncOps.dispatch(op, p),
        setMeta: (k, v) => require('./command-bus').commit('meta', 'put', [k, v], { preserveStamp: true }), // Phase-2: receipt write via the bus (cliSync* keys are machine-local — no sync kick)
        // Round-1 P0 (2026-09-21): seed the seq watermark from the persisted counter + clear the
        // handled slot — an old `unpair` left in cliSyncCmd must never replay on every app restart
        // (it rotated the pairing secret and silently dropped the peer).
        getMeta: k => dbm.call('getMeta', k),
        deleteMeta: k => require('./command-bus').commit('meta', 'delete', k, { preserveStamp: true }),
        log
      })
      forwardSyncCmd = () => {
        try { channel.forward(dbm.call('getMeta', 'cliSyncCmd')) } catch (e) { log.warn('[CLI] sync 命令转发失败', e) }
      }
    } catch (e) { log.warn('[CLI] sync 命令通道初始化失败', e) }
    /* Tomato command forwarding: independent of mtime — fs.watchFile polling occasionally drops events, which
       once let a stop command be silently skipped (meta is a single slot; once an old command is overwritten by a
       new one it is lost forever), so every poll reads meta directly once (pure read). */
    const forwardTomatoCmd = () => {
      try {
        const raw = dbm.call('getMeta', 'cliTomatoCmd')
        // 守卫只包转发段,不得 return 整函数——函数后半段还承担 CLI 设置热同步(2026-09-04 二轮深审 P0:提前 return 曾短路设置推送)。
        // 锁屏态不转发也不标记已消费:锁定时 todo-db:call 全拒,转发了会'半执行'(计时启动但回执被拒),解锁后 onChange 自然补发。
        // F2 2026-09-15 竞态根修:此前 lastTomatoSeq 在 send 之前推进且 send 前无 isDestroyed 复查——窗口销毁/
        // 重建间隙 send 抛错被外层 catch 成 warn,但 seq 已消费 → 命令永久丢失。现抽为纯逻辑
        // fixUtil.tryForwardTomatoCmd:send 成功才推进 seq,失败/窗口未就绪均不消费(下轮轮询重投)。
        const st = fixUtil.tryForwardTomatoCmd({
          raw, lastTomatoCmdRaw, lastTomatoSeq, getMainWindow, isLocked,
          // Round-1 P0 (2026-09-21): after a successful forward, clear the slot so the command
          // cannot replay on the next app restart (compare-and-delete: never eat a newer command).
          clearCmd: (cmd) => {
            try {
              const cur = JSON.parse(dbm.call('getMeta', 'cliTomatoCmd') || 'null')
              if (cur && Number(cur.seq) === Number(cmd.seq)) require('./command-bus').commit('meta', 'delete', 'cliTomatoCmd', { preserveStamp: true })
            } catch { /* best-effort cleanup */ }
          }
        })
        lastTomatoCmdRaw = st.lastTomatoCmdRaw
        lastTomatoSeq = st.lastTomatoSeq
        // 账本类命令已退役为 CLI 直写行表(渲染端经 tomato-records-changed 回灌),本通道只剩状态类 start/stop/attach,只发主窗
        if (st.sent) log.info('[CLI] 番茄命令已转发渲染端:', st.cmd.action, 'seq=' + st.cmd.seq)
        // r2 2026-09-28: 运行期弃置——CLI 已超时放弃(APP_NOT_RUNNING)的命令在窗口/解锁恢复后不得补执行
        else if (st.abandoned) log.warn('[CLI] 番茄命令已过期弃置(超过 slot TTL,CLI 早已超时):', st.cmd.action, 'seq=' + st.cmd.seq)
      } catch (e) { log.warn('[CLI] 番茄命令转发失败', e) }
      // CLI settings set: mirror changes to db.settingsState's _savedAt → diff and push to the renderer for hot application
      // (renderer dispatches settings/update → IPC notify-settings-updated → main-process config.json/shortcuts/login item sync accordingly)
      // C14 (P2 2026-09-24): the change watermark used to be the blob's _savedAt alone — a whole-blob
      // snapshot stamp written from the doc's READ time. Two CLI writes within one poll interval (or two
      // concurrent CLI processes) could land the same _savedAt millisecond while settings_rows (the
      // field-granular write truth, see cli/lib.js settingsSet row-path-first) already recorded both
      // field updates — the intermediate state evaporated and the renderer never saw it. The watermark
      // is now max(blob._savedAt, settings_rows max(updatedAt)): row updatedAt is stamped per real field
      // change, so a same-millisecond blob stamp can no longer mask a change. Deleted rows count too (a
      // tombstone is a state change the renderer must see).
      try {
        const rawS = dbm.call('getMeta', 'db.settingsState')
        let doc = null
        let at = 0
        if (rawS) { doc = JSON.parse(rawS); at = (doc && doc._savedAt) || 0 }
        try {
          // Round-3 perf (2026-09-26): identical watermark via one MAX aggregate (tick runs ~4x/sec).
          const maxRow = Number(dbm.call('settingsRowsMaxUpdated')) || 0
          if (maxRow > at) at = maxRow
        } catch { /* rows unavailable (legacy lib) → fall back to the _savedAt-only watermark */ }
        if (doc && at > lastSettingsSavedAt) {
          const prev = lastSettingsDoc
          lastSettingsSavedAt = at
          lastSettingsDoc = doc
          const win = getMainWindow()
          if (prev && win) {
            // Diff moved to settings-hot-sync.js (testable): machine-local stamps (_lsAt included —
            // echo-loop root fix, see module comment) and secret fields never travel in the patch.
            const patch = require('./settings-hot-sync').computeSettingsPatch(doc, prev)
            if (Object.keys(patch).length) {
              // P2 2026-09-11: hot-sync used to push only the main window — the float/quick-add windows
              // kept pre-CLI-change settings until restart (same all-windows pattern as the quit flush)
              for (const w of BrowserWindow.getAllWindows()) {
                try { if (w && !w.isDestroyed()) w.webContents.send('external-settings-changed', patch) } catch {}
              }
              log.info('[CLI] 设置变更热同步:', Object.keys(patch).join(','))
            }
          }
        }
      } catch (e) { log.warn('[CLI] 设置热同步失败', e) }
    }
    const kick = () => {
      clearTimeout(debounce)
      debounce = setTimeout(() => {
        try {
          // Round-3 stability (2026-09-26): a kick scheduled within the 150ms debounce just before
          // ext-watch-gate arms fires INSIDE the flush window — the un-gated forwardTomatoCmd could
          // consume a CLI command slot whose write lands after dbm.close() (same C11 loss class).
          if (!extWatchGate.canPoll()) return
          scheduler.reloadAll(dbApi())
          broadcastTodosChanged('external-db-write')
          // CLI 直写账本行(独立进程,db 层钩子在 CLI 进程内不挂)——外部写轮询是唯一跨进程通知点,
          // 必须同时广播账本重载,否则 CLI backfill/record rm 后界面账本保持旧副本(2026-09-04 实锤)
          broadcastTomatoRecordsChanged('external-db-write')
          // CLI pomodoro command channel: the CLI writes meta cliTomatoCmd → forwarded to the main window's renderer, which dispatches the existing
          // store/tomato actions (idempotency token/cross-window claim/ledger/project estimate all reused; the CLI never writes state in parallel)
          forwardTomatoCmd()
          log.info('[TodoDB] 检测到外部写入（CLI），已刷新调度器并通知渲染端')
          try { require('./lan-sync-bootstrap').kickSyncRound('external-db-write') } catch { /* sync lazy-not-init */ }
          // Resync the mtime baseline: reloadAll itself writes reminderLastSeenAt (touching -wal); without this
          // the next poll sees our own write as "another external write" → reload → write again = a self-sustaining loop
          lastMtime = readWatchMtime() ?? lastMtime
        } catch (e) { log.warn('[TodoDB] 外部写入刷新失败', e) }
      }, 150)
    }
    const onChange = () => {
      try {
        // C11 (2026-09-26): once the quit chain has started, a tick landing inside the 500ms-2s
        // flush window must do NOTHING — no dbm.call reads, no wc.send, no slot-delete commit.
        // stopDbWatch only runs at flushNow (after the flush window), so the poll is still live
        // here; without this gate a late tick could forward a CLI command to an already-flushed
        // renderer and consume the slot whose resulting write would land after dbm.close().
        if (!extWatchGate.canPoll()) return
        const m = readWatchMtime()
        if (m == null) return
        // Disarmed baseline (startup torn read): the first non-null read only ARMS the watcher —
        // it is a baseline, not a change, so it must not kick a spurious external-write reload.
        if (lastMtime == null) { lastMtime = m; forwardTomatoCmd(); forwardSyncCmd(); return }
        if (m === lastMtime) { forwardTomatoCmd(); forwardSyncCmd(); return } // check commands even when mtime is unchanged (guards against watchFile dropping events)
        lastMtime = m
        kick()
        forwardTomatoCmd()
        forwardSyncCmd()
      } catch {}
    }
    fs.watchFile(dbFile, { interval: 500 }, onChange)
    fs.watchFile(walFile, { interval: 500 }, onChange)
    // P1 2026-09-11: App's own todo-db:call writes touch the -wal too, but the 500ms-debounced kick above
    // only re-baselines for the EXTERNAL-write path. Our own IPC writes left the baseline stale → the next
    // poll read them as "external" → full reload + undo-stack wipe ~3s after every local write (the
    // renderer's 1.5s suppression window cannot cover the 2-3s watcher latency). Re-baseline immediately
    // after every write-type todo-db:call so the next poll sees mtime === baseline.
    resyncDbWatch = () => { lastMtime = nextWatchBaseline(lastMtime, readWatchMtime) }
    // P2 2026-09-11: fs.watchFile never unwatched — poll timers kept the quit chain alive/lint-y; release them on quit
    stopDbWatch = () => {
      // Round-3 stability (2026-09-26): a pending debounce kick survived the unwatch and fired against the closed DB handle. Clear it first.
      try { clearTimeout(debounce) } catch {}
      try { fs.unwatchFile(dbFile, onChange) } catch {}
      try { fs.unwatchFile(walFile, onChange) } catch {}
      resyncDbWatch = null
    }
  }
  return {
    watchDbForExternalWrites,
    // hctx shape parity: handlers previously got `() => resyncDbWatch` (null before the watcher starts)
    currentResyncDbWatch: () => resyncDbWatch,
    // lan-sync init hook (was: try { if (resyncDbWatch) resyncDbWatch() } catch {})
    resyncExternalWatch: () => { try { if (resyncDbWatch) resyncDbWatch() } catch { /* best-effort */ } },
    // quit chain hook (was: try { if (stopDbWatch) stopDbWatch() } catch {})
    stopForQuit: () => { try { if (stopDbWatch) stopDbWatch() } catch {} }
  }
}

module.exports = { createExternalDbWatch, seedTomatoWatermark, CLI_SLOT_ABANDON_TTL_MS }
