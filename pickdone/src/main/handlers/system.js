/** System/misc domain: notifications, external links, logs, export, diagnostics (pure relocation from index.js registerIpc). */
const fs = require('fs')
const path = require('path')
const log = require('electron-log')
const fixUtil = require('../fix-util')
const updater = require('../updater')
const { createExporter } = require('../export-xlsx')

module.exports = function systemHandlers (ctx) {
  const { isLocked, allowWithinRate, i18n, app } = ctx
  const { Notification, shell } = require('electron')
  const { exportTodosToXlsx } = createExporter({ getMainWindow: ctx.getMainWindow, i18n, log })
  const notificationSendTimes = [] // sliding window for the notification channel rate limit (10 per 10s)

  return {
    // --- Reminders ---
    'notification': (e, opt) => {
      // Locked-state gate, symmetric with upload-attachment/export/delete-file (2026-09-11 P1: this was
      // the only remaining data-bearing channel without it) + rate limit against notification spam
      if (isLocked()) throw new Error('locked')
      if (!allowWithinRate(notificationSendTimes, Date.now())) {
        log.warn('[IPC] notification 频控拦截, sender:', e.sender.id)
        return false
      }
      // Same sanitization as scheduler.fire: renderer-supplied title/body goes straight to system notifications; control characters/RTL override characters must be stripped
      // eslint-disable-next-line no-control-regex -- control characters are exactly the target of this sanitization; the rule does not apply here
      const clean = v => require('../sanitize').sanitizeText(v, 200)
      const n = new Notification({ title: clean(opt.title) || i18n.mt('notifyDefault'), body: clean(opt.body), silent: !!opt.silent })
      n.show(); return true
    },

    // --- External links ---
    'open-external-url': (e, url) => {
      if (!isSafeExternal(url)) return
      if (isSafeExternal(url)) shell.openExternal(url)
    },
    // [IPC dead channels cleaned] download-file/open-file-in-viewer/goto-main-window-and-select-todo/
    // show-todo-list/focus-main-window/open-settings-modal/user-logout/get-memory-metrics/
    // downloadUpdate/critical-state:*/app-initialization-completed/get-window-bounds etc. had no renderer callers and were deleted
    // The old checkForUpdates/quitAndInstall stubs were also removed: preload actually uses updater:check / updater:quit-and-install

    // --- Export ---
    'export-todos-to-xlsx': (e, payload) => { if (isLocked()) throw new Error('locked'); return exportTodosToXlsx(payload) },

    // --- Version-sync task set (offline no-op reserved channel) ---
    'sync-todos-to-server': () => ({ offline: true }),

    // --- Diagnostic logs (renderer logs to a separate file; export diagnostics bundle) ---
    'log:write': (e, entries) => {
      try {
        if (!Array.isArray(entries)) return false
        const rlog = require('electron-log')
        rlog.scope('renderer')
        // Write to a separate renderer.log (reuses electron-log's transports.file mechanism, scope isolated to a subdirectory)
        const fsx = require('fs')
        const dir = path.join(app.getPath('userData'), 'logs')
        fsx.mkdirSync(dir, { recursive: true })
        const file = path.join(dir, 'renderer.log')
        // Cap guard: a compromised renderer could write to disk without bound and fill the disk (dual limits on entry count/entry length; truncate when exceeded)
        const capped = entries.slice(0, 200)
        // 轮转:超 2MB 归档为 renderer.old.log(单副本)。无轮转时被攻陷渲染端可持续刷盘(2026-09-05 终审 P2)
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
              try { log.warn('[log:write] renderer.log 轮转改名失败,降级截断', rerr) } catch {}
              try { fsx.writeFileSync(file, '', 'utf8') } catch {}
            }
          }
        } catch { /* 首次写入文件尚不存在 */ }
        // 2026-09-10 P2:lines 是数组,此前 `lines + NL` 走 array+string 的 join(',') —— 含逗号条目被
        // 拆散、整批挤成一行。改为显式换行连接(纯逻辑抽到 fix-util.formatLogLines 便于测试)
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
    'updater:check': () => updater.check(),
    'updater:download': () => updater.downloadUpdate(),
    'updater:quit-and-install': () => updater.quitAndInstall(),
    'updater:status': () => updater.getStatus()
  }
}

/* ---------------- External-link safety: only http/https allowed ---------------- */
function isSafeExternal (url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url)
}
