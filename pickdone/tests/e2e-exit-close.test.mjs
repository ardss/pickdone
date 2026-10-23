/**
 * E2E (self-booting) — the main-window X promise, F1 (2026-10-22 window-chrome review).
 *
 * Boots TWO fully isolated real instances (fresh TODO_USER_DATA_DIR/TODO_DB_DIR each,
 * --no-focus) and drives the PUBLIC preload call window.todoAPI.closeRequest() over CDP —
 * the exact circuit the custom titlebar X fires (WinControls.close -> 'close-main-window-request'):
 *   1. tray mode (default config): closeRequest must NOT exit the process (hide-to-tray,
 *      one-shot balloon). Guards against closeIntent regressing tray behavior.
 *   2. exit mode (pre-seeded config.json {closeActionMinimize:false}): closeRequest MUST exit
 *      the whole app (running-focus confirm is skipped on a fresh idle instance; the full
 *      before-quit/will-quit flush chain runs). This is the promise written by onboarding
 *      step 4 / Settings→General that stayed unimplemented from 0.1.0 until 71380bd3.
 *
 * Boot recipe mirrors scripts/app-dev.mjs (electron + '.', shell:false via the electron.exe
 * path from require('electron')); the renderer-dist build is ensured first, exactly like
 * app-dev's freshness fallback. Run: node --test tests/e2e-exit-close.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

let electronBin = null
let electronMissing = null
try { electronBin = require('electron') } catch (e) { electronMissing = 'electron binary unavailable: ' + (e && e.message) }
if (electronBin && !existsSync(electronBin)) { electronMissing = 'electron binary path does not exist: ' + electronBin; electronBin = null }

const CDP_PORT = 9377 // dedicated port: never overlaps the shared e2e instance on 9333
const CDP = 'http://127.0.0.1:' + CDP_PORT
// 90s (was 45s, 2026-10-24 night): in-gate the renderer's interactive-ready hydration
// measured past 45s under unit-tier self-load (final19: not ready within 45000ms at
// 48.6s total). Quiet-host boots land in ~8-15s, so 90s only widens the load band.
const BOOT_TIMEOUT_MS = 90000
// 60s (was 20s, 2026-10-24 night): the guarded quit chain (DB close, window teardown,
// child reaping) measured 25.7-34.3s in-gate where the three pools race for CPU - the
// 20s budget was a quiet-host number. A healthy quit still lands in 3-6s, so 60s only
// widens the load band while still reding a truly wedged quit, named.
const EXIT_TIMEOUT_MS = 60000
const TRAY_ALIVE_MS = 5000

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Watchdog: a leftover electron/CDP socket can hold the event loop; force-exit after 150s
// (node --test already counted the failures to stderr by then).
const watchdog = setTimeout(() => { console.error('[e2e-exit-close] watchdog forced exit'); process.exit(1) }, 150000)
watchdog.unref?.()

async function ensureRendererDist () {
  if (existsSync(join(appRoot, 'renderer-dist', 'index.html'))) return
  // Same fallback as app-dev.mjs: the app:// runtime only serves the built dist.
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const { status } = spawnSync(npm, ['run', 'build:renderer'], { cwd: appRoot, stdio: 'inherit' })
  if (status !== 0) throw new Error('build:renderer failed with status ' + status)
}

async function fetchJson (url, timeoutMs = 1500) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  return res.json()
}

/** Poll CDP until a non-float main page target exists; returns its webSocketDebuggerUrl. */
async function waitMainPageTarget () {
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const list = await fetchJson(CDP + '/json')
      const page = list.find(t => t.type === 'page' && t.url.includes('index.html') && !t.url.includes('__tomato-float'))
      if (page) return page.webSocketDebuggerUrl
    } catch { /* electron still booting */ }
    await sleep(500)
  }
  throw new Error('CDP page target not ready within ' + BOOT_TIMEOUT_MS + 'ms')
}

/**
 * INTERACTIVE readiness: a page target merely existing is not enough — the first app:// load
 * can fail-and-retry (observed ERR_FAILED -2 in a worktree boot), leaving the context mid-
 * reload where evaluates vanish. Ready = the target's renderer ANSWERS a probe for the public
 * API; after a failed load the retry may mint a NEW target, so each round refetches.
 */
async function waitInteractivePage () {
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    let wsUrl = null
    try { wsUrl = await waitMainPageTarget() } catch { /* keep polling until the deadline */ }
    if (wsUrl) {
      try {
        const probe = await cdpEval(wsUrl, 'JSON.stringify({ api: !!(window.todoAPI && window.todoAPI.closeRequest), iso: !!(window.todoAPI && window.todoAPI.isDataIsolated) })', 3000)
        const parsed = JSON.parse(probe)
        if (parsed.api && parsed.iso) return wsUrl
      } catch { /* reload window: refetch the (possibly new) target next round */ }
    }
    await sleep(500)
  }
  throw new Error('interactive renderer not ready within ' + BOOT_TIMEOUT_MS + 'ms')
}

