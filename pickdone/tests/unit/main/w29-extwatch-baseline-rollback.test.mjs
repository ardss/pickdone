/* W29 — external-db-watch.js scan-loop state machine: real-behavior tests.
 *
 * Covers, against the REAL module (sandboxed require, electron/electron-log stubbed):
 *   - the D18 waiting-for-file arm: a null startup baseline must not kick; the first
 *     non-null read only arms (no reload/broadcast), and only a LATER distinct mtime kicks.
 *   - kick success: reload + both broadcasts fire once and the baseline advances
 *     (an unchanged next tick must not re-kick — no self-sustaining loop).
 *   - the W28 gate-closed rollback: a change whose debounce fires while extWatchGate is
 *     closed must NOT be consumed — the baseline rolls back and the same change is
 *     re-processed once the gate reopens.
 *   - the M2a failure rollback: a throwing scheduler.reloadAll rolls the baseline back so
 *     the next tick re-processes the same external write (kick's success path re-baselines).
 *   - W26 settings hot-sync no-window rollback: a CLI settings change observed while no main
 *     window exists is NOT consumed — once the window recovers, the very next tick hot-applies it.
 *   - the r6 settings poisoned-blob one-shot degrade: one warn per distinct payload, tick skipped,
 *     and parsing resumes when the CLI rewrites a valid blob.
 *   - the r2 tomato stale-slot abandon: a slot the CLI already gave up on (past TTL) is
 *     warned-and-dropped, never forwarded to the renderer.
 *   - seedTomatoWatermark (pure): fresh slot → counter-1 execute-once; stale → counter + onAbandon.
 *
 * Run: node --test tests/unit/main/w29-extwatch-baseline-rollback.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Module from 'node:module'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(import.meta.dirname, '../../..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'w29-extwatch-'))
const UD = path.join(TMP, 'ud')
fs.mkdirSync(path.join(UD, 'backups'), { recursive: true })

const ELECTRON_STUB = {
  app: { getPath: () => UD, getVersion: () => '0.0.0-test', relaunch: () => {}, exit: () => {}, quit: () => {} },
  BrowserWindow () { return {} },
}
const LOG_STUB = { info: () => {}, warn: () => {}, error: () => {}, hooks: [], transports: { file: {}, console: {} } }
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB
  if (request === 'electron-log') return LOG_STUB
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

// copy src/main AND shared/ so relative requires (settings-hot-sync -> ../../shared/...) resolve
fs.cpSync(path.join(ROOT, 'src', 'main'), path.join(TMP, 'src', 'main'), { recursive: true })
fs.cpSync(path.join(ROOT, 'shared'), path.join(TMP, 'shared'), { recursive: true })

const { createExternalDbWatch, seedTomatoWatermark, CLI_SLOT_ABANDON_TTL_MS } = require(path.join(TMP, 'src', 'main', 'external-db-watch.js'))

const DB = path.join(UD, 'todos.db')
const WAL = DB + '-wal'

// ---- controllable fakes ----
let gateOpen = true
let mainWin = null // null = quit-mode tray (no window)
const fakeWindows = [] // BrowserWindow.getAllWindows()
const logLines = []
const logStub = {
  info: (...a) => logLines.push(['info', a.join(' ')]),
  warn: (...a) => logLines.push(['warn', a.join(' ')]),
  error: () => {},
}
const meta = {} // dbm meta store; __maxRows fakes settingsRowsMaxUpdated
const dbm = {
  call (op, k) {
    if (op === 'getMeta') return meta[k] != null ? meta[k] : null
    if (op === 'settingsRowsMaxUpdated') return Number(meta.__maxRows) || 0
    return null
  },
}
const fixUtil = require(path.join(TMP, 'src', 'main', 'fix-util.js'))
// per-test recorders (reset at each test start — watchers share this module process)
let reloadCalls = []
let reloadFailures = null // when set to an int, the first N reloads throw (M2a failure injection)
const todoBroadcasts = []
const tomatoBroadcasts = []
function resetRecorders () {
  reloadCalls = []; reloadFailures = null; todoBroadcasts.length = 0; tomatoBroadcasts.length = 0
  logLines.length = 0; fakeWindows.length = 0
  gateOpen = true; mainWin = null
}
function makeDeps (over = {}) {
  return Object.assign({
    app: ELECTRON_STUB.app,
    log: logStub,
    dbm,
    fixUtil,
    extWatchGate: { canPoll: () => gateOpen },
    nextWatchBaseline: (_prev, read) => { const v = read(); return v != null ? v : _prev },
    scheduler: { reloadAll: (...a) => { if (reloadFailures != null && reloadFailures-- > 0) throw new Error('w29 injected reload failure'); reloadCalls.push(a) } },
    getMainWindow: () => mainWin,
    isLocked: () => false,
    dbApi: () => ({}),
    broadcastTodosChanged: tag => todoBroadcasts.push(tag),
    broadcastTomatoRecordsChanged: tag => tomatoBroadcasts.push(tag),
    BrowserWindow: { getAllWindows: () => fakeWindows },
  }, over)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

function bumpMtime (ms) {
  // give the wal a DISTINCT, strictly newer mtime (ext-watch reads max(db, wal))
  fs.writeFileSync(WAL, 'x')
  const t = new Date(ms)
  fs.utimesSync(WAL, t, t)
  return ms
}
let clock = Date.now()
function tickClock (delta) { clock = Math.max(clock + delta, Date.now() + delta); return clock }

test('seedTomatoWatermark: fresh queued slot at the counter keeps execute-once (counter-1)', () => {
  const wm = seedTomatoWatermark({
    getMeta: k => (k === 'cliTomatoSeq' ? 7 : JSON.stringify({ action: 'start', seq: 7 })),
    deleteMeta: () => { throw new Error('a fresh slot must NOT be deleted (it must execute once)') },
  })
  assert.equal(wm, 6, 'a FRESH slot (no at stamp) seeds counter-1 so it executes once')
})
test('seedTomatoWatermark: stale (CLI-abandoned) slot keeps the counter and compare-and-deletes the slot', () => {
  const deletes = []
  const slot = JSON.stringify({ action: 'stop', seq: 7, at: Date.now() - CLI_SLOT_ABANDON_TTL_MS - 1000 })
  const wm = seedTomatoWatermark({
    getMeta: k => (k === 'cliTomatoSeq' ? 7 : slot),
    deleteMeta: key => deletes.push(key),
  })
  assert.equal(wm, 7, 'an abandoned slot must NOT re-execute (watermark stays at the counter)')
  assert.deepEqual(deletes, ['cliTomatoCmd'], 'the stale slot is cleaned from the meta table')
})
test('seedTomatoWatermark: malformed slot keeps the counter watermark; throwing getMeta degrades to 0', () => {
  const wm = seedTomatoWatermark({ getMeta: k => (k === 'cliTomatoSeq' ? 4 : '{oops'), deleteMeta: () => {} })
  assert.equal(wm, 4)
  const wm2 = seedTomatoWatermark({ getMeta: () => { throw new Error('db busy') }, deleteMeta: () => {} })
  assert.equal(wm2, 0, 'a throwing read degrades to a zero watermark without throwing')
})

test('waiting-for-file arm: null startup baseline arms silently; only a later distinct mtime kicks', async () => {
  resetRecorders()
  fs.rmSync(DB, { force: true }); fs.rmSync(WAL, { force: true })
  // no todos.db yet at watcher start
  const watcher = createExternalDbWatch(makeDeps())
  watcher.watchDbForExternalWrites()
  assert.ok(logLines.some(([, m]) => m.includes('等待文件状态')), 'the waiting-for-file degrade is announced')
  assert.equal(reloadCalls.length, 0)

  // the file appears (recovery just created it) — first non-null read is an ARM, not a change
  fs.writeFileSync(DB, 'db')
  watcher.__pollChangeForTests()
  await sleep(220)
  assert.equal(reloadCalls.length, 0, 'arming must not kick a spurious external-write reload')
  assert.ok(logLines.some(([, m]) => m.includes('重新可读')), 'the re-arm is announced')
  assert.equal(todoBroadcasts.length, 0)

  // a REAL distinct mtime afterwards kicks exactly once
  bumpMtime(tickClock(50))
  watcher.__pollChangeForTests()
  await sleep(250)
  assert.equal(reloadCalls.length, 1, 'a distinct mtime after arming kicks the reload')
  assert.equal(todoBroadcasts.length, 1)
  assert.equal(tomatoBroadcasts.length, 1)
  assert.equal(todoBroadcasts[0], 'external-db-write')

  // baseline advanced: an unchanged next tick does NOT re-kick (no self-sustaining loop)
  watcher.__pollChangeForTests()
  await sleep(250)
  assert.equal(reloadCalls.length, 1, 'unchanged mtime must not re-kick')
  watcher.stopForQuit()
})

test('W28 gate-closed rollback: a change whose debounce fires inside the gate-closed window is re-processed after the gate reopens', async () => {
  resetRecorders()
  const watcher = createExternalDbWatch(makeDeps())
  watcher.watchDbForExternalWrites() // DB exists from the previous test → normal baseline
  const base = reloadCalls.length
  bumpMtime(tickClock(60))
  watcher.__pollChangeForTests() // arms the 150ms debounce
  gateOpen = false // the quit chain closes the gate BEFORE the debounce fires
  await sleep(260)
  assert.equal(reloadCalls.length, base, 'the reload must not run against a gated (flushing/closed) DB')
  // the change must NOT have been consumed: a tick while still gated does nothing...
  watcher.__pollChangeForTests()
  await sleep(50)
  assert.equal(reloadCalls.length, base)
  // ...and once the gate reopens, the SAME external write is re-processed (rollback contract)
  gateOpen = true
  watcher.__pollChangeForTests()
  await sleep(260)
  assert.equal(reloadCalls.length, base + 1, 'the rolled-back change is re-processed after the gate reopens')
  assert.equal(todoBroadcasts.length, 1, 'the broadcast fires for the re-processed change')
  watcher.stopForQuit()
})

test('M2a failure rollback: a throwing reloadAll rolls the baseline back — the write is re-processed, not consumed', async () => {
  resetRecorders()
  reloadFailures = 1 // the FIRST reloadAll throws; the retry succeeds
  const watcher = createExternalDbWatch(makeDeps())
  watcher.watchDbForExternalWrites()
  bumpMtime(tickClock(70))
  watcher.__pollChangeForTests()
  await sleep(260)
  assert.equal(reloadCalls.length, 0, 'the failed reload must not count as consumed work')
  assert.ok(logLines.some(([, m]) => m.includes('基线已回滚待下轮重处理')), 'the failure is surfaced with the rollback notice')
  // baseline rolled back → the SAME change re-kicks on the next tick and succeeds
  watcher.__pollChangeForTests()
  await sleep(260)
  assert.equal(reloadCalls.length, 1, 'the external write was re-processed to success after the rollback')
  watcher.stopForQuit()
})

test('W26 settings hot-sync: a CLI change observed with NO main window is not consumed — the recovered window hot-applies it on the next tick', async () => {
  resetRecorders()
  meta['db.settingsState'] = JSON.stringify({ theme: 'light', _savedAt: 1000 })
  const watcher = createExternalDbWatch(makeDeps())
  watcher.watchDbForExternalWrites() // boot baseline: theme=light @1000
  const sends = []
  const w1 = { isDestroyed: () => false, webContents: { send: (ch, patch, stamp) => sends.push([ch, patch, stamp]) } }
  fakeWindows.push(w1)

  // CLI rewrites the settings blob while the app sits in quit-mode tray (mainWin null)
  meta['db.settingsState'] = JSON.stringify({ theme: 'dark', _savedAt: 2000 })
  mainWin = null
  watcher.__pollTickForTests()
  assert.equal(sends.length, 0, 'no push can happen without a window')
  // the W26 contract: the NEXT tick after the window recovers must hot-apply the SAME change
  // (if the no-window tick had consumed the watermark, nothing would ever be pushed)
  mainWin = { webContents: {} }
  watcher.__pollTickForTests()
  assert.equal(sends.length, 1, 'the pending CLI change is hot-applied once the window exists')
  assert.equal(sends[0][0], 'external-settings-changed')
  assert.equal(sends[0][1].theme, 'dark', 'the patch carries the CLI-written value')
  assert.equal(sends[0][2], 2000, 'the blob _savedAt rides as the echo-stamp arg (not the folded watermark)')
  watcher.stopForQuit()
})

test('r6 settings poisoned blob: one warn per distinct payload, tick skipped, parsing resumes on a valid rewrite', () => {
  resetRecorders()
  meta['db.settingsState'] = JSON.stringify({ theme: 'light', _savedAt: 1000 })
  const watcher = createExternalDbWatch(makeDeps())
  watcher.watchDbForExternalWrites()
  const w1 = { isDestroyed: () => false, webContents: { send: () => {} } }
  fakeWindows.push(w1)
  mainWin = { webContents: {} }

  meta['db.settingsState'] = '{corrupt blob'
  watcher.__pollTickForTests()
  watcher.__pollTickForTests()
  const poisonedWarns = logLines.filter(([lv, m]) => lv === 'warn' && m.includes('不可解析')).length
  assert.equal(poisonedWarns, 1, 'the poisoned payload warns ONCE (one-shot degrade), not every tick')

  // the CLI rewrites a VALID blob with a newer stamp → hot-sync resumes
  meta['db.settingsState'] = JSON.stringify({ theme: 'dark', _savedAt: 3000 })
  const sends = []
  w1.webContents.send = (ch, patch) => sends.push([ch, patch])
  watcher.__pollTickForTests()
  assert.equal(sends.length, 1, 'hot-sync resumes after the CLI rewrites the blob')
  assert.equal(sends[0][1].theme, 'dark')
  watcher.stopForQuit()
})

test('r2 tomato stale-slot abandon: a slot past the CLI abandon TTL is warned-and-dropped, never forwarded', () => {
  resetRecorders()
  const watcher = createExternalDbWatch(makeDeps())
  watcher.watchDbForExternalWrites()
  const sends = []
  mainWin = { webContents: { send: (ch, cmd) => sends.push([ch, cmd]) } }
  meta['cliTomatoCmd'] = JSON.stringify({ action: 'stop', seq: 3, at: Date.now() - CLI_SLOT_ABANDON_TTL_MS - 5000 })
  watcher.__pollTickForTests()
  assert.equal(sends.length, 0, 'an abandoned CLI command must not execute after window/unlock recovery')
  assert.ok(logLines.some(([, m]) => m.includes('已过期弃置')), 'the abandon is surfaced in the log')
  watcher.stopForQuit()
})

test('tomato fresh command forward: a live slot command reaches the main window renderer', () => {
  resetRecorders()
  const watcher = createExternalDbWatch(makeDeps())
  watcher.watchDbForExternalWrites()
  const sends = []
  mainWin = { webContents: { send: (ch, cmd) => sends.push([ch, cmd]) } }
  meta['cliTomatoCmd'] = JSON.stringify({ action: 'start', seq: 9, at: Date.now() })
  watcher.__pollTickForTests()
  assert.equal(sends.length, 1, 'a fresh command is forwarded to the renderer')
  assert.equal(sends[0][0], 'cli-tomato-cmd')
  assert.equal(sends[0][1].action, 'start')
  assert.ok(logLines.some(([, m]) => m.includes('番茄命令已转发渲染端')), 'the forward is logged')
  watcher.stopForQuit()
})
