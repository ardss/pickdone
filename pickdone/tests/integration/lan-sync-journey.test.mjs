// LAN sync first-ten-minutes journey suite (node --test).
//
// Encodes the user's REAL first-ten-minutes flow end to end: boot two full app
// instances (the actual electron binary), enable LAN sync on both, pair B with A
// through the app's own two-way-confirmed pairing flow, then exercise the basic
// todo lifecycle across the pair and a hard-kill reconnect. Every assertion runs
// through the instances' CDP endpoints against the production preload surface
// (window.todoAPI.dbCall / window.commands.commit) — no production code is
// stubbed, faked, or required into the test process.
//
// Launcher choice (stated per the ask): this reuses the scripts/dev-duo.mjs
// LAUNCHER PATTERN (real electron.exe, PICKDONE_MULTI=1, TODO_USER_DATA_DIR per
// instance, TODO_SYNC_PORT per instance, CDP port per instance) but drives it
// directly from the test with FRESH temp dirs and FREE sync ports, because the
// journey needs programmatic restart control (J4) and must never touch the fixed
// 58471 port (the user's real instance owns it). Like dev-duo --verify, only the
// pids this suite itself recorded are ever killed.
//
// Scenarios (sequential — each builds on the previous pair):
//   J1 boot pair + two-way pairing completes on both sides.
//   J2 A creates 3 todos (todoTime / reminderTime / plain) -> both converge.
//   J3 B completes, edits, soft-deletes -> A converges; A's recycle bin holds the tombstone.
//   J4 hard-kill B, restart with the same dirs -> pairing survives, changes converge both ways.
//
// Run: node --test tests/integration/lan-sync-journey.test.mjs
//
// Like tests/integration/lan-sync-loopback.test.mjs, this spawns live processes
// and is excluded from the run-all default pool; it is a dedicated gate.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execSync } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PICKDONE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ELECTRON_BIN = process.platform === 'win32'
  ? path.join(PICKDONE_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(PICKDONE_ROOT, 'node_modules', 'electron', 'dist', 'electron')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Journey runtime bound. Every await in this file is individually timeout-bounded; this is
// the last-resort watchdog so a wedged CDP socket or child-runner glitch can never hang the
// gate past the budget. Prefer a loud failure over a silent hang.
// Budget arithmetic (2026-10-09): worst case is roughly J1's two 60s boot budgets + ~150s
// of bounded pairing waits, plus J4's restart — whose connectCdp now gets a FRESH 60s boot
// budget per lock-loss relaunch (deadline renewal fix) — then 120s pairing-intact + 60s
// convergence. The old 175s ceiling could be outrun by exactly the legit relaunch path
// this suite is designed to survive, so it is raised to 300s to cover the sum.
const WATCHDOG_MS = 300_000
const watchdog = setTimeout(() => {
  console.error(`[lan-sync-journey] GLOBAL WATCHDOG (${WATCHDOG_MS}ms) fired — force-exiting (1)`)
  if (process.env.JOURNEY_DIAG && process.report) {
    try {
      const rep = process.report.getReport()
      console.error('[lan-sync-journey] JS stack at watchdog:\n' + JSON.stringify(rep.javascriptStack, null, 2))
    } catch (e) { console.error('[lan-sync-journey] report failed: ' + e.message) }
  }
  process.exit(1)
}, WATCHDOG_MS)
watchdog.unref?.()

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
    this.proc = spawn(ELECTRON_BIN, ['.', ...linuxFlags, '--remote-debugging-port=' + this.cdpPort], {
      cwd: PICKDONE_ROOT,
      stdio: 'ignore',
      env: {
        ...process.env,
        PICKDONE_MULTI: '1',
        TODO_USER_DATA_DIR: this.userDir,
        // keep TODO_DB_DIR out: the data dir is owned by TODO_USER_DATA_DIR (dev-duo contract)
        TODO_DB_DIR: '',
        TODO_SYNC_PORT: String(this.syncPort),
      },
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
    let renewed = false
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
          if (!renewed) { renewed = true; deadline = Date.now() + bootTimeoutMs }
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
  dbCall (op, params, timeoutMs = 20000) {
    return this.cdp.evalExpr(
      `Promise.resolve(window.todoAPI.dbCall(${JSON.stringify(op)}, ${JSON.stringify(params || {})}))` +
      `.then(r => ({ ok: true, r })).catch(e => ({ ok: false, err: String((e && e.message) || e) }))`,
      timeoutMs).then(res => {
      if (!res || res.ok !== true) throw new Error(`[${this.name}] dbCall(${op}) failed: ${res && res.err}`)
      return res.r
    })
  }

  /** Production write path: window.commands.commit(entity, verb, payload). */
  commit (entity, verb, payload, timeoutMs = 20000) {
    return this.cdp.evalExpr(
      `Promise.resolve(window.commands.commit(${JSON.stringify(entity)}, ${JSON.stringify(verb)}, ${JSON.stringify(payload || {})}))` +
      `.then(r => ({ ok: true, r })).catch(e => ({ ok: false, err: String((e && e.message) || e) }))`,
      timeoutMs).then(res => {
      if (!res || res.ok !== true) throw new Error(`[${this.name}] commit(${entity}.${verb}) failed: ${res && res.err}`)
      return res.r
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
    if (this.proc && this.exitCode === undefined) {
      try { this.proc.kill() } catch { /* already gone */ }
      await until(() => this.exitCode !== undefined, 8000, `[${this.name}] graceful exit`).catch(() => {
        try { this.proc.kill('SIGKILL') } catch { /* best effort */ }
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Shared suite state: one pair drives J1..J4 sequentially.
// ---------------------------------------------------------------------------
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-sync-journey-'))
const dirA = path.join(scratchRoot, 'instance-a')
const dirB = path.join(scratchRoot, 'instance-b')
const liveInstances = new Set()

test.after(async () => {
  for (const inst of liveInstances) await inst.stop()
  try { fs.rmSync(scratchRoot, { recursive: true, force: true }) } catch { /* locked files left to the OS */ }
})

/** Poll until BOTH instances agree on the expected live todo state. Conflict-copy
 *  recycle-bin rows (merge.mjs conflictCopy, taskId '-conflict-<suffix>') are machine
 *  bookkeeping and may legitimately appear on either side — they are ignored here; the
 *  caller asserts the deleted rows' tombstones via binTodos() separately. */
async function expectConverged (a, b, wantIds, rowCheck, ms = 30000) {
  const want = new Set(wantIds)
  let lastSnap = ''
  let lastBad = ''
  const res = await until(async () => {
    const ta = (await a.liveTodos()).filter(r => !String(r.taskId).includes('-conflict-'))
    const tb = (await b.liveTodos()).filter(r => !String(r.taskId).includes('-conflict-'))
    lastSnap = `A=[${ta.map(r => r.taskId + (r.delete ? '(bin)' : '') + (r.complete ? '(done)' : '')).join(',')}] ` +
      `B=[${tb.map(r => r.taskId + (r.delete ? '(bin)' : '') + (r.complete ? '(done)' : '')).join(',')}]`
    const idsA = new Set(ta.map(t => t.taskId))
    const idsB = new Set(tb.map(t => t.taskId))
    let ok = true
    for (const id of want) { if (!idsA.has(id) || !idsB.has(id)) ok = false }
    for (const id of idsA) { if (!want.has(id)) ok = false }
    for (const id of idsB) { if (!want.has(id)) ok = false }
    if (ok && rowCheck) {
      for (const t of [...ta, ...tb]) { const bad = rowCheck(t); if (bad) { lastBad = t.taskId + ': ' + bad; ok = false } }
    }
    if (ok) return { a: ta, b: tb }
    return null
  }, ms, 'both instances converge').catch(async (e) => {
    let peerInfo = ''
    try {
      const [sa, sb] = await Promise.all([a.status(), b.status()])
      const fmt = (s) => JSON.stringify({ self: s.self && s.self.deviceId, port: s.port,
        peers: (s.peers || []).map(p => ({ id: p.deviceId && p.deviceId.slice(0, 8), st: p.peerState, online: p.online, err: p.lastError, wm: p.watermark })),
        lastError: s.lastError })
      peerInfo = ' — A peers: ' + fmt(sa) + ' — B peers: ' + fmt(sb)
    } catch (err) { peerInfo = ' — status read failed: ' + err.message }
    throw new Error('timed out (' + ms + 'ms): both instances converge on [' + [...want].join(',') + ']' +
      (rowCheck ? ' with row checks passing' : '') + ' — last snapshot: ' + lastSnap +
      (lastBad ? ' — rowCheck: ' + lastBad : '') + peerInfo)
  })
  return res
}

// A single journey pair, driven through the four sequential scenarios. All four
// tests are skipped wholesale when spawning is unavailable (sandbox without the
// electron binary or without child spawn / WebSocket).
const pair = { a: null, b: null, ready: false }

test('J1: boot pair + enable sync + two-way pairing completes on both sides', async (t) => {
  if (!spawnAvailable) {
    return t.skip('electron binary or WebSocket/spawn unavailable in this sandbox — journey scenarios skipped')
  }
  try {
    const [cdpA, cdpB, syncA, syncB] = await Promise.all([freePort(), freePort(), freePort(), freePort()])
    fs.mkdirSync(dirA, { recursive: true })
    fs.mkdirSync(dirB, { recursive: true })
    const a = new Instance({ name: 'A', cdpPort: cdpA, syncPort: syncA, userDir: dirA })
    const b = new Instance({ name: 'B', cdpPort: cdpB, syncPort: syncB, userDir: dirB })
    liveInstances.add(a); liveInstances.add(b)
    pair.a = a; pair.b = b
    await a.boot()
    await b.boot()

    // Enable sync on both. NOTE (found by this suite, first run): the sync.* ops are
    // async in db.OPS, and commands:commit pushes their pending Promise into its
    // {results:[...]} envelope, which cannot be structured-cloned over IPC. The
    // renderer's own command bus therefore aliases sync.* commands to the dbCall door
    // (renderer/js/utils/commandBus.js 'sync.setEnabled': 'syncSetEnabled') — this
    // suite uses that same production alias path for every sync.* op.
    await a.dbCall('syncSetEnabled', { enabled: true })
    await b.dbCall('syncSetEnabled', { enabled: true })
    const stA = await until(async () => {
      const s = await a.status()
      return s.listening ? s : null
    }, 15000, '[A] sync node listening after enable')
    const stB = await until(async () => {
      const s = await b.status()
      return s.listening ? s : null
    }, 15000, '[B] sync node listening after enable')
    assert.equal(stA.port, syncA, '[A] binds the per-instance TODO_SYNC_PORT')
    assert.equal(stB.port, syncB, '[B] binds the per-instance TODO_SYNC_PORT')
    assert.ok(stA.port !== 58471 && stB.port !== 58471, 'neither instance may squat the user’s real sync port 58471')

    // Two-way pairing, exactly the app's flow: B requests at 127.0.0.1:<A port>,
    // A's human accepts via syncPairRespond on the surfaced pendingPair.
    const requestPromise = b.dbCall('syncPairRequest', { host: '127.0.0.1', port: stA.port }, 45000)
    await until(async () => {
      const s = await a.status()
      return !!(s.pendingPair && s.pendingPair.deviceId)
    }, 20000, '[A] pendingPair surfaced for the inbound pair request')
    const responded = await a.dbCall('syncPairRespond', { accept: true })
    assert.equal(responded && responded.ok, true, '[A] pair respond accepted')

    const reqResult = await requestPromise
    assert.ok(reqResult && (reqResult.peer || reqResult.deviceId),
      '[B] pair request resolves with the accepted peer: ' + JSON.stringify(reqResult).slice(0, 200))

    // Pairing completes on BOTH sides: each status shows the other as a paired peer,
    // healthy after the first round.
    await until(async () => {
      const sa = await a.status()
      const sb = await b.status()
      return (sa.peers || []).some(p => p.deviceId === sb.self.deviceId) &&
             (sb.peers || []).some(p => p.deviceId === sa.self.deviceId)
    }, 30000, 'both instances list each other as paired peers')
    // Peer state 'ok' after the first round. Race guard: pairing restarts BOTH nodes
    // (pair-ops syncPairRequest: stopSync -> startSync -> runRound); if one side's
    // post-pair round dials while the other is still rebinding its port, the peer parks
    // in 'error' with no auto-retry. Kick it the way the app itself does (syncSetName
    // restarts the node; startSync's timer fires a fresh round 2s later) every 6s
    // while the state has not settled yet.
    let lastKickAt = 0
    await until(async () => {
      const sa = await a.status()
      const sb = await b.status()
      const pa = (sa.peers || []).find(p => p.deviceId === sb.self.deviceId)
      const pb = (sb.peers || []).find(p => p.deviceId === sa.self.deviceId)
      if (pa && pb && pa.peerState === 'ok' && pb.peerState === 'ok') return true
      if (Date.now() - lastKickAt > 6000) {
        lastKickAt = Date.now()
        await a.dbCall('syncSetName', { name: 'Journey-A' }).catch(() => {})
        await b.dbCall('syncSetName', { name: 'Journey-B' }).catch(() => {})
      }
      return null
    }, 40000, 'peer state is ok on both sides after the first round')

    trace('J1 complete: pair is up and paired both ways')
    pair.ready = true
  } catch (e) {
    if (/EADDRINUSE|spawn|ENOENT/i.test(String(e.message))) {
      return t.skip('process spawning unavailable in this sandbox: ' + e.message)
    }
    throw e
  }
})

test('J2: first sync — A creates 3 todos (todoTime / reminderTime / plain), both sides converge', async (t) => {
  if (!spawnAvailable || !pair.ready) return t.skip('pair not booted (spawning unavailable or J1 skipped)')
  const { a, b } = pair
  const t0 = Date.now()
  await a.commit('todo', 'put', { taskId: 'journey-time-1', taskContent: 'has todoTime', todoTime: t0 })
  await a.commit('todo', 'put', { taskId: 'journey-rem-1', taskContent: 'has reminder', reminderTime: t0 + 3600_000 })
  await a.commit('todo', 'put', { taskId: 'journey-plain-1', taskContent: 'plain todo' })

  const { a: ta, b: tb } = await expectConverged(a, b,
    ['journey-time-1', 'journey-rem-1', 'journey-plain-1'],
    (row) => {
      if (row.taskId === 'journey-time-1' && Number(row.todoTime) !== t0) return 'todoTime lost'
      if (row.taskId === 'journey-rem-1' && Number(row.reminderTime) !== t0 + 3600_000) return 'reminderTime lost'
      if (row.taskId === 'journey-plain-1' && (row.todoTime || row.reminderTime)) return 'plain row grew schedule fields'
      return null
    })

  // Assert on BOTH instances (per the ask): each side's copy of every field.
  for (const [name, rows] of [['A', ta], ['B', tb]]) {
    const byId = new Map(rows.map(r => [r.taskId, r]))
    assert.equal(byId.get('journey-time-1').taskContent, 'has todoTime', `[${name}] todoTime row content`)
    assert.equal(Number(byId.get('journey-time-1').todoTime), t0, `[${name}] todoTime round-trips`)
    assert.equal(Number(byId.get('journey-rem-1').reminderTime), t0 + 3600_000, `[${name}] reminderTime round-trips`)
    assert.equal(byId.get('journey-plain-1').taskContent, 'plain todo', `[${name}] plain row content`)
    assert.ok(!byId.get('journey-plain-1').delete, `[${name}] plain row live`)
  }
})

test('J3: bidirectional basic ops — B completes/edits/deletes, A converges, recycle bin holds the tombstone', async (t) => {
  if (!spawnAvailable || !pair.ready) return t.skip('pair not booted (spawning unavailable or J1 skipped)')
  const { a, b } = pair
  trace('J3: start')

  // B completes one, edits one (title change), soft-deletes one — all through the
  // production command path. NOTE: todo.put is a full-row UPSERT (db.js upsert /
  // todoToRow) — a partial payload would clobber unspecified fields with defaults —
  // so each op carries the FULL current row the way the renderer does, MINUS the stale
  // LWW stamp: a carried-over updateTime ties with the peer's copy and merge.mjs
  // resolves the tie against the delete/edit ("same-stamp echo — local row stands").
  const fresh = (row, patch) => {
    const p = { ...row, ...patch }
    delete p.updateTime
    delete p.createTime
    delete p.syncTime
    return p
  }
  await b.commit('todo', 'put', fresh((await b.liveTodos()).find(r => r.taskId === 'journey-plain-1'), { complete: true }))
  trace('J3: completion committed on B')
  const rowOnB = (await b.liveTodos()).find(r => r.taskId === 'journey-time-1')
  assert.ok(rowOnB, 'B holds the todoTime row before editing it')
  await b.commit('todo', 'put', fresh(rowOnB, { taskContent: 'edited by B' }))
  trace('J3: title edit committed on B')
  // The tombstone's LWW age is its deletedAt (db-rows.js todoToRow: a deleted row's honest
  // age is deletedAt, not updateTime) — carried-over deletedAt=0 makes the tombstone
  // epoch-oldest and the live row resurrects it on the next round.
  await b.commit('todo', 'put', fresh((await b.liveTodos()).find(r => r.taskId === 'journey-rem-1'), { delete: true, deletedAt: Date.now() }))
  trace('J3: soft delete committed on B, polling convergence')

  const { a: ta, b: tb } = await expectConverged(a, b,
    ['journey-time-1', 'journey-plain-1'],
    (row) => {
      if (row.taskId === 'journey-plain-1' && !row.complete) return 'completion not applied'
      if (row.taskId === 'journey-time-1' && row.taskContent !== 'edited by B') return 'title edit not applied'
      return null
    })

  for (const [name, rows] of [['A', ta], ['B', tb]]) {
    const byId = new Map(rows.map(r => [r.taskId, r]))
    assert.equal(byId.get('journey-plain-1').complete, true, `[${name}] completion synced`)
    assert.equal(byId.get('journey-time-1').taskContent, 'edited by B', `[${name}] title edit synced`)
    assert.ok(!byId.has('journey-rem-1'), `[${name}] deleted row left the live set`)
  }
  // Recycle bin on A holds the tombstoned row (soft delete, not a hard delete).
  const binA = await until(async () => {
    const bin = await a.binTodos()
    return bin.some(r => r.taskId === 'journey-rem-1') ? bin : null
  }, 30000, '[A] recycle bin holds the tombstoned row')
  const tomb = binA.find(r => r.taskId === 'journey-rem-1')
  assert.equal(tomb.delete, true, '[A] recycle-bin row carries the delete flag')
  assert.ok(Number(tomb.deletedAt) > 0, '[A] recycle-bin row carries a deletion timestamp')
  // Symmetry check on B's bin too.
  const binB = await b.binTodos()
  assert.ok(binB.some(r => r.taskId === 'journey-rem-1'), '[B] recycle bin also holds the tombstone')
})

test('J4: reconnect — hard-kill B, restart with the same dirs, pair state survives, changes converge both ways', async (t) => {
  if (!spawnAvailable || !pair.ready) return t.skip('pair not booted (spawning unavailable or J1 skipped)')
  const { a, b } = pair

  // Hard kill (ungraceful unplug — same semantics as the user yanking the app),
  // then restart on the SAME data dir / sync port (dev-duo --keep semantics). The
  // CDP port is re-allocated: after a hard kill the old port may linger in TIME_WAIT.
  const aSelf = (await a.status()).self
  const bCdpPort = await freePort()
  const bSyncPort = b.syncPort
  trace('J4: hard-killing B (pid ' + b.pid + ')')
  await b.killHard()
  trace('J4: B dead, restarting on the same data dir + sync port')

  const b2 = new Instance({ name: 'B2', cdpPort: bCdpPort, syncPort: bSyncPort, userDir: dirB })
  liveInstances.add(b2)
  pair.b = b2
  await b2.boot()
  trace('J4: B2 CDP up')

  // Pair state survived the crash: sync is still enabled and B still holds A as a
  // paired peer (persisted sync.peers restored on boot).
  const stB2 = await until(async () => {
    const s = await b2.status()
    return s.enabled && (s.peers || []).some(p => p.deviceId === aSelf.deviceId) ? s : null
  }, 120000, '[B2] restarted with pairing intact (enabled + A in the peer table)')
  assert.ok(stB2.listening, '[B2] sync node listening again after restart')

  // Pending changes converge BOTH ways: A pushes an edit, restarted B pushes a new row.
  // Same full-row-minus-stamp rule as J3 for A's post-restart edit.
  const aRow = (await a.liveTodos()).find(r => r.taskId === 'journey-time-1')
  const editPayload = { ...aRow, taskContent: 'post-restart edit from A' }
  delete editPayload.updateTime
  delete editPayload.createTime
  delete editPayload.syncTime
  await a.commit('todo', 'put', editPayload)
  await b2.commit('todo', 'put', { taskId: 'journey-post-restart', taskContent: 'written on restarted B' })
  trace('J4: post-restart writes committed on both sides, polling convergence')

  const { a: ta, b: tb } = await expectConverged(a, b2,
    ['journey-time-1', 'journey-plain-1', 'journey-post-restart'],
    (row) => (row.taskId === 'journey-time-1' && row.taskContent !== 'post-restart edit from A')
      ? 'A post-restart edit not applied'
      : null, 60000)

  const byA = new Map(ta.map(r => [r.taskId, r]))
  const byB = new Map(tb.map(r => [r.taskId, r]))
  assert.equal(byA.get('journey-plain-1').taskContent, 'plain todo',
    '[A] completion kept the full row content (full-row upsert)')
  assert.equal(byA.get('journey-post-restart').taskContent, 'written on restarted B',
    '[A] received the restarted B’s row (B -> A direction)')
  assert.equal(byB.get('journey-time-1').taskContent, 'post-restart edit from A',
    '[B] received A’s post-restart edit (A -> B direction)')
  assert.equal(byB.get('journey-plain-1').complete, true,
    '[B] pre-crash completion state still intact after reconnect')
})
