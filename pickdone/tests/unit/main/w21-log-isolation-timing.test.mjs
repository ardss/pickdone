/* W21 (2026-10-30) — log-isolation timing + concurrency of teardown chains.
 *
 * Pins five fixes:
 *   1. log-isolation installs resolvePathFn UNCONDITIONALLY and re-evaluates the isolation env
 *      at WRITE time — a module loaded BEFORE the env was set must still redirect (the old
 *      install-time check permanently no-op'd and wrote the real %APPDATA% log).
 *   2. d9-drill-side sets its own per-process TODO_DB_DIR before any production require;
 *      both spawn sites (helpers + smoke) strip the parent's isolation env.
 *   3. aux-load-guard: did-fail-load clears the W16 handshake watch too (retry chain and
 *      handshake-timeout path can no longer run concurrently).
 *   4. quit-ack: abandon() refuses count-form rounds (no membership gate exists there — a
 *      stale id could decrement expected with zero real acks).
 *   5. sync-apply-content pulls log-isolation at module top (source anchor).
 * Run: node --test tests/unit/main/w21-log-isolation-timing.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { startSide } from '../lan-sync/d9-drill-helpers.mjs'
import { attachLoadGuard } from '../../../src/main/aux-load-guard.js'
import { createQuitAckTracker } from '../../../src/main/quit-ack.js'

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

// Whole test file runs isolated: anything electron-log writes here must be throwaway.
const FILE_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'w21-'))
process.env.TODO_DB_DIR = FILE_TMP
process.env.TODO_USER_DATA_DIR = ''

const readRoot = rel => fs.readFileSync(path.join(APP_ROOT, rel), 'utf8')

/* ---------- 1: log-isolation write-time env evaluation ---------- */

test('W21: require log-isolation (no env) → apply → set env → write lands in the NEW isolation dir', { timeout: 120000 }, t => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w21-late-env-'))
  t.after(() => { try { fs.rmSync(dbDir, { recursive: true, force: true }) } catch { /* best effort */ } })
  const MARKER = `w21 timing probe ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  // Child runs with NO isolation env at require time — exactly the order that used to
  // permanently no-op the hook. We deliberately do NOT write in this phase (the default
  // path is the user's real log); we only assert the hook is installed and does not throw.
  // Then the env appears and the NEXT write must land in the isolation dir.
  const CHILD = `
    const iso = require(${JSON.stringify(path.join(APP_ROOT, 'src', 'main', 'log-isolation.js'))})
    const assert = require('node:assert')
    iso.applyLogIsolation() // idempotent no-op second call — must not throw either
    const log = require(${JSON.stringify(path.join(APP_ROOT, 'node_modules', 'electron-log'))})
    assert.equal(typeof log.transports.file.resolvePathFn, 'function',
      'resolvePathFn must be installed even when no isolation env existed at load time')
    // The env arrives AFTER module load — the write-time re-evaluation must honor it.
    process.env.TODO_DB_DIR = ${JSON.stringify(dbDir)}
    log.warn(${JSON.stringify(MARKER)})
  `
  const env = { ...process.env }
  delete env.TODO_DB_DIR
  delete env.TODO_USER_DATA_DIR
  const r = spawnSync(process.execPath, ['-e', CHILD], { encoding: 'utf8', timeout: 90000, env })
  assert.equal(r.status, 0, `child exited cleanly. stderr: ${r.stderr}`)

  const redirected = path.join(dbDir, 'logs', 'main.log')
  assert.ok(fs.existsSync(redirected), `write redirected into the late-set isolation dir (${redirected})`)
  assert.ok(fs.readFileSync(redirected, 'utf8').includes(MARKER), 'the late-env write landed in the redirected log')
})

test('W21: with the env set at require time the redirect still resolves at first write (unchanged semantics)', { timeout: 120000 }, t => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w21-early-env-'))
  t.after(() => { try { fs.rmSync(dbDir, { recursive: true, force: true }) } catch { /* best effort */ } })
  const MARKER = `w21 early-env probe ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const CHILD = `
    require(${JSON.stringify(path.join(APP_ROOT, 'src', 'main', 'log-isolation.js'))})
    require(${JSON.stringify(path.join(APP_ROOT, 'node_modules', 'electron-log'))}).warn(${JSON.stringify(MARKER)})
  `
  const r = spawnSync(process.execPath, ['-e', CHILD], { encoding: 'utf8', timeout: 90000, env: { ...process.env, TODO_DB_DIR: dbDir } })
  assert.equal(r.status, 0, `child exited cleanly. stderr: ${r.stderr}`)
  const redirected = path.join(dbDir, 'logs', 'main.log')
  assert.ok(fs.existsSync(redirected), `redirected log exists (${redirected})`)
  assert.ok(fs.readFileSync(redirected, 'utf8').includes(MARKER), 'early-env write landed in the redirected log')
})

/* ---------- 2: d9 drill-side self-isolation ---------- */

test('W21: d9-drill-side sets TODO_DB_DIR before its first production require (source anchor)', () => {
  const src = readRoot('tests/unit/lan-sync/d9-drill-side.mjs')
  const envSet = src.indexOf('process.env.TODO_DB_DIR =')
  const firstProdRequire = src.indexOf("require('../../../src/main/db.js')")
  assert.ok(envSet !== -1, 'drill-side must assign a per-process TODO_DB_DIR at its head')
  assert.ok(firstProdRequire !== -1)
  assert.ok(envSet < firstProdRequire,
    `env assignment (${envSet}) must precede the first production require (${firstProdRequire})`)
})

