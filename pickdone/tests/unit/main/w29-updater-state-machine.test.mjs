/* W29 maintenance — updater state machine, behavior coverage.
 *
 * Drives the real module's event handlers on a stubbed autoUpdater (EventEmitter):
 * the early-flush round handshake, idle→checking→downloading→ready migration, the
 * W27/D10/M2b guards (a concurrent check must not clobber a live download or a
 * settled 'ready'), the manual download consent restore + idempotent reentry, the
 * error/retry path, and the quitAndInstall ready-gate with its pre-install settle.
 *
 * NOTE: flushOnceOnReady is once-per-process (_flushedOnReady), so its test runs
 * FIRST — the later 'update-downloaded' transition legitimately no-ops it.
 *
 * Run: node --test tests/unit/main/w29-updater-state-machine.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Module from 'node:module'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

delete process.env.PORTABLE_EXECUTABLE_DIR
delete process.env.PICKDONE_NO_AUTOUPDATE
process.env.PICKDONE_UPDATER_RETRY_MS = '25'
process.env.PICKDONE_UPDATER_STALL_MS = '400'

// ---- config-store stub: consent is controllable per phase ----
const cfg = { autoDownloadUpdates: true }
const cfgReadFailed = false
const sent = [] // updater:event payloads reaching the fake main window

// ---- autoUpdater stub ----
class FakeAutoUpdater extends EventEmitter {
  constructor () { super(); this.isUpdaterActive = () => true; this.autoDownload = true; this.logger = null }
}
const autoUpdater = new FakeAutoUpdater()
let currentAU = autoUpdater // each sandboxed module copy gets its own autoUpdater instance

const schedulerCalls = { flush: 0 }
const lanCalls = { stop: 0 }
let quitInstallArgs = null

const ELECTRON_STUB = {
  app: { getPath: () => process.env.TODO_USER_DATA_DIR || process.env.TODO_DB_DIR || '.', getVersion: () => '9.9.9-w29' },
  BrowserWindow: { getAllWindows: () => [] }
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB
  if (request === 'electron-updater') return { autoUpdater: currentAU }
  if (request === 'electron-log') return { warn: () => {}, info: () => {}, error: () => {} }
  if (request === './config-store') return { readConfig: () => cfg, isReadFailed: () => cfgReadFailed }
  if (request === './scheduler') return { flushFiredNow: () => { schedulerCalls.flush++ } }
  if (request === './lan-sync-bootstrap') return { stopSyncForQuit: async () => { lanCalls.stop++ } }
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const updater = require('../../../src/main/updater.js')

const win = { isDestroyed: () => false, webContents: { send: (ch, payload) => { if (ch === 'updater:event') sent.push(payload) } } }
const status = () => sent.length ? sent[sent.length - 1].status : null

test('w29-updater: the early-flush round — broadcast carries a token, forwardFlushAck routes the ack, a late ack is dropped', async () => {
  const sentFlush = []
  const fakeWin = { isDestroyed: () => false, webContents: { id: 51, send: (ch, ...a) => { if (ch === 'app-quitting-flush') sentFlush.push(a) } } }
  let flushMainCalled = 0
  updater.flushOnceOnReady({
    getWindows: () => [fakeWin],
    ACK_CAP_MS: 5000,
    flushMain: () => { flushMainCalled++ }
  })
  assert.equal(sentFlush.length, 1, 'the flush round broadcast the tokenized handshake')
  const token = sentFlush[0][0].token
  assert.equal(typeof token, 'number')
  // an ack from a sender we never sent to cannot satisfy the round
  assert.equal(updater.forwardFlushAck(token, 999), false)
  assert.equal(flushMainCalled, 0)
  // the expected sender's ack completes the round → flushMain fires
  assert.equal(updater.forwardFlushAck(token, 51), true)
  await new Promise(r => setTimeout(r, 120))
  assert.equal(flushMainCalled, 1, 'the main-process flush runs once every live window acked')
  // a late/duplicate ack after completion is dropped
  assert.equal(updater.forwardFlushAck(token, 51), false)
})

test('w29-updater: init + getStatus exposes the update surface; a check() in a non-active install degrades honestly', async () => {
  assert.equal(updater.init(win), updater, 'init is idempotent and returns the module')
  const gs = updater.getStatus()
  assert.equal(gs.active, true)
  assert.equal(gs.version, '9.9.9-w29')
  assert.equal(gs.status, 'idle')
  autoUpdater.isUpdaterActive = () => false
  const r = await updater.check()
  assert.equal(r.active, false, 'dev/portable builds report inactive — the renderer hides the entry')
  autoUpdater.isUpdaterActive = () => true
})

test('w29-updater: idle → checking → downloading (auto-download on) → ready; a concurrent check cannot clobber the machine', async () => {
  cfg.autoDownloadUpdates = true
  // the state machine: checking → downloading (autoDownload) → progress → downloaded → ready
  autoUpdater.emit('checking-for-update')
  assert.equal(status(), 'checking')
  autoUpdater.emit('update-available', { version: '10.0.0' })
  assert.equal(status(), 'downloading', 'autoDownload on: availability goes straight to downloading')
  autoUpdater.emit('download-progress', { percent: 12.4 })
  const last = sent[sent.length - 1]
  assert.equal(last.status, 'downloading')
  assert.equal(last.info.percent, 12, 'progress percent is rounded for the settings UI')
  // W27/D10: a concurrent periodic check mid-download must not flip the state
  autoUpdater.emit('checking-for-update')
  autoUpdater.emit('update-not-available', {})
  autoUpdater.emit('update-available', { version: '10.0.0' })
  assert.equal(status(), 'downloading', 'guards hold while a download is in flight')
  autoUpdater.emit('update-downloaded', { version: '10.0.0' })
  assert.equal(status(), 'ready')
  assert.equal(sent[sent.length - 1].info.version, '10.0.0')
  // M2b/W12: once 'ready', later checks/errors/progress never downgrade the restart state
  autoUpdater.emit('checking-for-update')
  autoUpdater.emit('update-available', { version: '11.0.0' })
  autoUpdater.emit('download-progress', { percent: 50 })
  autoUpdater.emit('error', new Error('late stray error'))
  assert.equal(status(), 'ready', "'ready' is terminal for this process run")
  assert.equal(sent[sent.length - 1].info.version, '10.0.0')
})

test('w29-updater: quitAndInstall fires the pre-install settle (scheduler flush + LAN stop) and only from the ready state', () => {
  autoUpdater.quitAndInstall = (a, b) => { quitInstallArgs = [a, b] }
  const flushBefore = schedulerCalls.flush
  const stopBefore = lanCalls.stop
  assert.equal(updater.quitAndInstall(), true, 'ready → install proceeds')
  assert.deepEqual(quitInstallArgs, [true, true], 'silent + runAfter are the smooth defaults')
  assert.equal(schedulerCalls.flush, flushBefore + 1, 'the debounced flush is hard-committed before the installer spawns')
  assert.equal(lanCalls.stop, stopBefore + 1, 'the LAN sync round boundary is settled')
})

// ---- sandbox copy: the state machine is module-global and 'ready' is terminal for the
// process, so the manual-download / error / reentry phases run on a FRESH module copy ----
const fsSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'w29-upd2-'))
fs.cpSync(path.resolve(import.meta.dirname, '../../../src/main'), path.join(fsSandbox, 'src', 'main'), { recursive: true })
currentAU = new FakeAutoUpdater()
const AU2 = currentAU
const updater2 = require(path.join(fsSandbox, 'src', 'main', 'updater.js'))
const win2 = { isDestroyed: () => false, webContents: { send: (ch, payload) => { if (ch === 'updater:event') sent.push(payload) } } }
updater2.init(win2)
process.on('exit', () => { try { fs.rmSync(fsSandbox, { recursive: true, force: true }) } catch {} })

test('w29-updater: manual download with consent off — available → downloadUpdate → autoDownload restored', async () => {
  cfg.autoDownloadUpdates = false
  updater2.syncAutoDownload() // the settings toggle hot-applies before the next check
  AU2.emit('checking-for-update')
  assert.equal(status(), 'checking')
  AU2.emit('update-available', { version: '12.0.0' })
  assert.equal(status(), 'available', 'consent off: only a notice, no auto download')
  assert.equal(updater2.getStatus().info.version, '12.0.0')

  let resolveDl
  AU2.downloadUpdate = () => new Promise(res => { resolveDl = res })
  const p1 = updater2.downloadUpdate()
  assert.equal(status(), 'downloading', 'manual click owns the state machine')
  const p2 = updater2.downloadUpdate()
  assert.equal(p2, p1, 'a second click returns the SAME in-flight promise (no double downloadUpdate)')
  // D10: while the manual download is in flight, a concurrent check cannot reset the state
  AU2.emit('update-available', { version: '13.0.0' })
  assert.equal(status(), 'downloading')
  resolveDl()
  assert.equal(await p1, true, 'the download settles true')
  assert.equal(await updater2.downloadUpdate(), false, 'reentry guard cleared: a third click is refused (no longer available-gated)')
  assert.equal(AU2.autoDownload, false, 'C5: the user opt-out is restored after the manual run')
})

test('w29-updater: a failed manual download settles false, records the error state, and the backoff retry recovers', async () => {
  cfg.autoDownloadUpdates = false
  updater2.syncAutoDownload()
  AU2.emit('update-available', { version: '14.0.0' })
  assert.equal(status(), 'available')
  AU2.downloadUpdate = () => new Promise((res, rej) => {
    // real electron-updater fires 'error' and rejects
    setTimeout(() => { AU2.emit('error', new Error('w29 download failed')); rej(new Error('w29 download failed')) }, 10)
  })
  const r = await updater2.downloadUpdate()
  assert.equal(r, false, 'the failed manual download settles false')
  assert.equal(status(), 'error', 'the error event recorded the failure for the settings page')
  assert.match(updater2.getStatus().info.message, /w29 download failed/)
  // the 25ms backoff retry fires check() → our stub resolves → state machine keeps running
  AU2.checkForUpdates = async () => { AU2.emit('update-not-available', {}) }
  await new Promise(r => setTimeout(r, 150))
  assert.equal(status(), 'uptodate', 'the single backoff retry re-checked and recovered the state machine')
})

test('w29-updater: check() reentry — overlapping checks share one in-flight promise; feed errors land in the status bar', async () => {
  let resolveCf
  let cfCalls = 0
  AU2.checkForUpdates = () => new Promise(res => { cfCalls++; resolveCf = res })
  const c1 = updater2.check()
  const c2 = updater2.check()
  assert.equal(cfCalls, 1, 'concurrent manual/timer/retry checks hit the feed exactly once (in-flight dedup)')
  resolveCf()
  const r = await Promise.all([c1, c2])
  assert.equal(r[0].active, true)
  assert.equal(r[0].status, r[1].status, 'both callers observed the same state')
  // error path of check(): rejection recorded when idle (guards don't apply)
  AU2.checkForUpdates = async () => { throw new Error('w29 feed 404') }
  const r2 = await updater2.check()
  assert.equal(r2.status, 'error')
  assert.match(r2.info.message, /w29 feed 404/, 'a manual check failure is broadcast to the settings status bar')
})
