/* W30 (P3) external-db-watch restart idempotency + stop clears test-seam hooks.
 * restartLatestDbWatch used to call watchDbForExternalWrites() WITHOUT stopping the previous
 * watch — a second fs.watchFile pair stacked on the first whenever restart ran without an
 * intervening stop (every external write processed twice). stopDbWatch also left the
 * pollTickHook/changeHook test seams pointing at the dead closure.
 * Pin: restart stops-then-starts (callable repeatedly, exactly one reload per change tick),
 * stop nulls the seams (a tick between stop and next start is a no-op), restart re-arms them.
 * Harness pattern borrowed from w29-extwatch-baseline-rollback.test.mjs (Module._load stubs +
 * src copy so relative requires resolve without electron). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'module'
import Module from 'module'

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(import.meta.dirname, '../../..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'w30-extwatch-'))
const UD = path.join(TMP, 'ud')
fs.mkdirSync(path.join(UD, 'backups'), { recursive: true })

const ELECTRON_STUB = { app: { getPath: () => UD, getVersion: () => '0.0.0-test', relaunch: () => {}, exit: () => {}, quit: () => {} }, BrowserWindow () { return {} } }
const LOG_STUB = { info: () => {}, warn: () => {}, error: () => {} }
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB
  if (request === 'electron-log') return LOG_STUB
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

fs.cpSync(path.join(ROOT, 'src', 'main'), path.join(TMP, 'src', 'main'), { recursive: true })
fs.cpSync(path.join(ROOT, 'shared'), path.join(TMP, 'shared'), { recursive: true })

const mod = require_(path.join(TMP, 'src', 'main', 'external-db-watch.js'))
const { createExternalDbWatch, stopLatestDbWatch, restartLatestDbWatch } = mod

const DB = path.join(UD, 'todos.db')
const WAL = DB + '-wal'
fs.writeFileSync(DB, 'x')
fs.writeFileSync(WAL, 'x')

let reloadCalls = 0
let reloadCalls2 = 0
const dbm = { call: () => null }
const deps = {
  app: ELECTRON_STUB.app,
  log: LOG_STUB,
  dbm,
  fixUtil: require_(path.join(TMP, 'src', 'main', 'fix-util.js')),
  extWatchGate: { canPoll: () => true },
  nextWatchBaseline: (_prev, read) => { const v = read(); return v != null ? v : _prev },
  scheduler: { reloadAll: () => { reloadCalls++ } },
  getMainWindow: () => null,
  isLocked: () => false,
  dbApi: () => ({}),
  broadcastTodosChanged: () => {},
  broadcastTomatoRecordsChanged: () => {},
  BrowserWindow: { getAllWindows: () => [] },
}
const deps2 = { ...deps, scheduler: { reloadAll: () => { reloadCalls2++ } } }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const bumpWal = () => { fs.writeFileSync(WAL, 'x' + Date.now() + Math.random()); const t = new Date(Date.now() + 50); fs.utimesSync(WAL, t, t) }

test('restart after stop re-arms the poll seams and reloads exactly once per change tick', async () => {
  const watcher = createExternalDbWatch(deps)
  watcher.watchDbForExternalWrites()
  await sleep(20)
  stopLatestDbWatch()
  // W30: after a stop the test seams are dead — a tick is a no-op, not a dead-closure read
  watcher.__pollTickForTests()
  watcher.__pollChangeForTests()
  // restart (the fix under test): stop-first is idempotent, then re-arm
  restartLatestDbWatch()
  await sleep(20)
  bumpWal() // an actual external write since the fresh baseline
  watcher.__pollChangeForTests() // manual change tick through the re-armed closure
  await sleep(400) // kick debounce (150ms) + slack
  assert.equal(reloadCalls, 1, 'exactly one reload from one change tick after restart')
  restartLatestDbWatch() // second restart in a row must not throw nor double-process
  await sleep(20)
  bumpWal()
  watcher.__pollChangeForTests()
  await sleep(400)
  assert.equal(reloadCalls, 2, 'second restart still processes each change exactly once')
  stopLatestDbWatch()
})

test('stop nulls the seams: ticks between stop and the next start do nothing', async () => {
  reloadCalls2 = 0
  const watcher = createExternalDbWatch(deps2)
  watcher.watchDbForExternalWrites()
  await sleep(20)
  stopLatestDbWatch()
  bumpWal()
  watcher.__pollChangeForTests()
  await sleep(400)
  assert.equal(reloadCalls2, 0, 'no processing from a stopped watch (hooks cleared, not stale)')
})
