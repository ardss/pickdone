/* W27 maintenance round — fixes 1/3/4:
 *   Fix 1 (P2) handlers/system.js data:relocate onProgress: `e.sender` IS a webContents (it has
 *     .send but no .webContents), so the unconditional `win.webContents.send` threw
 *     TypeError on the primary branch and the best-effort catch swallowed it — the migration
 *     modal never received a single 'data-migrate-progress' event. Covered by a source
 *     contract (same light style as W10 fix 2): the branch must send through BOTH surfaces.
 *   Fix 3 (P3) updater.js: a concurrent check() during an in-flight download (manual OR auto)
 *     could flip status to 'uptodate'/'checking'/'error' — the terminal-state guards only
 *     covered _manualDownload and the settled 'ready'. A module-level _downloading flag now
 *     owns the state for the whole download window.
 *   Fix 4 (P3) quit-ack.js awaitFlushAcks: the onDone(tracker) callback ran bare inside the
 *     timer callback (flushMain right above it was contained) — a throwing onDone would
 *     surface as an uncaughtException mid-teardown and could trigger crashRelaunch.
 * Run: node --test tests/unit/main/w27-updater-quitack-relocate.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const { awaitFlushAcks, POLL_MS } = require_('../../../src/main/quit-ack.js')
const { rotateArchive } = require_('../../../shared/audit-rotate.cjs')

const sleep = ms => new Promise(r => setTimeout(r, ms))

/* ---------- Fix 1: data:relocate progress IPC reaches a bare webContents sender ---------- */

test('W27 fix 1: data:relocate onProgress sends via win.send when the sender IS a webContents (source contract)', () => {
  const src = fs.readFileSync(require_.resolve('../../../src/main/handlers/system.js'), 'utf8')
  const onProgress = src.slice(src.indexOf("onProgress: p => {"), src.indexOf("})\n      if (!r.ok)"))
  assert.ok(onProgress.includes("'data-migrate-progress'"), 'onProgress block located')
  // The primary branch (e.sender, a bare webContents) must go through .send directly
  assert.match(onProgress, /else\s+win\.send\('data-migrate-progress'/,
    'webContents sender branch must use win.send — win.webContents is undefined on it')
  // The fallback branch (BrowserWindow from getMainWindow) keeps .webContents.send
  assert.match(onProgress, /win\.webContents\)\s+win\.webContents\.send\('data-migrate-progress'/,
    'BrowserWindow fallback keeps webContents.send')
  // The old unconditional shape must be gone
  assert.doesNotMatch(onProgress, /if \(win && !win\.isDestroyed\(\)\) win\.webContents\.send/,
    'unconditional win.webContents.send (TypeError on e.sender) must not return')
})

/* ---------- Fix 3: updater _downloading guard ---------- */

// Interception harness (same shape as d10-updater-manual-download.test.mjs): 'electron' is a
// path string under plain node; the stub must stay installed for the whole file.
let autoUpdaterStub = null
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'w27-updater-'))
const ELECTRON_STUB = { app: { getPath: () => TMP, getVersion: () => '0.0.0-test' } }
const Module = require_('module')
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB
  if (request === 'electron-updater') return { autoUpdater: autoUpdaterStub }
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

function freshUpdater (stub) {
  autoUpdaterStub = stub
  const resolved = require_.resolve('../../../src/main/updater.js')
  delete require_.cache[resolved]
  return require_(resolved)
}

function makeHandlers () {
  const h = {}
  return {
    handlers: h,
    stub: {
      isUpdaterActive: () => true,
      autoDownload: true,
      on: (evt, fn) => { (h[evt] = h[evt] || []).push(fn) },
      checkForUpdates: async () => ({}),
      downloadUpdate: async () => ({}),
      quitAndInstall: () => {},
    },
  }
}

test('W27 fix 3a: update-not-available during an in-flight AUTO download cannot flip status to uptodate', () => {
  const { handlers, stub } = makeHandlers()
  const updater = freshUpdater(stub)
  updater.init(null)
  stub.autoDownload = true // auto-download on: update-available arms the download window

  handlers['update-available'][0]({ version: '9.9.9' })
  assert.equal(updater.getStatus().status, 'downloading')

  // a periodic/other check fires these DURING the auto download — old code reset to
  // 'uptodate'/'checking', decoupling the UI from the real transfer.
  handlers['update-not-available'][0]({ version: '0.0.0-test' })
  assert.equal(updater.getStatus().status, 'downloading', 'update-not-available must be ignored mid-download')
  handlers['checking-for-update'][0]()
  assert.equal(updater.getStatus().status, 'downloading', 'checking-for-update must be ignored mid-download')

  // terminal: the download completes → 'ready'; the guard releases
  handlers['update-downloaded'][0]({ version: '9.9.9' })
  assert.equal(updater.getStatus().status, 'ready')
})

