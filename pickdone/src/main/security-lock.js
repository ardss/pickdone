/** Security lock (main process holds the locked state; the plaintext password never leaves the main process) — moved from index.js with dependency injection
 *  While locked, any path that would show the main window (tray/shortcut/second-instance/IPC) is redirected to focus the lock screen. */
const path = require('path')
const { BrowserWindow } = require('electron')

/** Pure decision for the lock window's render-process-gone self-heal (unit-testable, mirrors the
 *  main-window/tomato-float/quick-add crash self-heal family):
 *  - 'ignore'   : clean-exit / unknown reason (also fires on quit tearing renderers down) — do nothing
 *  - 'rebuild'  : rebuild the lock window (crash must not leave a white-screen lockWin while isLocked() stays true)
 *  - 'fallback' : rebuild cap exhausted → same disable-lock fallback as a failed load (availability beats lock) */
function crashSelfHealAction ({ reason, rebuilds, maxRebuilds = 3 } = {}) {
  if (!reason || reason === 'clean-exit') return 'ignore'
  if (rebuilds < maxRebuilds) return 'rebuild'
  return 'fallback'
}

/** Sliding-window rate limiter (pure, unit-testable). Guards the renderer-supplied 'notification'
 *  channel: a compromised/forked renderer could otherwise spam system notifications without bound.
 *  Mutates `timestamps` in place (oldest first). Returns true when the send is allowed. */
function allowWithinRate (timestamps, now, { limit = 10, windowMs = 10000 } = {}) {
  while (timestamps.length && now - timestamps[0] > windowMs) timestamps.shift()
  if (timestamps.length >= limit) return false
  timestamps.push(now)
  return true
}

