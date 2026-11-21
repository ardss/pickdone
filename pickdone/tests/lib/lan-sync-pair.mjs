/* lan-sync-pair — shared harness for REAL two-instance LAN sync journeys (2026-11-05).
 * Verbatim move from tests/integration/lan-sync-journey.test.mjs (structure ratchet, same
 * doctrine as the sync-apply splits): the CDP client + one full app Instance + boot/pair
 * helpers, so a second journey (pd20 episode handoff sync) can drive the same production
 * doors without duplicating 300 lines. No behavior change to the original journey. */
import { spawn, execSync } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PICKDONE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ELECTRON_BIN = process.platform === 'win32'
  ? path.join(PICKDONE_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(PICKDONE_ROOT, 'node_modules', 'electron', 'dist', 'electron')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Progress trace (goes to stderr so it is visible under any test reporter). */
const trace = (msg) => { try { console.error('[lan-sync-journey] ' + msg) } catch { /* stderr gone */ } }

/** Poll `fn` until truthy or the deadline; rethrows the last thrown error after the deadline.
 *  Defensive: a non-numeric ms (call-site arg-order bug) would make the deadline NaN and loop
 *  forever — clamp to the 30s default instead. */
async function until (fn, ms, what) {
  const budget = Number.isFinite(Number(ms)) && Number(ms) > 0 ? Number(ms) : 30000
  const deadline = Date.now() + budget
  let lastErr = null
  for (;;) {
    let v
    try { v = await fn(); lastErr = null } catch (e) { lastErr = e }
    if (v) return v
    if (Date.now() > deadline) {
      throw new Error('timed out (' + budget + 'ms): ' + what + (lastErr ? ' — last error: ' + lastErr.message : ''))
    }
    await sleep(150)
  }
}

/** Grab a free TCP port from the OS (bind 0, read, close). */
function freePort () {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// Minimal CDP client: one WebSocket per page target, Runtime.evaluate with
// awaitPromise + returnByValue. Node >=22 ships a global WebSocket.
// ---------------------------------------------------------------------------
class Cdp {
  constructor (wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.nextId = 1
    this.pending = new Map()
    this.ws.addEventListener('message', (ev) => {
      let m
      try { m = JSON.parse(String(ev.data)) } catch { return }
      if (m.id != null && this.pending.has(m.id)) {
        const { resolve, reject, timer } = this.pending.get(m.id)
        this.pending.delete(m.id)
        clearTimeout(timer)
        if (m.error) reject(new Error('CDP error: ' + JSON.stringify(m.error)))
        else if (m.result && m.result.exceptionDetails) {
          reject(new Error('renderer exception: ' + JSON.stringify(m.result.exceptionDetails.exception &&
            m.result.exceptionDetails.exception.description || m.result.exceptionDetails.text).slice(0, 400)))
        } else resolve(m.result && m.result.result && m.result.result.value)
      }
    })
  }

  static async connect (cdpPort, { targetTimeoutMs = 30000, wsTimeoutMs = 15000 } = {}) {
    const listUrl = 'http://127.0.0.1:' + cdpPort + '/json/list'
    // The page target appears once the main window is created.
    const target = await until(async () => {
      const res = await fetch(listUrl, { signal: AbortSignal.timeout(2000) })
      const list = await res.json()
      return (list || []).find(t => t.type === 'page' && t.webSocketDebuggerUrl) || null
    }, targetTimeoutMs, 'a CDP page target on port ' + cdpPort)
    const cdp = new Cdp(target.webSocketDebuggerUrl)
    await until(() => cdp.ws.readyState === 1, wsTimeoutMs, 'CDP websocket open')
    return cdp
  }

  evalExpr (expression, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('CDP eval timed out (' + timeoutMs + 'ms): ' + expression.slice(0, 100)))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: {
          expression, awaitPromise: true, returnByValue: true,
        } }))
      } catch (e) {
        clearTimeout(timer); this.pending.delete(id); reject(e)
      }
    })
  }

  close () { try { this.ws.close() } catch { /* already gone */ } }
}

// ---------------------------------------------------------------------------
// One full app instance: real electron process + its CDP session.
// ---------------------------------------------------------------------------

const spawnAvailable = typeof WebSocket === 'function' && fs.existsSync(ELECTRON_BIN)

class Instance {
  constructor ({ name, cdpPort, syncPort, userDir }) {
    this.name = name
    this.cdpPort = cdpPort
    this.syncPort = syncPort
    this.userDir = userDir
    this.proc = null
    this.pid = null
    this.cdp = null
  }