test('W27 fix 3b: check() rejection during an in-flight download cannot flip status to error', async () => {
  const { handlers, stub } = makeHandlers()
  stub.checkForUpdates = async () => { throw new Error('network down') }
  const updater = freshUpdater(stub)
  updater.init(null)
  stub.autoDownload = true
  handlers['update-available'][0]({ version: '9.9.9' })
  assert.equal(updater.getStatus().status, 'downloading')

  const r = await updater.check()
  assert.equal(r.status, 'downloading', "check()'s catch must respect _downloading — the download's own error paths own that transition")
})

test('W27 fix 3c: after a settled download the guard releases (uptodate semantics restored)', async () => {
  const { handlers, stub } = makeHandlers()
  const updater = freshUpdater(stub)
  updater.init(null)
  stub.autoDownload = true
  handlers['update-available'][0]({ version: '9.9.9' })
  handlers['update-downloaded'][0]({ version: '9.9.9' })
  assert.equal(updater.getStatus().status, 'ready')
  // a LATER not-available event must keep 'ready' (M2b terminal rule unchanged)
  handlers['update-not-available'][0]({ version: '0.0.0-test' })
  assert.equal(updater.getStatus().status, 'ready', 'ready stays terminal regardless of the guard')

  // fresh module: 'available' state with no download in flight → uptodate applies again
  const { handlers: h2, stub: s2 } = makeHandlers()
  const u2 = freshUpdater(s2)
  u2.init(null)
  s2.autoDownload = false // AFTER init: syncAutoDownload() re-enables by default (d10 pattern)
  h2['update-available'][0]({ version: '9.9.9' })
  assert.equal(u2.getStatus().status, 'available')
  h2['update-not-available'][0]({ version: '0.0.0-test' })
  assert.equal(u2.getStatus().status, 'uptodate', 'without a download in flight the old semantics apply')
})

test('W27 fix 3d: the guard releases after a manual download settles', async () => {
  const { handlers, stub } = makeHandlers()
  const updater = freshUpdater(stub)
  updater.init(null)
  stub.autoDownload = false // AFTER init: syncAutoDownload() re-enables by default (d10 pattern)
  handlers['update-available'][0]({ version: '9.9.9' })
  assert.equal(updater.getStatus().status, 'available')
  const done = updater.downloadUpdate()
  assert.equal(updater.getStatus().status, 'downloading')
  await done // the stub rejects → 'failed' path settles the download window
  handlers['error'][0](new Error('boom'))
  assert.equal(updater.getStatus().status, 'error', 'the error event records the failure')
  // release check: after the settled manual download, a fresh available event applies again
  handlers['update-available'][0]({ version: '9.9.9-b' })
  assert.equal(updater.getStatus().status, 'available', 'downloadUpdate settled + errored → _downloading released')
  handlers['update-not-available'][0]({ version: '0.0.0-test' })
  assert.equal(updater.getStatus().status, 'uptodate', 'without a download in flight the old semantics apply')
})

/* ---------- Fix 4: awaitFlushAcks contains a throwing onDone ---------- */

test('W27 fix 4: a throwing onDone is contained (warned, not an uncaughtException)', async () => {
  const warnings = []
  const origWarn = console.warn
  console.warn = (...a) => warnings.push(a.join(' '))
  let flushRan = false
  try {
    awaitFlushAcks({
      tracker: { allAcked: () => true }, // fast path: fires on the first poll tick
      flushMain: () => { flushRan = true },
      onDone: () => { throw new Error('injected onDone failure') },
    })
    await sleep(POLL_MS + 150)
  } finally {
    console.warn = origWarn
  }
  assert.equal(flushRan, true, 'flushMain ran before onDone threw')
  assert.match(warnings.join('\n'), /\[quit-ack\] onDone threw during quit teardown:.*injected onDone failure/,
    'the throw is contained + warned, same convention as flushMain')
})

test('W27 fix 4b: onDone still receives the tracker when it does not throw (behavior unchanged)', async () => {
  let seen = null
  awaitFlushAcks({
    tracker: { allAcked: () => true },
    flushMain: () => {},
    onDone: t => { seen = t },
  })
  await sleep(POLL_MS + 150)
  assert.ok(seen && typeof seen.allAcked === 'function', 'the tracker object reaches onDone')
})

/* ---------- Fix 5 companion smoke: rotate target carries the pid-unique suffix ---------- */

test('W27 fix 5 smoke: rotateArchive target embeds pid digits and stays prune-compatible (all-digit suffix)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w27-rotate-'))
  const file = path.join(dir, 'cli-audit.jsonl')
  fs.writeFileSync(file, 'line-1')
  const rolled = rotateArchive(file, () => {})
  assert.ok(rolled, 'rotation succeeded')
  assert.equal(fs.existsSync(file), false, 'source renamed away')
  assert.ok(rolled.includes(String(process.pid)), 'target embeds the pid (cross-process uniqueness by construction)')
  const suffix = path.basename(rolled).slice('cli-audit.jsonl.'.length)
  assert.match(suffix, /^\d+$/, 'digit-only suffix keeps pruneArchives digit-filter compatibility')
  assert.equal(fs.readFileSync(rolled, 'utf8'), 'line-1', 'content preserved')
})
