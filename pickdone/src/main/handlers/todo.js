/** Todo/DB domain IPC handlers (pure relocation from index.js registerIpc). Each module exports (ctx) => ({ channel: fn }). */
const log = require('electron-log')
const dbm = require('../db')
const fixUtil = require('../fix-util')
const tomatoFloat = require('../tomato-float')
const scheduler = require('../scheduler')
const appAudit = require('../audit')
const { makeAssertMainWindow, purgeAttachmentFiles } = require('./shared')

module.exports = function todoHandlers (ctx) {
  const {
    isLocked, isLockWindow, getMainWindow,
    resyncDbWatch, broadcastTomatoRecordsChanged, broadcastTodosChanged, dbApi, attachDir
  } = ctx

  const assertMainWindow = makeAssertMainWindow(getMainWindow)

  // Whitelist of DB ops callable by the renderer: only reads + safe writes pass.
  // Unlike dbm.isWriteOp: this whitelist governs "callable from any renderer window", while isWriteOp governs "whether reloadAll/broadcast is triggered".
  // ⚠️ The whitelist must cover the renderer's real call surface: the cli/check-ipc-op-coverage.cjs gate statically cross-checks
  // (the full set of dbCall/dbCall?.( ops in the renderer ⊆ this list); two missed checks once silently broke features entirely (filterList/bumpSnow).
  // hardDelete is a dangerous write, but the renderer's recycle-bin "delete permanently" uses it for single items, so it stays on the whitelist;
  // purgeRecycleBin/purgeSeedTodos go through dedicated main-process channels below, not through this whitelist.
  const ALLOWED_RENDERER_OPS = new Set([
    'getById', 'getAll', 'queryTodos', 'getMeta', 'deleteMeta',
    'upsert', 'upsertMany', 'hardDelete', 'hardDeleteMany', 'setMeta',
    'getAllCategories', 'upsertCategory',
    // Filter CRUD (filterUpsert/filterDelete are user-level safe writes, same as upsertCategory) + count reads
    'filterList', 'filterUpsert', 'filterDelete', 'countAll', 'countSeedTodos',
    // Atomic accumulation of pomodoro focus minutes (a safe write preventing concurrent overwrites; missing it once silently lost pomodoro credit)
    'bumpSnow',
    // Plan-chip row storage (2026-09-03 root fix): read/write at atomic-operation granularity, single-field validation at the db layer, no whole-package overwrite surface
    'planAll', 'planAddMany', 'planUpdateChip', 'planRemoveIds',
    'planMoveTask', 'planDeleteTask', 'planDeleteTaskDay', 'planPrune',
    // 番茄账本行存储(2026-09-04 根修):主窗/浮窗/CLI 同表同 op,账本无整包覆盖面
    'tomatoAll', 'tomatoAppendMany', 'tomatoUpdateById', 'tomatoRemoveByIds', 'tomatoMigrateFromMeta'
  ])

  // Dangerous DB ops: batch write/batch delete/arbitrary meta write. Capability-wise aligned with "dangerous channels main-window only" —
  // a compromised float/lock-screen window could previously wipe the whole database in bulk or change any meta via todo-db:call (audit 2026-09-01).
  // The renderer's real call surface has been verified: all three only occur in the main window (store/utils/main.js); auxiliary windows have no legitimate callers.
  const MAIN_WINDOW_ONLY_OPS = new Set(['upsertMany', 'hardDeleteMany', 'setMeta', 'deleteMeta'])

  return {
    // --- DB ---
    'todo-db:call': (e, op, params) => {
      // While the security lock is active: only the lock-screen window may write (prevents the pomodoro float/injected windows from reading or writing data around the lock)
      if (isLocked() && !isLockWindow(e.sender)) {
        // 浮窗到点落番茄账是合法后台行为:锁屏期间放行浮窗自身的番茄追加类写(只挡读/危险写,威胁模型针对绕锁读写)
        let floatLedger = tomatoFloat.isSelfSender(e.sender) && /^(tomatoAppendMany|tomatoUpdateById|bumpSnow)$/.test(op) // bumpSnow=挂任务送专注积分,同属到点落账
        if (floatLedger && (op === 'tomatoUpdateById' || op === 'tomatoAppendMany')) {
          // 本地时区当天(dateKey 按本地 dayjs 导出,UTC 串会在 0-8 点误判跨天)
          const todayKey = fixUtil.localDayKey(Date.now())
          if (op === 'tomatoUpdateById') {
            // dateKey 由 endTime 强制导出(db 层),校验目标行当天即够;查不到的行让 db 层自己返回 false
            const cur = dbm.call('tomatoAll', {}).find(r => r && String(r.tomatoId) === String((params || {}).tomatoId))
            floatLedger = !!cur && cur.dateKey === todayKey
          } else {
            // tomatoAppendMany 同款收窄(2026-09-09 P2):此前批量追加无时间约束,被陷浮窗锁屏期可
            // 伪造任意历史日期的账本行;现要求所有行的 endTime 都落在本地当天
            const rows = Array.isArray(params) ? params : [params]
            floatLedger = rows.every(r => r && r.endTime && fixUtil.localDayKey(r.endTime) === todayKey)
          }
        }
        if (!floatLedger) throw new Error('app is locked')
      }
      // Write-op whitelist: callable by the renderer; other ops must go through main-process methods (prevents XSS injecting arbitrary ops)
      if (!ALLOWED_RENDERER_OPS.has(op)) {
        log.warn('[IPC] 拒绝渲染端 op:', op, 'from sender:', e.sender.id)
        throw new Error('DB op not allowed: ' + String(op))
      }
      if (MAIN_WINDOW_ONLY_OPS.has(op)) assertMainWindow(e)
      // Pre-write snapshot for upsert only (single indexed read): the audit trail needs the previous row to
      // tell done/undo/delete/restore/subtask apart. Must run BEFORE dbm.call overwrites the row; best-effort.
      let auditBefore = null
      if (op === 'upsert' && params && params.taskId != null) {
        try { auditBefore = dbm.call('getById', String(params.taskId)) } catch { /* null → coarse action */ }
      }
      // Renderer-originated ledger writes: suppress the db-layer hook broadcast (no sender info there)
      // and broadcast here with sender exclusion instead — otherwise the writing window's own
      // recordsReload echo could clobber in-flight state (2026-09-11 audit P2, todos-echo same shape)
      const isLedgerOp = dbm.LEDGER_WRITE_OPS.has(op)
      const unsuppress = isLedgerOp ? dbm.suppressLedgerHook() : null
      // finally is mandatory: if dbm.call throws (DB busy / constraint), a leaked suppression count
      // would silently mute ALL ledger broadcasts (incl. CLI writes) until process restart
      let r
      try {
        r = dbm.call(op, params)
      } finally {
        if (unsuppress) unsuppress()
      }
      if (unsuppress) broadcastTomatoRecordsChanged(op, e.sender)
      // Our own write just touched the DB/-wal: re-baseline the external-write watcher immediately,
      // otherwise the next poll mistakes our write for an external one (full reload + undo-stack wipe)
      if (dbm.isWriteOp(op)) { try { const rw = resyncDbWatch(); if (rw) rw() } catch { /* best-effort */ } }
      // App-side audit: renderer-initiated writes append to the same JSONL trail the CLI writes
      // (userData/cli-audit.jsonl). No double-logging: CLI write commands hit db.js directly inside the
      // CLI process and never pass through this IPC handler. The settings mirror blob (setMeta
      // db.settingsState, persisted debounced on every settings change) is skipped as noise.
      // Fire-and-forget: audit failures must never break the IPC path.
      try { appAudit.recordAppOp(op, params, { before: auditBefore, result: r }) } catch { /* best-effort */ }
      // Write-op determination lives in db.js's explicit WRITE_OPS list (do not fall back to regex: hardDeleteMany and others were once missed, leaving cross-window data stale)
      // setMeta writes only the meta table, not todos: skip reloadAll (settings/tomato/dayPlan mirrors are high-frequency writes; the previous full-reload path caused a reload storm); still broadcast so peer windows sync
      if (op === 'setMeta') { broadcastTodosChanged(op, e.sender); return r }
      if (dbm.isWriteOp(op)) {
        // Single-task writes (upsert/bumpSnow) reschedule only that task's timers via scheduleOne instead of a
        // full reloadAll (whole-table scan + all timers torn down and rebuilt on every write). Fall back to
        // reloadAll for bulk ops, when the row is gone, or when any reminder time is already past — scheduleOne
        // skips past times, while reloadAll owns the missed-reminder catch-up path (watermark + re-fire).
        const tid = (params || {}).taskId
        const t = (op === 'upsert' || op === 'bumpSnow') && tid != null ? dbm.call('getById', String(tid)) : null
        if (t && !scheduler.reminderInstances(t).some(([, ts]) => ts <= Date.now())) scheduler.scheduleOne(t)
        else scheduler.reloadAll(dbApi())
      }
      // 账本行写:调度器不依赖番茄记录;广播由 db 层 setLedgerChangedHook 统一发(CLI 直写同样触发),此处只跳过 todos 全量重载
      if (op === 'tomatoAppendMany' || op === 'tomatoUpdateById' || op === 'tomatoRemoveByIds' || op === 'tomatoMigrateFromMeta') return r
      if (dbm.isWriteOp(op)) broadcastTodosChanged(op, e.sender) // exclude the originating sender, so optimistic updates are not clobbered by the echo
      return r
    },

    // --- Dangerous purge: dedicated channels (bypassing the todo-db:call whitelist); only the main window may call (UI already double-confirms),
    //     float/quick-add/lock-screen and all other renderer windows are rejected ---
    'db:purge-recycle-bin': (e) => {
      assertMainWindow(e)
      if (isLocked()) throw new Error('locked')
      // Collect rows to delete and clean attachment files first (files before rows): deleting only rows once left private attachments on disk after "permanent wipe"
      let ids = []
      try {
        ids = dbm.call('queryTodos', { deleted: 1 }).map(t => t.taskId)
      } catch (err) { log.warn('[Purge] 收集回收站行失败，仅删行:', err) }
      const r = dbm.call('purgeRecycleBin')
      purgeAttachmentFiles(attachDir, ids)
      scheduler.reloadAll(dbApi()); broadcastTodosChanged('purgeRecycleBin', e.sender)
      return r
    },
    'db:purge-seed-todos': (e) => {
      assertMainWindow(e)
      if (isLocked()) throw new Error('locked')
      const r = dbm.call('purgeSeedTodos')
      // Symmetric with purge-recycle-bin: purging demo data also refreshes the scheduler + broadcasts (once missing → other windows kept stale seed records and scheduled reminders still fired)
      scheduler.reloadAll(dbApi()); broadcastTodosChanged('purgeSeedTodos', e.sender)
      return r
    }
  }
}
