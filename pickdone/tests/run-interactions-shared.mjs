/**
 * Shared-instance live pool runner (2026-10-23 speed wave, work item 2).
 *
 * Problem: check-all GROUPS[2] used to run SIX gates through tests/run-interactions-gated.mjs
 * (ui-smoke / e2e / keyboard-e2e / cssom-integrity / ui-coverage / overlay-visibility) and each
 * target booted its OWN Electron instance — 6 boots + up to 6 concurrent instances per full gate.
 *
 * This runner boots ONE isolated instance (fresh mkdtemp userData, bind-then-release random CDP
 * port, anti-throttle flags — same boot contract as run-interactions-gated) and runs the targets
 * SEQUENTIALLY against it. Per-target isolation is a page-level reset (emulation-clear + reload),
 * NOT an app restart; the SQLite/LS state each target leaves behind is tolerated by design —
 * every target in the pool already self-seeds and asserts relatively (they were built to survive
 * a reused TODO_ALLOW_REUSE instance).
 *
 * Failure isolation (non-negotiable, preserved from the per-lane world):
 *   - every target gets its own verdict; a red target never reds its siblings
 *   - a target that KILLS the shared instance reds only itself; the instance is respawned
 *     EXACTLY ONCE for the remaining targets; a second death fails the rest with a named cause
 *
 * Handover to targets: group-A targets (ui-smoke/e2e/keyboard-e2e) attach via TODO_CDP;
 * self-spawning targets (cssom-integrity/ui-coverage/overlay-visibility via tests/lib/runtime.mjs)
 * attach via TODO_SHARED_CDP (spawnApp returns an attached ctx; its stopApp drops the WS without
 * killing the shared instance). Both env vars are exported to every target so a target's attach
 * door is its own choice.
 *
 * Usage: node tests/run-interactions-shared.mjs [script.mjs ...]   (defaults to the six gates)
 */
import { spawn, execSync } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerChild, unregisterChild } from './lib/child-registry.mjs'

const appCwd = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
const ELECTRON = process.platform === 'win32'
  ? path.join(appCwd, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(appCwd, 'node_modules', 'electron', 'dist', 'electron')

const DEFAULT_TARGETS = [
  'tests/ui-smoke.mjs',
  'tests/e2e.test.mjs',
  'tests/keyboard-e2e.mjs',
  'tests/cssom-integrity.mjs',
  'tests/ui-coverage.mjs',
  'tests/integration/overlay-visibility.test.mjs',
]
const TARGETS = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_TARGETS

const PER_TARGET_BUDGET_MS = 8 * 60 * 1000 // same ceiling class as the gated wrapper's 10min watchdog
const MAX_INSTANCE_RESPAWNS = 1

async function cdpAlive (url) {
  try { await fetch(url + '/json/list', { signal: AbortSignal.timeout(800) }); return true } catch { return false }
}

async function pickFreePort () {
  for (let i = 0; i < 12; i++) {
    const p = await new Promise((res, rej) => {
      const srv = net.createServer()
      srv.listen(0, '127.0.0.1', () => { const port = srv.address().port; srv.close(() => res(port)) })
      srv.on('error', rej)
    })
    if (!(await cdpAlive(`http://127.0.0.1:${p}`))) return p
  }
  throw new Error('no free debug port found')
}

let CDP = null
let child = null
let tmpDir = null

function reapIsolated () {
  if (child && process.platform === 'win32') { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch {} }
  else if (child) { try { child.kill('SIGKILL') } catch {} }
  if (child) unregisterChild(child.pid)
  if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 }) } catch {} }
  child = null; tmpDir = null
}
process.on('exit', reapIsolated)

