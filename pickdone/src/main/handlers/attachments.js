/** Attachment/file domain IPC handlers (pure relocation from index.js registerIpc). */
const fs = require('fs')
const path = require('path')
const i18nM = require('../i18n')
const fixUtil = require('../fix-util')
const attachments = require('../attachments')
const { saveAttachment, attachmentPath, attachDir } = attachments

module.exports = function attachmentHandlers (ctx) {
  const { isLocked, isSafeExternal, app, getMainWindow, broadcastWhiteNoiseUpdated } = ctx
  const { dialog } = require('electron')

  return {
    // --- Attachments (offline localization) ---
    'upload-attachment': (e, payload) => { if (isLocked()) throw new Error('locked'); return saveAttachment(payload) },
    'open-file': async (e, url) => {
      const { shell } = require('electron')
      if (url.startsWith('local://')) { shell.openPath(attachmentPath(url.slice(8))); return true }
      if (isSafeExternal(url)) return shell.openExternal(url)
      return false
    },
    'download-file-and-open': (e, url) => { const { shell } = require('electron'); if (url.startsWith('local://')) { shell.openPath(attachmentPath(url.slice(8))); return true } if (isSafeExternal(url)) shell.openExternal(url); return true },
    'save-upload-file-to-download': (e, url, targetName) => {
      // Security check: force basename on the target name and strip path segments, preventing path traversal writes to arbitrary locations
      const rawName = String(targetName || '').replace(/[/]/g, '_')
      if (/^\.+$/.test(rawName)) throw new Error('bad target name')
      const safeName = path.basename(rawName) || path.basename(attachmentPath(url.slice(8)))
      // 同名不静默覆盖(2026-09-10 P2):copyFileSync 直接覆盖用户已有的同名下载;改为 " (n)" 后缀,
      // 并包 try 返回结构化错误(磁盘满/权限等此前抛裸异常,渲染端只能拿到笼统 invoke reject)
      if (url.startsWith('local://')) {
        try {
          const src = attachmentPath(url.slice(8))
          const dst = fixUtil.nextAvailableName(app.getPath('downloads'), safeName, p => fs.existsSync(p))
          fs.copyFileSync(src, dst)
          return dst
        } catch (err) {
          throw new Error('save-to-download failed: ' + String((err && err.message) || err))
        }
      }
      return null
    },
    // P2 2026-09-11: deletion failures used to be swallowed and true returned regardless — the user was
    // told the attachment was gone while the file stayed on disk. Throw a structured error instead (the
    // renderer's existing invoke catch/reportError displays it); no renderer caller changes needed.
    'delete-file': (e, url) => {
      if (isLocked()) throw new Error('locked')
      if (url.startsWith('local://')) {
        try { fs.unlinkSync(attachmentPath(url.slice(8))) } catch (err) {
          // Already-gone is success (idempotent delete); anything else is a real failure
          if ((err && err.code) !== 'ENOENT') throw new Error('delete-file failed: ' + String((err && err.message) || err))
        }
      }
      return true
    },
    'delete-todo-files': (e, taskId) => {
      if (isLocked()) throw new Error('locked')
      const dir = attachDir()
      const failures = []
      for (const f of fs.readdirSync(dir)) {
        if (!f.startsWith(taskId + '_')) continue
        try { fs.unlinkSync(path.join(dir, f)) } catch (err) { if ((err && err.code) !== 'ENOENT') failures.push(f + ': ' + String((err && err.message) || err)) }
      }
      if (failures.length) throw new Error('delete-todo-files failed: ' + failures.join('; '))
      return true
    },
    // Custom white noise: copied into userData/files right after picking (reachable via the local:// protocol with Range support, so it can actually play during focus;
    // the old version returned only an absolute path, which the app:// page could not load → picking was equivalent to not picking). Fixed-name overwrite; the directory keeps only the latest file.
    'select-user-white-noise-audio-file': async () => {
      // win 模块级引用在主窗销毁重建后可能是 null/已销毁:dialog 收到死引用会抛,改 getMainWindow 守卫,
      // 无窗时传 undefined(dialog 以无父窗模式打开,2026-09-09 P2)
      const r = await dialog.showOpenDialog(getMainWindow() || undefined, { properties: ['openFile'], filters: [{ name: i18nM.mt('pickAudio'), extensions: ['mp3', 'wav', 'ogg'] }] })
      if (r.canceled || !r.filePaths[0]) return null
      const src = r.filePaths[0]
      const ext = path.extname(src).toLowerCase()
      const key = 'noise-custom' + ext
      await fs.promises.copyFile(src, path.join(attachments.attachDir(), key))
      // 2026-09-10 P2:保存自定义白噪音后广播所有存活窗(渲染端另一代理会加监听,通道名固定);
      // 此前只更新发起窗的本地状态,其他窗(如浮窗)的噪音列表不刷新
      broadcastWhiteNoiseUpdated()
      return { name: path.basename(src), key }
    },
    // --- Misc ---
    'mime-get-type': (e, name) => {
      const ext = String(name).split('.').pop().toLowerCase()
      const t = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', mp3: 'audio/mpeg', ogg: 'audio/ogg' }
      return t[ext] || 'application/octet-stream'
    }
  }
}