function createSecurityLock ({ getMainWindow, showMainOrLock, readConfig, writeConfig, i18n, log }) {
  let lockWin = null
  let lockCrashRebuilds = 0 // rebuild counter since the last successful load; caps the crash→rebuild loop

  function isLocked () {
    try { return readConfig().enableSecurityLock === true && lockWin && !lockWin.isDestroyed() } catch { return false }
  }

  /** 锁屏窗加载失败回退(2026-09-09 P2):data: URL 加载失败此前被静默吞掉,lockWin 残留(空窗)而
   *  readConfig().enableSecurityLock 仍为 true → isLocked() 恒真,主窗永久隐藏、托盘只弹空锁窗,用户被锁死。
   *  回退:销毁锁窗 + 禁用锁 + 清空密码(下次启用必须重设),并把主窗放回来 —— 可用性优先于锁。 */
  function lockLoadFailedFallback (why) {
    log.error('[SecurityLock] 锁屏窗加载失败,回退到禁用锁+强制重设密码:', why)
    try { if (lockWin && !lockWin.isDestroyed()) lockWin.destroy() } catch { /* already gone */ }
    lockWin = null
    try {
      // 禁用锁并清掉口令/问题(原子写),verifyLockPassword 对空口令恒真,不会再锁死
      writeConfig({ enableSecurityLock: false, securityLockPassword: '', securityLockQuestion: '' })
    } catch (e) { log.error('[SecurityLock] 回退写配置失败', e) }
    try { showMainOrLock() } catch (e) { log.error('[SecurityLock] 回退显示主窗失败', e) }
  }

  function lockAppNow () {
    const win = getMainWindow()
    if (win) win.hide()
    // Broadcast the locked state to the renderer (ui.isLocked) — this was never sent before; the renderer's subscription was a dead channel
    if (win) win.webContents.send('security-lock-on')
    if (lockWin && !lockWin.isDestroyed()) { lockWin.focus(); return }
    lockWin = new BrowserWindow({
      width: 400, height: 260, frame: false, resizable: false, closable: false,
      alwaysOnTop: true, skipTaskbar: false,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true, nodeIntegration: false
      }
    })
    // i18n values are HTML-escaped before interpolation + the data: URL carries a CSP: although the lock screen only interpolates static copy,
    // the data: origin becomes an injection point the moment dynamic content sneaks in — escaping is the last line of defense
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
    const html = `<!doctype html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
    <style>
    body{margin:0;height:100vh;display:flex;flex-direction:column;justify-content:center;align-items:center;
      font-family:"Microsoft YaHei",system-ui,sans-serif;background:#1c2531;color:#e8eaed;gap:12px}
    .t{font-size:15px;letter-spacing:2px}
    input{width:220px;padding:8px 10px;border-radius:6px;border:1px solid #3a4150;background:#232b38;
      color:#e8eaed;font-size:14px;outline:none;text-align:center}
    input:focus{border-color:#0f9d8f}
    button{margin-top:4px;padding:7px 26px;border:0;border-radius:6px;background:#0f9d8f;color:#fff;
      font-size:14px;cursor:pointer}
    button:hover{filter:brightness(1.1)}
    .err{color:#f56c6c;font-size:12px;height:16px}
  </style></head><body>
    <div class="t">${esc(i18n.mt('lockTitle'))}</div>
    <input id="pw" type="password" placeholder="${esc(i18n.mt('lockPlaceholder'))}" autofocus>
    <div class="err" id="err"></div>
    <button id="go">${esc(i18n.mt('lockUnlock'))}</button>
    <script>
      const pw = document.getElementById('pw'), err = document.getElementById('err')
      async function tryUnlock () {
        err.textContent = ''
        const ok = await window.todoAPI.verifyLockPassword(pw.value)
        if (ok) { await window.todoAPI.unlockApp() } else { err.textContent = ${JSON.stringify(i18n.mt('lockWrongPassword'))} }
      }
      document.getElementById('go').onclick = tryUnlock
      pw.addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock() })
      pw.focus()
    </script>
  </body></html>`
    // 加载失败双保险:loadURL promise reject + did-fail-load 事件,任一触发都走禁用锁回退(幂等)
    let lockLoadFailed = false
    const onLockLoadFail = (why) => { if (lockLoadFailed) return; lockLoadFailed = true; lockLoadFailedFallback(why) }
    // Navigation lockdown (depth defense, 2026-09-11 security review): the lock page is a one-shot
    // data: URL — no navigation or popup may ever originate from it. The other three windows all have
    // guards; this one was the gap.
    lockWin.webContents.on('will-navigate', e => e.preventDefault())
    lockWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    lockWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(e => {
      const msg = (e && e.message) || ''
      if (/(-3|ERR_ABORTED|aborted)/i.test(msg)) return // benign interruption, see did-fail-load filter
      onLockLoadFail('loadURL: ' + msg)
    })
    // Only real main-frame failures may disable the lock: ERR_ABORTED (-3) is a benign interruption
    // (window destroyed / superseded mid-load, e.g. quit race) and must not wipe the user's password.
    // Signature: (event, errorCode, errorDescription, validatedURL, isMainFrame) — isMainFrame is the 5th.
    lockWin.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return
      onLockLoadFail('did-fail-load: ' + code + ' ' + desc)
    })
    lockWin.webContents.on('did-finish-load', () => { lockCrashRebuilds = 0 })
    // Renderer-crash self-heal (2026-09-11 P1): the main window (index.js:319), float (tomato-float.js:158)
    // and quick-add (quick-add.js:61) all self-heal a crashed renderer — the lock window was the only one
    // without it. A crashed lock renderer used to leave a white-screen lockWin with isLocked() stuck true
    // and the main window hidden forever. Rebuild the lock window (up to 3×); beyond the cap, take the same
    // disable-lock fallback as a failed load — availability beats the lock.
    lockWin.webContents.on('render-process-gone', (_e, details) => {
      const act = crashSelfHealAction({ reason: details && details.reason, rebuilds: lockCrashRebuilds })
      if (act === 'ignore') return
      log.error('[SecurityLock] 锁屏窗渲染进程崩溃:', details && details.reason, '→', act)
      try { if (lockWin && !lockWin.isDestroyed()) lockWin.destroy() } catch { /* already gone */ }
      lockWin = null
      if (act === 'rebuild') {
        lockCrashRebuilds++
        setTimeout(() => {
          try { lockAppNow() } catch (e) { log.error('[SecurityLock] 锁窗重建失败', e) }
        }, 300)
      } else {
        lockCrashRebuilds = 0
        lockLoadFailedFallback('lock window renderer crashed beyond rebuild cap')
      }
    })
    lockWin.on('closed', () => { lockWin = null })
  }

  function unlockAppNow () {
    if (lockWin && !lockWin.isDestroyed()) { try { lockWin.destroy() } catch {} }
    lockWin = null
    // Symmetric unlock broadcast: locking sends security-lock-on; unlocking also notifies the renderer to clear ui.isLocked (previously a one-way dead state)
    try {
      const w = getMainWindow()
      if (w && !w.isDestroyed()) w.webContents.send('security-lock-off')
    } catch (e) { /* main window gone */ }
    getMainWindow() // Ensure the main window exists (creation/focus side effects inside); showMainOrLock handles visibility
    showMainOrLock()
  }

  function verifyLockPassword (plain) {
    const c = readConfig()
    const stored = String(c.securityLockPassword || '')
    let expected = stored
    try {
      if (stored.startsWith('enc1:')) {
        const { safeStorage } = require('electron')
        expected = safeStorage.decryptString(Buffer.from(stored.slice(5), 'base64'))
      } else if (stored.startsWith('plain:')) {
        expected = stored.slice(6) // plaintext fallback when safeStorage is unavailable: unlocking must symmetrically strip the prefix (P0-3 fix)
      }
    // 解密失败按"无密码"放行(2026-09-10 P1):catch 后 expected 仍持有 'enc1:...' 密文串,
    // 下方 `if (!expected)` 不命中、比较恒 false → 用户被永久锁死(任何输入都解不开)。
    // 与本文件 avoid-permanent-lockout 哲学一致:可用性优先于锁,解密失败等同未设密码。
    } catch (e) { log.error('[SecurityLock] 解密失败', e); expected = '' }
    // When no password has ever been set, any input unlocks (avoid a permanent lockout)
    if (!expected) return true
    return String(plain) === expected
  }

  /** Verify the sender comes from the lock-screen window (anti-spoofing for the unlock-app IPC) */
  function isLockWindow (sender) {
    return !!(lockWin && !lockWin.isDestroyed() && sender === lockWin.webContents)
  }

  /** Bring the lock-screen window to the front while locked (used by the lock branch of showMainOrLock) */
  function focusLock () {
    if (lockWin && !lockWin.isDestroyed()) lockWin.focus()
  }

  return { isLocked, lockAppNow, unlockAppNow, verifyLockPassword, isLockWindow, focusLock }
}

module.exports = { createSecurityLock, crashSelfHealAction, allowWithinRate }