async function bootInstance () {
  const port = await pickFreePort()
  CDP = `http://127.0.0.1:${port}`
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-shared-'))
  fs.mkdirSync(path.join(appCwd, 'tests', '.artifacts'), { recursive: true })
  const logFile = path.join(appCwd, 'tests', '.artifacts', 'smoke-shared-pool-' + process.pid + '.log')
  const env = { ...process.env, TODO_USER_DATA_DIR: tmpDir, TODO_CDP: CDP }
  delete env.ELECTRON_RUN_AS_NODE // harness/IDE hosts export it → electron boots as plain Node (check-all strips centrally; belt-and-braces here)
  child = spawn(ELECTRON, ['.', '--no-focus', '--remote-debugging-port=' + port,
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], {
    cwd: appCwd,
    env,
    stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')]
  })
  // D4: the shared instance is exactly the kind of child a hard-killed runner used to orphan.
  registerChild(child.pid, { match: ['--remote-debugging-port=' + port], purpose: 'shared live-pool electron' })
  child.once('exit', () => { /* aliveness is polled; reap stays with the exit handler */ })
  let up = false
  for (let i = 0; i < 60; i++) { if (await cdpAlive(CDP)) { up = true; break } await new Promise(r => setTimeout(r, 1000)) }
  if (!up) { reapIsolated(); throw new Error('shared instance not ready within 60s') }
  await new Promise(r => setTimeout(r, 2000)) // renderer boot settle (same as the gated wrapper)
  return CDP
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Aliveness needs a CONFIRMED death: a single /json fetch can time out under pool load while
// the instance is perfectly healthy — one blip must not respawn the instance (boot churn) nor
// false-red a just-finished target. Two probes, 1.5s apart, both dead = dead.
async function instanceDead () {
  if (!(await cdpAlive(CDP))) {
    await sleep(1500)
    return !(await cdpAlive(CDP))
  }
  return false
}

/** Page-level reset between targets: clear leaked emulation, reload, wait for the interactive probe. */
async function resetSharedPage () {
  const list = await (await fetch(CDP + '/json', { signal: AbortSignal.timeout(2000) })).json()
  const page = list.find(t => t.type === 'page' && t.url.includes('index.html') && !t.url.includes('__tomato-float'))
  if (!page) throw new Error('no main page target on the shared instance')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  const pending = new Map()
  let id = 0
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
  // bounded send: the minimal CDP client above has no socket-level timeout, and a wedged page
  // must fail THIS reset (named) instead of hanging the whole pool outside any per-target budget.
  // 20s (was 8s): under burst load a CDP round-trip to a LIVE page stalled past 8s and the reset
  // red'd as "timeout Runtime.enable" (2026-10-23 full gate, both attempts) — a wedged page still
  // fails named within the 20s probe budget below.
  const sendT = (method, params = {}, ms = 20000) => Promise.race([
    send(method, params),
    sleep(ms).then(() => { throw new Error('timeout ' + method) })
  ])
  try {
    await sendT('Runtime.enable'); await sendT('Page.enable')
    await sendT('Emulation.clearDeviceMetricsOverride').catch(() => {}) // a prior target's viewport override must not leak in
    // Canonical view chrome: a fresh instance always boots Today in LIST view, but a previous
    // target may have persisted todayViewMode='matrix' (TodayView watches it into localStorage;
    // real incident: ui-smoke [4.6] toggles the view, then keyboard-e2e's .td-title assert saw
    // no task rows because matrix renders pd-matrix-grid). Restore the fresh-boot baseline —
    // targets were all designed against a fresh instance's chrome.
    await sendT('Runtime.evaluate', { expression: `try{localStorage.setItem('todayViewMode','list')}catch(e){}`, returnByValue: true })
    await sendT('Page.reload') // plain reload: ignoreCache hangs under the app:// protocol (ui-smoke lesson)
    const probe = `JSON.stringify({ api: !!(window.todoAPI && window.todoAPI.closeRequest), iso: !!(window.todoAPI && window.todoAPI.isDataIsolated) })`
    for (let i = 0; i < 40; i++) {
      await sleep(500)
      try {
        const r = await sendT('Runtime.evaluate', { expression: probe, returnByValue: true })
        const parsed = JSON.parse(r.result?.result?.value || '{}')
        if (parsed.api && parsed.iso) return true
      } catch { /* document tearing down during reload */ }
    }
    throw new Error('shared page did not come back interactive within 20s')
  } finally {
    try { ws.close() } catch {}
  }
}

function runTarget (script) {
  return new Promise(resolve => {
    const t0 = Date.now()
    const child2 = spawn(process.execPath, [script], {
      cwd: appCwd,
      env: { ...process.env, TODO_CDP: CDP, TODO_SHARED_CDP: CDP },
      stdio: 'inherit'
    })
    const killer = setTimeout(() => {
      console.error(`[shared-pool] ${script} exceeded ${PER_TARGET_BUDGET_MS / 60000}min — tree-killing`)
      if (process.platform === 'win32') { try { execSync(`taskkill /PID ${child2.pid} /T /F`, { stdio: 'ignore' }) } catch {} }
      else { try { child2.kill('SIGKILL') } catch {} }
    }, PER_TARGET_BUDGET_MS)
    child2.on('exit', code => { clearTimeout(killer); resolve({ code: code ?? 1, ms: Date.now() - t0 }) })
  })
}

const results = []
let respawns = 0
// Respawn helper: returns false when the instance is dead AND the respawn budget is spent —
// every not-yet-run target then gets its own named red (never a silent green).
async function ensureAlive () {
  if (!(await instanceDead())) return true
  if (respawns >= MAX_INSTANCE_RESPAWNS) return false
  respawns++
  console.error(`[shared-pool] shared instance died — respawning (${respawns}/${MAX_INSTANCE_RESPAWNS})`)
  reapIsolated()
  try { await bootInstance(); return !(await instanceDead()) } catch (e) { console.error('[shared-pool] respawn failed: ' + e.message); return false }
}
try {
  console.log(`[shared-pool] targets: ${TARGETS.join(', ')}`)
  let booted = false
  try { await bootInstance(); booted = true; console.log('[shared-pool] shared instance up at ' + CDP) }
  catch (e) { console.error('[shared-pool] initial boot failed: ' + e.message) }
  for (const script of TARGETS) {
    const alive = booted ? await ensureAlive() : false
    if (!alive) {
      results.push({ script, ok: false, ms: 0, note: booted ? 'shared instance unavailable (respawn budget exhausted)' : 'shared instance boot failed' })
      console.error(`[shared-pool] ✗ ${script} — ${results[results.length - 1].note}`)
      continue
    }
    const name = path.basename(script)
    try { await resetSharedPage() } catch (e) {
      console.error(`[shared-pool] page reset failed before ${name}: ${e.message}`)
      results.push({ script, ok: false, ms: 0, note: 'page reset failed: ' + e.message })
      continue
    }
    console.log(`[shared-pool] ▶ ${name}`)
    const r = await runTarget(script)
    const stillAlive = !(await instanceDead())
    const note = !stillAlive ? ' [instance died during/after this target]' : ''
    results.push({ script, ok: r.code === 0 && stillAlive, ms: r.ms, note })
    console.log(`[shared-pool] ${r.code === 0 && stillAlive ? '✓' : '✗'} ${name} — ${(r.ms / 1000).toFixed(0)}s${note}`)
  }
} finally {
  reapIsolated()
}

console.log('\n[shared-pool] summary:')
for (const r of results) console.log(` ${r.ok ? '✓' : '✗'} ${(r.ms / 1000).toFixed(0).padStart(4)}s  ${r.script}${r.note ? '  ' + r.note : ''}`)
const failed = results.filter(r => !r.ok)
console.log(failed.length ? `[shared-pool] ✗ ${failed.length}/${results.length} target(s) failed` : `[shared-pool] ✓ all ${results.length} target(s) passed`)
process.exit(failed.length ? 1 : 0)
