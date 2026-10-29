/** T7 win-bind adapter — resident PowerShell window-probe child (JS lifecycle side).
 *
 *  createWinAdapter(deps) → { prewarm, probeUnderCursor, enumerate, activateHwnd, dispose }.
 *  The IPC domain depends ONLY on this interface (unit tests inject fakes; live-PS cases are
 *  guarded on win32 in a separate test file).
 *
 *  Lifecycle hard rules (repo lessons applied):
 *   - the spawned child MUST carry 'error' AND 'exit' listeners (D13 C4 lesson,
 *     notify-sound.js:45-47: an un-listened 'error' crashed the main process);
 *   - an unexpected exit respawns lazily on the next call, bounded by maxRespawn;
 *   - every query has its own timeout; a wedged child is killed and costs one respawn;
 *   - the boot handshake (ping→pong) doubles as the Add-Type compile barrier, so the first
 *     real query is hot and cold-start (~2.5s) is paid exactly once, inside prewarm;
 *   - dispose kills the child and is idempotent; app quit routes through disposeForQuit
 *     (win-bind/index.js) inside the will-quit flush chain. */
'use strict'
const { spawn } = require('child_process')
const { buildPsCommand } = require('./adapter-ps')
const { normProcName } = require('./pure/match')

const PROBE_OPS = ['ping', 'probe', 'enum', 'activate']

function createWinAdapter (deps = {}) {
  const spawnFn = deps.spawn || spawn
  const powershellPath = deps.powershellPath || 'powershell.exe'
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : 5000
  // Boot budget: spawn (~1.8s) + Add-Type (~0.7s) must fit even on a cold machine; individual
  // queries afterwards are milliseconds. Injectable for tests.
  const bootTimeoutMs = Number.isFinite(deps.bootTimeoutMs) ? deps.bootTimeoutMs : Math.max(timeoutMs, 15000)
  const maxRespawn = Number.isFinite(deps.maxRespawn) ? deps.maxRespawn : 3
  const log = deps.log || console

  let child = null
  let starting = null
  let disposed = false
  let nextId = 1
  let respawnUsed = 0
  let buffer = ''
  const pending = new Map() // id → { resolve, reject, timer }

  function failAll (err) {
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      try { p.reject(err) } catch { /* dying process */ }
    }
    pending.clear()
  }

  function killChild () {
    if (!child) return
    const c = child
    child = null
    try { c.kill() } catch { /* best-effort */ }
  }

  function dispatch (line) {
    let msg = null
    try { msg = JSON.parse(line) } catch {
      try { log.warn('[win-bind] unparseable adapter line:', String(line).slice(0, 200)) } catch { /* best-effort */ }
      return
    }
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.ok) p.resolve(msg.result)
    else p.reject(new Error('win-bind native error: ' + (msg.error || 'unknown')))
  }

  function onStdout (chunk) {
    buffer += chunk
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (line) dispatch(line)
    }
  }

  function wire (c) {
    // D13 C4: an un-listened 'error' (missing powershell.exe / AV block) crashes the host.
    c.on('error', err => {
      starting = null
      failAll(new Error('win-bind adapter child error: ' + (err && err.message)))
      killChild()
    })
    c.on('exit', code => {
      if (disposed) return // dispose()-triggered exit: expected, not an incident
      if (child === c) child = null
      starting = null
      respawnUsed++
      failAll(new Error('win-bind adapter child exited unexpectedly (' + code + ')'))
    })
    if (c.stdout && typeof c.stdout.setEncoding === 'function') c.stdout.setEncoding('utf8')
    if (c.stdout) c.stdout.on('data', onStdout)
    if (c.stderr) c.stderr.on('data', () => { /* PS noise; real failures surface via the protocol */ })
  }

  function request (op, extra, timeout) {
    const id = nextId++
    const payload = Object.assign({ id, op }, extra || {})
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('win-bind adapter timeout (' + op + ' after ' + timeout + 'ms)'))
        // A child that stopped answering is not trusted: recycle it now (the kill-driven exit
        // bumps respawnUsed, bounding the recycle loop).
        starting = null
        killChild()
      }, timeout)
      pending.set(id, { resolve, reject, timer })
      try {
        cWrite(JSON.stringify(payload) + '\n')
      } catch (err) {
        pending.delete(id)
        clearTimeout(timer)
        reject(err)
      }
    })
  }

  function cWrite (line) {
    if (!child || !child.stdin || child.stdin.destroyed) throw new Error('win-bind adapter child stdin unavailable')
    child.stdin.write(line)
  }

  function startChild () {
    const { cmd, args } = buildPsCommand(powershellPath)
    const c = spawnFn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    child = c
    wire(c)
    // Boot handshake: pong means Add-Type compiled and the line loop is reading.
    return request('ping', {}, bootTimeoutMs).then(() => undefined)
  }

  function ensureReady () {
    if (disposed) return Promise.reject(new Error('win-bind adapter disposed'))
    if (child && child.exitCode == null && !child.killed) return Promise.resolve()
    if (respawnUsed >= maxRespawn) {
      return Promise.reject(new Error('win-bind adapter respawn cap exceeded (' + maxRespawn + ')'))
    }
    if (!starting) {
      starting = startChild().catch(err => {
        starting = null
        killChild()
        throw err
      })
    }
    return starting
  }

  function normalizeRow (row) {
    if (!row || typeof row !== 'object') return row
    return {
      hwnd: Number(row.hwnd) || 0,
      pid: Number(row.pid) || 0,
      processName: normProcName(row.processName),
      execPath: String(row.execPath == null ? '' : row.execPath),
      title: String(row.title == null ? '' : row.title)
    }
  }

  return {
    /** Idle prewarm: pay the ~2.5s cold start now; failures stay silent (next query retries). */
    prewarm () {
      return ensureReady().then(() => undefined, () => undefined)
    },
    /** PS round trip: GetCursorPos + WindowFromPoint + GA_ROOT + text + pid + VK_LBUTTON. */
    async probeUnderCursor () {
      await ensureReady()
      const res = await request('probe', {}, timeoutMs)
      if (!res || typeof res !== 'object') return { raw: null, buttonDown: null }
      return {
        raw: res.raw ? normalizeRow(res.raw) : null,
        buttonDown: res.buttonDown === true ? true : (res.buttonDown === false ? false : null)
      }
    },
    /** EnumWindows + IsWindowVisible snapshot (own windows NOT filtered here — the matcher
     *  filters ownPid at every consumption point). */
    async enumerate () {
      await ensureReady()
      const rows = await request('enum', {}, timeoutMs)
      return Array.isArray(rows) ? rows.map(normalizeRow) : []
    },
    /** IsIconic→SW_RESTORE→SetForegroundWindow→verify; failure degrades to FlashWindow. */
    async activateHwnd (hwnd) {
      await ensureReady()
      const res = await request('activate', { hwnd: Number(hwnd) || 0 }, timeoutMs)
      return {
        wasIconic: !!res.wasIconic,
        setForeground: !!res.setForeground,
        foregroundNow: !!res.foregroundNow,
        flashed: !!res.flashed
      }
    },
    dispose () {
      disposed = true
      starting = null
      killChild()
      failAll(new Error('win-bind adapter disposed'))
    }
  }
}

module.exports = { createWinAdapter, PROBE_OPS }
