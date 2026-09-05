/**
 * Renderer-side unified logging — buffered + throttled reporting to the main process, written to userData/logs/renderer.log
 * Three error sources funnel in automatically:
 *   1. window.onerror (uncaught synchronous errors)
 *   2. window.addEventListener('unhandledrejection') (unhandled Promise rejections)
 *   3. app.config.errorHandler (Vue render/watcher errors)
 * On the main-process side, the 'log:write' handler writes to userData/logs/renderer.log.
 * Settings → Data Management → "Export diagnostic logs" bundles main.log + renderer.log + environment info.
 */
const BUFFER = []
let flushTimer = null

function flush () {
  if (!BUFFER.length) return
  const entries = BUFFER.splice(0)
  try {
    sendToMain(entries)
  } catch (e) { /* silent */ }
}

function enqueue (level, msg, stack) {
  BUFFER.push({ ts: new Date().toISOString(), level, msg: String(msg || '').slice(0, 500), stack: stack ? String(stack).slice(0, 2000) : '' })
  if (BUFFER.length >= 20) flush()
  else if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; flush() }, 2000)
}

export const logger = {
  info: (msg) => { enqueue('info', msg); try { console.log('[info]', msg) } catch (e) { /* empty */ } },
  warn: (msg) => { enqueue('warn', msg); try { console.warn('[warn]', msg) } catch (e) { /* empty */ } },
  error: (msg, stack) => {
    enqueue('error', msg, stack)
    try { console.error('[error]', msg, stack || '') } catch (e) { /* empty */ }
  },
  flush
}

/** Install global error capture (called once during main.js initialization) */
export function installGlobalErrorCapture () {
  window.addEventListener('error', e => {
    const msg = e.message || 'unknown error'
    const stack = (e.error && e.error.stack) || ''
    logger.error(msg + (stack ? '\n' + stack.slice(0, 800) : ''))
  })
  window.addEventListener('unhandledrejection', e => {
    const reason = e.reason
    logger.error('unhandledrejection: ' + ((reason && (reason.stack || reason.message)) || String(reason)))
  })
}

// todoAPI bridge (ipcRenderer.invoke proxy exposed by preload); also works in the shim environment
function sendToMain (entries) {
  try {
    if (window.todoAPI && typeof window.todoAPI.logWrite === 'function') return window.todoAPI.logWrite(entries)
  } catch (e) { /* silent */ }
  return Promise.resolve(false)
}
