/** System/misc domain: notifications, external links, logs, export, diagnostics (pure relocation from index.js registerIpc). */
const fs = require('fs')
const path = require('path')
const log = require('electron-log')
require('../log-isolation') // test isolation: redirect electron-log file transport into TODO_DB_DIR/TODO_USER_DATA_DIR
const fixUtil = require('../fix-util')
const updater = require('../updater')
const { createExporter } = require('../export-xlsx')

module.exports = function systemHandlers (ctx) {
  // P3 (dw wave5 2026-09-24): isSafeExternal now comes from the injected ctx (index.js:788) —
  // this module used to carry a private verbatim copy, so any drift would have split the
  // external-link safety criterion between the two files. Same pattern as isLocked above.
  const { isLocked, allowWithinRate, i18n, app, getMainWindow, isSafeExternal } = ctx
  const { Notification, shell } = require('electron')
  // D6 P2 (2026-09-21): updater channels are main-window-only — the check/download/quit-and-install
  // triple used to be callable from ANY renderer window even while locked.
  const { makeAssertMainWindow } = require('./shared')
  const assertMainWindow = makeAssertMainWindow(getMainWindow)
  const { exportTodosToXlsx } = createExporter({ getMainWindow: ctx.getMainWindow, i18n, log })
  // C6 (P3 2026-10-02): the notification rate limiter used to be ONE process-global sliding window —
  // a chatty auxiliary window consumed the whole 10/10s budget and starved the main window's real
  // reminders. Budgets are now PER SENDER (webContents id): every window gets its own 10/10s budget,
  // so one noisy window can only silence itself. Sender maps are bounded: entries are dropped as soon
  // as their window drains, with a size-based sweep for dead senders that never call again.
  // C7 (P3 2026-10-02): log:write gets the same per-sender gating class, sized generously
  // (120 calls / 10s ≈ 12 batches/s sustained) so legitimate renderer logging never trips it —
  // only an unbounded spam loop does. The gate sits BEFORE any mkdir/stat/append work.
  const senderRateBuckets = new Map() // sender id -> timestamps[] (oldest first)
  function allowWithinRatePerSender (e, opts) {
    const id = (e && e.sender && e.sender.id != null) ? String(e.sender.id) : 'unknown'
    let stamps = senderRateBuckets.get(id)
    if (!stamps) { stamps = []; senderRateBuckets.set(id, stamps) }
    const ok = allowWithinRate(stamps, Date.now(), opts)
    if (!stamps.length) senderRateBuckets.delete(id) // drained window: drop the map entry immediately
    if (senderRateBuckets.size > 64) {
      // Sweep dead senders whose newest stamp is older than the largest window we use here (10s)
      const now = Date.now()
      for (const [k, v] of senderRateBuckets) {
        if (!v.length || now - v[v.length - 1] > 10000) senderRateBuckets.delete(k)
      }
    }
    return ok
  }
  const NOTIFICATION_RATE = { limit: 10, windowMs: 10000 }
  const LOG_WRITE_RATE = { limit: 120, windowMs: 10000 }

  return {
    // --- Reminders ---
    'notification': (e, opt) => {
      // Locked-state gate, symmetric with upload-attachment/export/delete-file (2026-09-11 P1: this was
      // the only remaining data-bearing channel without it) + rate limit against notification spam
      if (isLocked()) throw new Error('locked')
      // F2 2026-09-15 shape guard: with opt undefined/non-object, `opt.title` used to throw a bare TypeError (IPC invoke reject);
      // missing title falls back to an i18n-safe default, non-string fields are sanitized to empty strings — the notification channel never crashes on bad input.
      const o = (opt && typeof opt === 'object') ? opt : {}
      if (!allowWithinRatePerSender(e, NOTIFICATION_RATE)) {
        log.warn('[IPC] notification rate-capped, sender:', e.sender.id)
        return false
      }
      // Same sanitization as scheduler.fire: renderer-supplied title/body goes straight to system notifications; control characters/RTL override characters must be stripped
      // eslint-disable-next-line no-control-regex -- control characters are exactly the target of this sanitization; the rule does not apply here
      const clean = v => require('../sanitize').sanitizeText(v, 200)
      const n = new Notification({ title: clean(typeof o.title === 'string' ? o.title : '') || i18n.mt('notifyDefault'), body: clean(typeof o.body === 'string' ? o.body : ''), silent: !!o.silent, ...require('../scheduler').notifyTimeoutOptsForApp() }) // B4: honor notificationTimeoutInterval on every notification channel
      // D22 (P3): an OS-level delivery failure (missing AppUserModelID registration, toast
      // server refusal, ...) used to surface as an UNHANDLED 'failed' event on the Notification
      // object — under Electron's unhandled-event policy that can crash the main process.
      // Attach the listener BEFORE show(); the failure is logged, never thrown.
      if (typeof n.on === 'function') n.on('failed', (err) => { try { log.error('[IPC] notification delivery failed:', err && (err.message || err)) } catch { /* logging is best-effort */ } })
      n.show(); return true
    },

    // --- External links ---
    'open-external-url': async (e, url) => {
      // D7 (2026-09-22, main-ipc-5): locked-state gate — this was the last data-plane channel in the
      // family without it (notification/open-file/download/save-upload all gate). While locked, any
      // surviving renderer window could still launch the browser at an arbitrary https URL (fishing
      // redirect / external-protocol handler trigger). Symmetric throw, not a silent return.
      if (isLocked()) throw new Error('locked')
      // D10 (2026-09-27): honest result. The handler returned undefined on EVERY path — for an
      // unsafe scheme it silently did nothing with a success-shaped undefined return, so the
      // renderer could not distinguish "opened" from "rejected by the scheme guard". Symmetric
      // throw (like the isLocked guard above) + explicit true on the open path.
      if (!isSafeExternal(url)) throw new Error('unsafe external url')
      // M2 P3 (2026-10-09, D11 precedent — handlers/attachments.js openExternalSafely): the open
      // used to be fire-and-forget — a rejected shell.openExternal became an UNHANDLED REJECTION
      // in the main process while the channel still reported success. Await and surface the
      // failure honestly ({ok:false,error}); ipcRenderer.invoke is promise-based, so the async
      // handler shape is transparent to the renderer.
      try { await shell.openExternal(url); return true }
      catch (err) { return { ok: false, error: String((err && err.message) || err) } }
    },
    // [IPC dead channels cleaned] download-file/open-file-in-viewer/goto-main-window-and-select-todo/
    // show-todo-list/focus-main-window/open-settings-modal/user-logout/get-memory-metrics/
    // downloadUpdate/critical-state:*/app-initialization-completed/get-window-bounds etc. had no renderer callers and were deleted
    // The old checkForUpdates/quitAndInstall stubs were also removed: preload actually uses updater:check / updater:quit-and-install

    // --- Export ---
    // D6 P2 (2026-09-22): main-window gate added — the channel pops a native save dialog and
    // writes a file, so an auxiliary window (compromised float/quick-add) could pop save dialogs
    // and drop arbitrary xlsx files. Symmetric with the updater/critical-state siblings above.
    'export-todos-to-xlsx': (e, payload) => { assertMainWindow(e); if (isLocked()) throw new Error('locked'); return exportTodosToXlsx(payload) },

    // r3 dead-channel removal (2026-09-28): 'sync-todos-to-server' (offline no-op) deleted —
    // todoAPI.syncNow had zero renderer callers (SideNav sync goes through vuex, not IPC).
    // --- Diagnostic logs (renderer logs to a separate file; export diagnostics bundle) ---
    'log:write': (e, entries) => {
      try {
        if (!Array.isArray(entries)) return false
        // C7 (2026-10-02): per-sender rate gate BEFORE any disk work — the old handler ran
        // mkdirSync + statSync + appendFileSync on EVERY call with no gate at all, so a runaway
        // renderer could hammer the disk at IPC frequency (up to 200×4000 chars per call).
        // Sized generously (see LOG_WRITE_RATE above) so legitimate logging never trips it.
        if (!allowWithinRatePerSender(e, LOG_WRITE_RATE)) {
          log.warn('[IPC] log:write rate-capped, sender:', e && e.sender && e.sender.id)
          return false
        }
        // D13 C14 (2026-10-01): a dead `electron-log` require + `rlog.scope('renderer')` call used
        // to sit here — the scope object was created and discarded, the actual write below goes to
        // renderer.log via fs directly. Removed (no behavior change).
        // Write to a separate renderer.log (reuses electron-log's transports.file mechanism, scope isolated to a subdirectory)
        const fsx = require('fs')
        const dir = path.join(app.getPath('userData'), 'logs')
        fsx.mkdirSync(dir, { recursive: true })
        const file = path.join(dir, 'renderer.log')
        // Cap guard: a compromised renderer could write to disk without bound and fill the disk (dual limits on entry count/entry length; truncate when exceeded)
        const capped = entries.slice(0, 200)
        // Rotation: over 2MB archives to renderer.old.log (single copy). Without rotation a compromised renderer could keep flushing to disk (2026-09-05 final-review P2).
        try {
          const st = fsx.statSync(file)
          if (st.size > 2 * 1024 * 1024) {
            const old = path.join(dir, 'renderer.old.log')
            try { fsx.rmSync(old, { force: true }) } catch {}
            // P2 2026-09-12: renameSync can fail on Windows (renderer.old.log held open by an editor/
            // AV scanner). The old code let that throw into the outer catch → append was skipped →
            // the file grew past 2MB forever (cap semantics lost). Degrade to truncating the current
            // file instead: we lose the archived copy once but keep the hard 2MB bound.
            try {
              fsx.renameSync(file, old)
            } catch (rerr) {
              try { log.warn('[log:write] renderer.log rotation rename failed, degrading to truncate', rerr) } catch {}
              try { fsx.writeFileSync(file, '', 'utf8') } catch {}
            }
          }
        } catch { /* first write: file does not exist yet */ }
        // 2026-09-10 P2: lines is an array; the old `lines + NL` went through array+string join(',')
        // — comma-containing entries got split and squeezed onto one line. Now joined with explicit newlines (pure logic extracted to fixUtil.formatLogLines for testability).
        fsx.appendFileSync(file, fixUtil.formatLogLines(capped) + String.fromCharCode(10), 'utf8')
        return true
      } catch (err) { console.error('[log:write]', err); return false }
    },
    'log:open-dir': () => {
      try {
        const dir = path.join(app.getPath('userData'), 'logs')
        fs.mkdirSync(dir, { recursive: true })
        shell.openPath(dir)
        return true
      } catch (err) { console.error('[log:open-dir]', err); return false }
    },

    // --- Auto-update ---
    // D6 P2 (2026-09-21): main-window + locked-state gates on all three mutating updater channels
    // (status stays readable — it leaks nothing and the settings page polls it from the main window only anyway).
    'updater:check': (e) => { assertMainWindow(e); if (isLocked()) throw new Error('locked'); return updater.check() },
    'updater:download': (e) => { assertMainWindow(e); if (isLocked()) throw new Error('locked'); return updater.downloadUpdate() },
    // F4 (2026-10-21): the install-quit path used to bypass the tray-quit confirmation — a running
    // pomodoro died silently when the user clicked "restart to update" (quitAndInstall skips the
    // whole quit chain's confirm gates). Reuse the tray confirm (index.js quitFromTrayInner):
    // ask via the SAME durable-session gate + i18n copy; cancel returns false so the settings UI
    // sees "not installed" instead of a silent success.
    'updater:quit-and-install': async (e) => {
      assertMainWindow(e); if (isLocked()) throw new Error('locked')
      try {
        const sessionLive = ctx.tomatoSession ? ctx.tomatoSession.hasRunningSession() : false
        if (sessionLive) {
          const { response } = await require('electron').dialog.showMessageBox({
            type: 'question',
            title: i18n.mt('quitFocusActiveTitle'),
            message: i18n.mt('quitFocusActiveTitle'),
            detail: i18n.mt('quitFocusActiveMsg'),
            buttons: [i18n.mt('quitFocusQuit'), i18n.mt('quitFocusCancel')],
            cancelId: 1, defaultId: 1, noLink: true,
          })
          if (response !== 0) return false // user kept the pomodoro: no install
        }
      } catch (err) {
        // Symmetric with index.js quitFromTrayInner: a failed confirm dialog must carry cancel
        // semantics — never tear down a live pomodoro because the dialog could not open.
        log.warn('[IPC] quit-and-install confirm dialog failed, aborting install-quit', err)
        return false
      }
      return updater.quitAndInstall()
    },
    'updater:status': () => updater.getStatus(),

    // --- Data storage location (F-RELOC: configurable userData + safe migration) ---
    // Read-only info for the settings page: current dir, boot-redirect state, free bytes.
    'data:location-info': (e) => {
      assertMainWindow(e)
      const dl = require('../data-location.cjs')
      const ud = app.getPath('userData')
      return { currentDir: ud, bootRedirect: dl.readBootRedirect(), freeBytes: dl.volumeFreeBytes(ud) }
    },
    // Migration: {targetDir} optional — when absent the main process pops the native directory
    // picker (same pattern as pick-backup-dir). Pipeline: validate → i18n confirm dialog →
    // close the DB (better-sqlite3 close checkpoints TRUNCATEs the WAL, so the source files are
    // static for the copy) → data-location.migrateData → relaunch. On ANY failure the DB is
    // re-inited against the UNTOUCHED source dir so the app keeps running on the old location.
    'data:relocate': async (e, payload) => {
      assertMainWindow(e); if (isLocked()) throw new Error('locked')
      const dl = require('../data-location.cjs')
      const { dialog } = require('electron')
      const ud = app.getPath('userData')
      const o = (payload && typeof payload === 'object') ? payload : {}
      let targetDir = typeof o.targetDir === 'string' ? o.targetDir : ''
      if (!targetDir) {
        const r = await dialog.showOpenDialog(getMainWindow() || undefined, { title: i18n.mt('dataLocPickTitle'), properties: ['openDirectory', 'createDirectory'] })
        if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true }
        targetDir = r.filePaths[0]
      }
      const v = dl.validateTarget(targetDir, ud)
      if (!v.ok) return { ok: false, error: v.reason }
      // Confirm AFTER validation so the dialog only ever describes a feasible migration; the
      // copy discloses the moved surfaces + the source-is-preserved rollback guarantee.
      try {
        const { response } = await dialog.showMessageBox({
          type: 'question',
          title: i18n.mt('dataLocConfirmTitle'),
          message: i18n.mt('dataLocConfirmTitle'),
          detail: i18n.mt('dataLocConfirmMsg', { d: targetDir }),
          buttons: [i18n.mt('dataLocConfirmBtn'), i18n.mt('quitFocusCancel')],
          cancelId: 1, defaultId: 0, noLink: true,
        })
        if (response !== 0) return { ok: false, canceled: true }
      } catch (err) {
        // A failed confirm dialog must carry cancel semantics (same rule as updater:quit-and-install):
        // never tear down a live DB handle because the dialog could not open.
        log.warn('[IPC] data:relocate confirm dialog failed, aborting migration', err)
        return { ok: false, canceled: true }
      }
      // Close the DB before the copy. Best-effort scheduler flush first (reminder dedupe ledger),
      // then close; a close failure aborts BEFORE any file was touched — nothing to roll back.
      try {
        try { if (ctx.scheduler && ctx.scheduler.flushFiredNow) ctx.scheduler.flushFiredNow() } catch { /* best-effort */ }
        if (ctx.dbm && ctx.dbm.close) ctx.dbm.close()
      } catch (err) {
        const msg = String((err && err.message) || err)
        try { if (ctx.dbm && ctx.dbm.init) ctx.dbm.init(ud) } catch { /* re-init is best-effort; close() already swallowed real errors */ }
        return { ok: false, error: i18n.mt('dataLocCloseFailed', { msg }) }
      }
      const r = dl.migrateData(ud, targetDir)
      if (!r.ok) {
        // Source untouched by contract (data-location.cjs never deletes/modifies the source) —
        // re-init on the old dir restores the running state and the user gets an honest error.
        try { if (ctx.dbm && ctx.dbm.init) ctx.dbm.init(ud) } catch (e2) { log.error('[IPC] data:relocate re-init after failed migration also failed', e2) }
        log.error('[IPC] data:relocate migration failed:', r.error)
        return { ok: false, error: r.error }
      }
      log.info('[IPC] data:relocate migrated to', r.target, '— relaunching')
      // Success: inform (best-effort — the process is about to exit), then relaunch into the
      // new location via the boot file written by migrateData. exit() skips the quit-flush chain,
      // which is correct here: the DB handle is already closed and the source dir is intact.
      try { dialog.showMessageBox({ type: 'info', title: i18n.mt('dataLocDoneTitle'), message: i18n.mt('dataLocDoneMsg') }).catch(() => {}) } catch { /* best-effort */ }
      setTimeout(() => { try { app.relaunch(); app.exit(0) } catch { /* dying anyway */ } }, 400)
      return { ok: true, target: r.target }
    }
  }
}