test('W21: d9 spawn sites strip the parent isolation env (source anchor)', () => {
  const helpers = readRoot('tests/unit/lan-sync/d9-drill-helpers.mjs')
  assert.match(helpers, /env:\s*cleanSideEnv\(\)/, 'helpers.launch must spawn with the stripped env')
  const smoke = readRoot('tests/unit/lan-sync/d9-concurrency-smoke.test.mjs')
  assert.match(smoke, /delete env\.TODO_DB_DIR/, 'smoke launch must drop TODO_DB_DIR')
  assert.match(smoke, /delete env\.TODO_USER_DATA_DIR/, 'smoke launch must drop TODO_USER_DATA_DIR')
})

test('W21: drill side boots and starts with a clean env (spawn integration, light)', { timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w21-d9-'))
  t.after(() => { /* dirs are throwaway tmp; side is killed below */ })
  const side = await startSide('w21-probe', dir)
  const r = await side.send({ do: 'read', op: 'getMeta', params: ['sync.pushCursor'] })
  assert.ok(!r.error, `side responds over its own isolated db: ${JSON.stringify(r)}`)
  side.kill()
})

/* ---------- 3: aux-load-guard did-fail-load clears the handshake watch ---------- */

function makeGuardableWin () {
  const wc = new EventEmitter()
  const win = new EventEmitter()
  win.isDestroyed = () => false
  win.webContents = wc
  win.loadURL = async () => {}
  return { win, wc }
}

const sleep = ms => new Promise(ok => setTimeout(ok, ms))

test('W21: did-fail-load clears the armed handshake watch — no concurrent timeout during the retry backoff', async () => {
  const { win, wc } = makeGuardableWin()
  let timeouts = 0
  attachLoadGuard(win, {
    url: 'app://app/x#/r', routeMark: 'r', tag: 'W21T',
    handshakeTimeoutMs: 60,
    isHandshakeHealthy: () => false, // nothing ever handshakes
    onHandshakeTimeout: () => { timeouts++ },
    retries: 3, backoffMs: 15,
  })
  wc.emit('did-finish-load') // arms the handshake watch
  // Main-frame failure right after: must kill the just-armed watch before it can fire.
  wc.emit('did-fail-load', {}, -2, 'ERR_FAILED', 'app://app/x#/r', true)
  await sleep(180)
  assert.equal(timeouts, 0, 'stale handshake timer must be cleared by did-fail-load')
  // Negative control: without the failure the same shape DOES time out.
  const { win: win2, wc: wc2 } = makeGuardableWin()
  let timeouts2 = 0
  attachLoadGuard(win2, {
    url: 'app://app/x#/r', routeMark: 'r', tag: 'W21T2',
    handshakeTimeoutMs: 60, isHandshakeHealthy: () => false,
    onHandshakeTimeout: () => { timeouts2++ },
  })
  wc2.emit('did-finish-load')
  await sleep(180)
  assert.equal(timeouts2, 1, 'control: an armed watch with no failure still fires')
})

/* ---------- 4: quit-ack abandon refuses count-form rounds ---------- */

test('W21: abandon on a count-form round is refused — a stale id cannot decrement expected', async () => {
  const tracker = createQuitAckTracker()
  const t = tracker.nextToken()
  tracker.beginRound(2, t) // legacy COUNT form
  const warn = console.warn
  let warned = ''
  console.warn = msg => { warned = String(msg) }
  let refused
  try { refused = tracker.abandon(99999) } finally { console.warn = warn }
  assert.equal(refused, false, 'count-form abandon must be refused (no membership gate exists)')
  assert.match(warned, /count-form/, 'refusal is announced loudly')
  assert.equal(tracker.allAcked(), false, 'expected untouched — a stale id cannot satisfy the round')
  assert.equal(tracker.progress(), '0/2')

  // Id-set rounds keep the W14 semantics exactly.
  const tracker2 = createQuitAckTracker()
  const t2 = tracker2.nextToken()
  tracker2.beginRound([10, 11], t2)
  assert.equal(tracker2.abandon(10), true, 'known sender abandons normally')
  assert.equal(tracker2.abandon(99), false, 'unknown sender still refused (W14 gate)')
  assert.equal(tracker2.abandon(10), false, 'abandon is idempotent')
  assert.equal(tracker2.allAcked(), false)
  assert.equal(tracker2.ack(t2, 11), true)
  assert.equal(tracker2.allAcked(), true, 'remaining real sender acking satisfies the round')
})

/* ---------- 5: sync-apply-content isolation anchor ---------- */

test('W21: sync-apply-content.js pulls log-isolation at module top, before any electron-log write', () => {
  const src = readRoot('src/main/sync-apply-content.js')
  const firstLogWrite = src.indexOf("require('electron-log')")
  const firstIsolation = src.indexOf("require('./log-isolation')")
  assert.ok(firstIsolation !== -1, 'module must pull in log-isolation')
  assert.ok(firstIsolation < firstLogWrite,
    `log-isolation (${firstIsolation}) must precede the first electron-log reference (${firstLogWrite})`)
})
