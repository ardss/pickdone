/** Attachment/file domain IPC handlers (pure relocation from index.js registerIpc). */
const fs = require('fs')
const path = require('path')
const i18nM = require('../i18n')
const attachments = require('../attachments')
const { saveAttachment, attachmentPath, attachDir } = attachments

module.exports = function attachmentHandlers (ctx) {
  const { isLocked, isSafeExternal, getMainWindow, broadcastWhiteNoiseUpdated, notifySyncChange } = ctx
  const { dialog } = require('electron')
  // D6 P2 (2026-09-21): destructive attachment channels are main-window-only, same capability
  // class as the backup channels hardened for this exact threat (compromised aux window).
  const assertMainWindow = require('./shared').makeAssertMainWindow(getMainWindow)

  return {
    // --- Attachments (offline localization) ---
    // C12 (2026-09-25): this channel writes into the attachment store from a renderer-supplied
    // payload — same destructive-capability class as delete-file/delete-todo-files (:86/:98),
    // which already gate on assertMainWindow. An aux window (lock screen / float / quick-add)
    // used to be able to upload silently; aligned here.
    'upload-attachment': (e, payload) => { assertMainWindow(e); if (isLocked()) throw new Error('locked'); return saveAttachment(payload) },
    'open-file': async (e, url) => {
      // P2 2026-09-12 locked-state gate: this channel used to open/download even while locked —
      // asymmetric with upload/delete/notification, so a locked app still exfiltrated attachments
      const { shell } = require('electron')
      if (isLocked()) throw new Error('locked')
      if (typeof url !== 'string') return false // F2 2026-09-15: 非字符串 url 此前在 startsWith 处 TypeError;与 save-upload-file-to-download 守卫同款
      if (url.startsWith('local://')) {
        const p = attachmentPath(url.slice(8))
        // Missing-file guard (feature: LAN-synced attachments): the metadata row may arrive
        // before the file is pulled over. Structured result -> renderer toasts "not yet
        // synced" instead of a raw open failure. P1-8 (2026-09-19 UX review): the missing key
        // also kicks a best-effort immediate sync round, so the targeted pull runs now instead
        // of waiting up to ROUND_INTERVAL_MS for the next periodic round.
        if (!fs.existsSync(p)) {
          try { if (notifySyncChange) notifySyncChange('attachment-missing-open') } catch { /* sync lazy-not-init */ }
          return { missing: true, name: path.basename(p) }
        }
        // Fault-7 (D12 2026-10-01): shell.openPath resolves with an ERROR STRING ('' = success) —
        // the old fire-and-forget `shell.openPath(p); return true` discarded it and claimed
        // success even when the OS refused the open (no association / blocked file / removed
        // drive). Await the resolution: success keeps the boolean `true`, failure returns a
        // structured { ok:false, error } (mirrors the missing-file shape the renderer already
        // branches on); a rejected promise maps to the same shape instead of a raw IPC error.
        try {
          const openErr = await shell.openPath(p)
          if (openErr) return { ok: false, error: String(openErr), name: path.basename(p) }
          return true
        } catch (err) {
          return { ok: false, error: String((err && err.message) || err), name: path.basename(p) }
        }
      }
      if (isSafeExternal(url)) return shell.openExternal(url)
      return false
    },
    // r3 dead-channel removal (2026-09-28): 'download-file-and-open' and
    // 'save-upload-file-to-download' deleted — todoAPI.downloadAndOpen/saveToDownloads had
    // zero renderer callers (open-file serves the live attachment path).
    'delete-file': (e, url) => {
      assertMainWindow(e) // D6 P2 (2026-09-21): destructive channel, main-window-only like backup write
      if (isLocked()) throw new Error('locked')
      if (typeof url !== 'string') return false // F2 2026-09-15: 同 open-file/download-file 的 typeof 守卫(此前 startsWith TypeError)
      // C6 (2026-09-25): a non-local:// url used to fall through to `return true` — the caller
      // was told "deleted" while nothing was (and could never be) deleted. open-file /
      // download-file-and-open already answer false for unknown schemes; same honesty here.
      if (!url.startsWith('local://')) return false
      const key = url.slice(8)
      try { fs.unlinkSync(attachmentPath(key)) } catch (err) {
        // Already-gone is success (idempotent delete); anything else is a real failure
        if ((err && err.code) !== 'ENOENT') throw new Error('delete-file failed: ' + String((err && err.message) || err))
      }
      // LAN conflict alias cleanup: when the deleted file was the `name-1` conflict-rename
      // target (aliased from the row's original local://key), drop the alias too — otherwise
      // the stale entry keeps resolving the dead key to the now-missing renamed file and the
      // missing-file guard can never re-pull the original key.
      try { require('../attachments').deleteAlias(key) } catch { /* best-effort */ }
      return true
    },
    'delete-todo-files': (e, taskId) => {
      assertMainWindow(e) // D6 P2 (2026-09-21): destructive channel, main-window-only like backup write
      if (isLocked()) throw new Error('locked')
      const dir = attachDir()
      const { ownsAttachmentFile } = require('./shared')
      const failures = []
      for (const f of fs.readdirSync(dir)) {
        // P2 2026-09-17: exact ownership via the timestamp segment — a bare taskId+'_' prefix let
        // task 'a' delete task 'a_b''s attachments when the ids were prefix-related
        if (!ownsAttachmentFile(f, String(taskId))) continue
        try { fs.unlinkSync(path.join(dir, f)) } catch (err) { if ((err && err.code) !== 'ENOENT') failures.push(f + ': ' + String((err && err.message) || err)) }
      }
      if (failures.length) throw new Error('delete-todo-files failed: ' + failures.join('; '))
      // Lifecycle (2026-10-02): the bulk unlink must also drop alias-map entries whose target
      // file just died (same cleanup the single delete-file path does per key) — a stale entry
      // keeps resolving the dead key to a missing file and blocks the missing-file re-pull.
      try { attachments.pruneMissingAliases() } catch { /* best-effort */ }
      return true
    },
    // Custom white noise: copied into userData/files right after picking (reachable via the local:// protocol with Range support, so it can actually play during focus;
    // the old version returned only an absolute path, which the app:// page could not load → picking was equivalent to not picking). Fixed-name overwrite; the directory keeps only the latest file.
    'select-user-white-noise-audio-file': async (e) => {
      // D7 (2026-09-22, main-ipc-6): main-window + locked-state gates — this channel popped a native
      // file dialog and copied the picked file into attachDir with NEITHER gate, asymmetric with
      // upload-attachment/open-file/delete-file in the same module. The dialog needs human
      // interaction, but gating consistency is the point (D6 hardening follow-up).
      assertMainWindow(e)
      if (isLocked()) throw new Error('locked')
      // win 模块级引用在主窗销毁重建后可能是 null/已销毁:dialog 收到死引用会抛,改 getMainWindow 守卫,
      // 无窗时传 undefined(dialog 以无父窗模式打开,2026-09-09 P2)
      const r = await dialog.showOpenDialog(getMainWindow() || undefined, { properties: ['openFile'], filters: [{ name: i18nM.mt('pickAudio'), extensions: ['mp3', 'wav', 'ogg'] }] })
      if (r.canceled || !r.filePaths[0]) return null
      const src = r.filePaths[0]
      // C5 (2026-09-25): this entry used to copy the picked file into the attachment dir with
      // NO size or quota gate (only upload-attachment had them) — a picked 2GB "audio" file
      // landed on disk unchecked and, before C14, also starved every attachment upload. The
      // stat happens BEFORE the copy: an over-size source is refused with nothing on disk.
      // Caps are the shared ones (attachments-guards.assertWriteAllowed, 50MB/file + 64MB
      // quota, single source with saveAttachment).
      require('../attachments-guards').assertWhiteNoiseCopyAllowed(src, attachments.attachDir())
      const ext = path.extname(src).toLowerCase()
      const key = 'noise-custom' + ext
      await fs.promises.copyFile(src, path.join(attachments.attachDir(), key))
      // 2026-09-10 P2:保存自定义白噪音后广播所有存活窗(渲染端另一代理会加监听,通道名固定);
      // 此前只更新发起窗的本地状态,其他窗(如浮窗)的噪音列表不刷新
      broadcastWhiteNoiseUpdated()
      return { name: path.basename(src), key }
    },
    // r3 dead-channel removal (2026-09-28): 'mime-get-type' deleted — todoAPI.mimeByType had
    // zero renderer callers; protocol.attachmentMimeFor stays the single mime table.
  }
}