/** Minimal one-shot CDP Runtime.evaluate (own socket, closed right after). */
async function cdpEval (wsUrl, expression, timeoutMs = 8000) {
  const ws = new WebSocket(wsUrl)
  try {
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP ws error')) })
    const msg = await Promise.race([
      new Promise((res, rej) => {
        ws.onmessage = e => {
          const m = JSON.parse(e.data)
          if (m.id === 1) res(m)
        }
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
      }),
      sleep(timeoutMs).then(() => { throw new Error('CDP evaluate timeout: ' + expression) }),
    ])
    return msg.result?.result?.value
  } finally { try { ws.close() } catch { /* already closed */ } }
}

/** Boot one isolated instance; returns { child, wsUrl, cleanup }. exit-mode = pre-seeded config. */
async function bootInstance ({ exitMode }) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pickdone-exitclose-'))
  await mkdir(join(dataDir, 'db'), { recursive: true })
  if (exitMode) await writeFile(join(dataDir, 'config.json'), JSON.stringify({ closeActionMinimize: false }), 'utf8')
  const env = {
    ...process.env,
    TODO_USER_DATA_DIR: dataDir,
    TODO_DB_DIR: join(dataDir, 'db'),
    // 2026-10-24: per-instance sync port — the fixed default 3442 collides with the
    // lan-sync-journey pair racing in the same unit tier (B2 restart then EADDRINUSEs).
    TODO_SYNC_PORT: String(await new Promise((resolve, reject) => {
      const srv = net.createServer()
      srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)) })
      srv.on('error', reject)
    })),
  }
  // Agent/IDE hosts (DSH/VSCode) export ELECTRON_RUN_AS_NODE=1 — electron.exe then boots as
  // plain Node and require('electron') resolves to the npm path-string shim (crash:
  // "Cannot read properties of undefined (reading 'getVersion')"). Strip it for the child.
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electronBin, ['.', '--no-focus', '--remote-debugging-port=' + CDP_PORT], { cwd: appRoot, env, stdio: 'ignore' })
  // Boot-failure hygiene: if the CDP-wait/eval below throws, the spawned electron must not
  // outlive the test (a hung run once orphaned one holding the debug port for everyone).
  try {
    return await bootInstanceAfterSpawn({ child, dataDir, exitMode })
  } catch (err) {
    try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* best-effort */ }
    await rm(dataDir, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

async function bootInstanceAfterSpawn ({ child, dataDir, exitMode }) {
  const cleanup = async () => {
    if (!child.killed && child.exitCode === null) {
      try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* best-effort */ }
    }
    await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  }
  const wsUrl = await waitInteractivePage()
  return { child, wsUrl, cleanup }
}

/** Wait until the electron PROCESS exits; resolves true/false (timeout). */
function waitExit (child, timeoutMs) {
  return new Promise(res => {
    const t = setTimeout(() => { child.removeListener('exit', onExit); res(false) }, timeoutMs)
    const onExit = () => { clearTimeout(t); res(true) }
    child.once('exit', onExit)
  })
}

test('E2E F1: exit-mode closeRequest quits the whole app; tray-mode closeRequest only hides', { skip: electronMissing ? electronMissing : false }, async t => {
  await ensureRendererDist()

  // --- Control: tray mode (default config) — X hides to tray, process stays resident ---
  await t.test('tray mode: closeRequest does NOT exit the process', async () => {
    const { child, wsUrl, cleanup } = await bootInstance({ exitMode: false })
    try {
      await cdpEval(wsUrl, 'window.todoAPI.closeRequest()')
      const stillAlive = !(await waitExit(child, TRAY_ALIVE_MS))
      assert.equal(stillAlive, true, 'tray-mode X must hide to tray, not quit (0.1.0 default behavior)')
      // CDP should still answer — the window was hidden, not destroyed, app still serving
      const list = await fetchJson(CDP + '/json')
      assert.ok(Array.isArray(list) && list.some(t2 => t2.type === 'page'), 'app still serving CDP after tray-mode hide')
    } finally { await cleanup(); await waitExit(child, 10000).catch(() => {}) }
  })

  // --- The F1 promise: exit mode — X quits the app (sequential boot: singleton lock free again) ---
  await t.test('exit mode: closeRequest exits the whole app', async () => {
    const { child, wsUrl, cleanup } = await bootInstance({ exitMode: true })
    try {
      // Fire-and-forget: on the quit path the closeRequest IPC reply races process teardown
      // (the page can die before Runtime.evaluate answers) — the assertion is the EXIT, not
      // the RPC reply. A genuinely-stuck app simply fails waitExit below.
      cdpEval(wsUrl, 'window.todoAPI.closeRequest()').catch(() => {})
      const exited = await waitExit(child, EXIT_TIMEOUT_MS)
      assert.equal(exited, true, 'exit-mode X must run the guarded quit chain and exit the process')
      let portDead = false
      try { await fetchJson(CDP + '/json', 1200) } catch { portDead = true }
      assert.equal(portDead, true, 'debug port must be gone after exit (full app.quit, not a hidden window)')
    } finally { await cleanup() }
  })
})