  spawnProc () {
    this.exitCode = undefined // a boot retry re-spawns the same Instance object
    // linux CI (ubuntu-latest) has no user namespaces / GPU: electron needs --no-sandbox and
    // --disable-gpu or it dies with code=null before the CDP port ever opens (PR #160 evidence)
    const linuxFlags = process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] : []
    const env = {
      ...process.env,
      PICKDONE_MULTI: '1',
      TODO_USER_DATA_DIR: this.userDir,
      // keep TODO_DB_DIR out: the data dir is owned by TODO_USER_DATA_DIR (dev-duo contract)
      TODO_DB_DIR: '',
      TODO_SYNC_PORT: String(this.syncPort),
    }
    // Agent/IDE hosts (DSH/VSCode) export ELECTRON_RUN_AS_NODE=1 — electron.exe then boots as
    // plain Node and require('electron') resolves to the npm path-string shim (same crash shape
    // e2e-exit-close.test.mjs strips for; journey-driver.mjs line-145 precedent).
    delete env.ELECTRON_RUN_AS_NODE
    this.proc = spawn(ELECTRON_BIN, ['.', ...linuxFlags, '--remote-debugging-port=' + this.cdpPort], {
      cwd: PICKDONE_ROOT,
      stdio: 'ignore',
      env,
    })
    this.pid = this.proc.pid
    this.proc.on('exit', (code) => { this.exitCode = code })
    return this.pid
  }

  async connectCdp ({ bootTimeoutMs = 60000 } = {}) {
    // Poll in bounded slices so a process that DIES during boot is detected
    // immediately (with its exit code) instead of burning the whole budget on
    // 'fetch failed' against an endpoint that will never exist.
    // J4 deadline renewal (2026-10-09): the budget is recomputed when a lock-loss
    // relaunch is first detected — the old single deadline computed before the loop was
    // shared between the original boot and the successor, so a slow relaunch could red
    // purely on spent wall-clock. One renewal per spawned process (exitCode is set once).
    let deadline = Date.now() + bootTimeoutMs
    let renewals = 0
    for (;;) {
      try {
        this.cdp = await Cdp.connect(this.cdpPort, { targetTimeoutMs: Math.min(15000, deadline - Date.now()) })
        break
      } catch (e) {
        if (this.exitCode === 0) {
          // D22: a CLEAN exit during boot is the documented bounded lock-loss relaunch
          // (multi-instance.js: a same-dir lock request denied right after a hard kill
          // relaunches the app with a pre-lock delay; the successor INHERITS this CDP
          // port). Keep polling — the successor's endpoint lands on the same port. A
          // non-zero exit stays a real crash and throws below.
          // 2026-10-20: under the full gate the successor's pre-lock delay + electron boot
          // routinely exceeded one renewal window (observed 82s+ on a busy box) — allow a
          // second renewal before declaring the successor missing. 2026-10-21: a third
          // renewal — the full-corpus unit gate still hit 1 miss/run on a saturated box
          // (solo the suite is 4/4 green, so this is pure wall-clock, not logic).
          if (renewals < 3) { renewals++; deadline = Date.now() + bootTimeoutMs }
          if (Date.now() > deadline) {
            throw new Error(`[${this.name}] electron exited code=0 (lock-loss relaunch) and no successor CDP came up on port ${this.cdpPort}`)
          }
          await sleep(300)
          continue
        }
        if (this.exitCode !== undefined) {
          throw new Error(`[${this.name}] electron exited code=${this.exitCode} before CDP came up on port ${this.cdpPort}`)
        }
        if (Date.now() > deadline) throw e
        await sleep(300)
      }
    }
    // Adopt the real listener: after a lock-loss relaunch the surviving process is a
    // successor, not this.pid — later killHard/stop must target the live tree.
    try {
      const out = execSync(`netstat -ano | findstr :${this.cdpPort}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      const m = out.split('\n').map((l) => l.trim().split(/\s+/)).find((p) => p[3] === 'LISTENING')
      const listenerPid = m && Number(m[4])
      if (listenerPid && listenerPid !== this.pid) {
        trace(`[${this.name}] adopting successor pid ${listenerPid} (original ${this.pid} relaunched away)`)
        this.pid = listenerPid
      }
    } catch { /* best-effort: pid stays the original */ }
    // Wait for the production preload surface before any journey step.
    await until(async () => {
      const ready = await this.cdp.evalExpr(
        "Promise.resolve(!!(window.todoAPI && typeof window.todoAPI.dbCall === 'function' && window.commands && typeof window.commands.commit === 'function'))",
        10000)
      return ready === true
    }, bootTimeoutMs, `[${this.name}] window.todoAPI / window.commands exposed`)
    return this
  }

  /** Spawn + wait for the CDP endpoint, retrying once on a boot stall: the process is
   *  alive but the debug endpoint never opens — the classic bind race on the allocated
   *  port (another process grabs it between freePort() and the electron bind, common on
   *  a loaded CI/agent box). The journey scenario is unchanged; only the boot detection
   *  is retried, on a freshly allocated port. */
  async boot ({ tries = 2, bootTimeoutMs = 60000 } = {}) {
    let lastErr = null
    for (let i = 0; i < tries; i++) {
      if (i > 0) {
        trace(`[${this.name}] boot attempt ${i + 1}/${tries} on a fresh CDP port (last error: ${lastErr && lastErr.message})`)
        this.cdpPort = await freePort()
      }
      this.spawnProc()
      try {
        return await this.connectCdp({ bootTimeoutMs })
      } catch (e) {
        lastErr = e
        // A dead process is a real failure (crash / lock loss) — do not mask it.
        if (this.exitCode !== undefined) throw e
        await this.killHard()
      }
    }
    throw lastErr
  }

  /** Production read path: window.todoAPI.dbCall(op, params). */
  dbCall (op, params, timeoutMs = 45000) {
    return this.cdp.evalExpr(
      `Promise.resolve(window.todoAPI.dbCall(${JSON.stringify(op)}, ${JSON.stringify(params || {})}))` +
      `.then(r => ({ ok: true, r })).catch(e => ({ ok: false, err: String((e && e.message) || e) }))`,
      timeoutMs).then(res => {
      if (!res || res.ok !== true) throw new Error(`[${this.name}] dbCall(${op}) failed: ${res && res.err}`)
      return res.r
    })
  }

  /** Production write path: window.commands.commit(entity, verb, payload).
   *  Unwraps the main-side batch envelope EXACTLY like the renderer facade
   *  (renderer/js/utils/commandBus.js commit): {results, failedIndex, error} →
   *  reject on failedIndex >= 0, else results[0] for single entries. Callers get the
   *  db op's verbatim return (minted ids, changed-id lists) — the production contract. */
  commit (entity, verb, payload, timeoutMs = 45000) {
    return this.cdp.evalExpr(
      `Promise.resolve(window.commands.commit(${JSON.stringify(entity)}, ${JSON.stringify(verb)}, ${JSON.stringify(payload || {})}))` +
      `.then(r => ({ ok: true, r })).catch(e => ({ ok: false, err: String((e && e.message) || e) }))`,
      timeoutMs).then(res => {
      if (!res || res.ok !== true) throw new Error(`[${this.name}] commit(${entity}.${verb}) failed: ${res && res.err}`)
      const r = res.r
      if (r && typeof r === 'object' && 'failedIndex' in r) {
        if (r.failedIndex >= 0) throw new Error(`[${this.name}] commit(${entity}.${verb}) failed: ${r.error || 'entry ' + r.failedIndex}`)
        return r.results && r.results.length === 1 ? r.results[0] : r.results
      }
      return r
    })
  }

  status () { return this.dbCall('syncGetStatus', {}) }

  liveTodos () { return this.dbCall('getAll', { deleted: false }) }

  binTodos () { return this.dbCall('getAll', { deleted: true }) }

  /** Hard kill OUR recorded pid only (same contract as dev-duo --verify). On Windows the
   *  main process death can leave renderer/GPU children briefly alive holding the data
   *  dir, so the tree is taken down by pid (taskkill /T — by pid, never by name). */
  async killHard () {
    this.cdp && this.cdp.close()
    this.cdp = null
    if (!this.pid) return
    try {
      if (process.platform === 'win32') {
        const { execSync } = await import('node:child_process')
        execSync(`taskkill /T /F /PID ${this.pid}`, { stdio: 'ignore' })
      } else {
        process.kill(this.pid)
      }
    } catch { /* already gone */ }
    await until(() => this.exitCode !== undefined || !this.isAlive(), 10000, `[${this.name}] process death after hard kill`)
  }

  isAlive () {
    if (!this.proc) return false
    try { process.kill(this.pid, 0); return true } catch { return false }
  }

  async stop () {
    this.cdp && this.cdp.close()
    this.cdp = null
    if (!this.proc || !this.pid) return
    // Windows: tree-kill UNCONDITIONALLY. exitCode set only proves the MAIN pid exited —
    // renderer/GPU children can outlive it (2026-10-24: two orphans survived a mid-J4 main
    // death because the exitCode guard skipped the kill). POSIX keeps graceful→SIGKILL.
    if (process.platform === 'win32') {
      try {
        const { execSync } = await import('node:child_process')
        execSync(`taskkill /T /F /PID ${this.pid}`, { stdio: 'ignore' })
      } catch { /* tree already gone */ }
      await until(() => this.exitCode !== undefined, 8000, `[${this.name}] exit after tree kill`).catch(() => { /* best effort */ })
      return
    }
    if (this.exitCode !== undefined) return
    try { this.proc.kill() } catch { /* already gone */ }
    await until(() => this.exitCode !== undefined, 8000, `[${this.name}] graceful exit`).catch(() => {
      try { this.proc.kill('SIGKILL') } catch { /* best effort */ }
    })
  }
}

// ---------------------------------------------------------------------------
// Shared suite state: one pair drives J1..J4 sequentially.
// ---------------------------------------------------------------------------
export function makePairDirs () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-sync-journey-'))
  return {
    root,
    dirA: path.join(root, 'instance-a'),
    dirB: path.join(root, 'instance-b')
  }
}

export {
  PICKDONE_ROOT, ELECTRON_BIN, sleep, trace, until, freePort, Cdp, spawnAvailable, Instance
}
