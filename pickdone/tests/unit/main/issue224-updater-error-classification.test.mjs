/* Issue #224 — updater error-classification + bounded-retry regression tests (autoUpdater stubbed).
 *
 * beta.24 regression being pinned: a GitHub tag with NO published Release assets made the feed
 * (…/releases/download/v0.4.0-beta.24/latest.yml) 404; the pre-fix markUpdateError armed a 30s
 * backoff whose own rejected checkForUpdates re-fired the autoUpdater 'error' event, arming
 * ANOTHER backoff — an unbounded timer chain re-requesting the 404 every 30s (main.log 02:02-02:04).
 *
 * Covers, against the REAL updater module (electron / electron-log / electron-updater stubbed via
 * Module._load, same pattern as w29-updater-terminal-transitions.test.mjs):
 *   - fix 1 (P0): a persistent FEED_MISSING failure (404/ENOTFOUND) NEVER arms the backoff retry —
 *     the timer chain is bounded at ZERO re-checks even when every check rejects
 *   - fix 1 (P0): a persistent TRANSIENT failure retries with backoff but at most MAX_ERROR_RETRIES
 *     (3) times per wake, then stops — the re-check count is finite even with the feed erroring forever
 *   - fix 2 (P0): a check()-path 404 classifies as FEED_MISSING (distinguishable from TRANSIENT),
 *     recorded in state.lastCheckError; an identical repeated FEED_MISSING broadcasts only ONCE
 *     (no error-toast storm on every silent poll)
 *   - fix 3 (P3): getStatus()/check() expose lastCheckError { kind, message, at }; a successful
 *     check clears it
 *   - the retry calls runCheck internally so it does not reset its own budget
 *
 * Run: node --test tests/unit/main/issue224-updater-error-classification.test.mjs
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'issue224-updater-'))
delete process.env.PORTABLE_EXECUTABLE_DIR
delete process.env.PICKDONE_NO_AUTOUPDATE
process.env.PICKDONE_UPDATER_RETRY_MS = '40' // shorten the backoff window for the retry tests

// ---- autoUpdater stub: an event registry we fire by hand ----
const auHandlers = {}
const auCalls = { checkForUpdates: 0 }
let checkBehavior = async () => ({}) // injectable checkForUpdates outcome
let emitErrorOnReject = false // real electron-updater ALSO emits 'error' when checkForUpdates rejects — the storm's fuel
const autoUpdater = {
  isUpdaterActive: () => true,
  autoDownload: undefined,
  on (ev, cb) { (auHandlers[ev] = auHandlers[ev] || []).push(cb) },
  emit (ev, arg) { for (const cb of auHandlers[ev] || []) cb(arg) },
  async checkForUpdates () {
    auCalls.checkForUpdates++
    try { return await checkBehavior() } catch (e) {
      if (emitErrorOnReject) autoUpdater.emit('error', e) // replicate the real event pairing
      throw e
    }
  },
}
const LOG_STUB = {
  info: () => {}, warn: () => {}, error: () => {},
  hooks: [], transports: { file: {}, console: {} },
}
const ELECTRON_STUB = { app: { getPath: () => TMP, getVersion: () => '0.4.0-beta.24' } }
const fakeWin = { isDestroyed: () => false, webContents: { sends: [], send (ch, p) { this.sends.push([ch, p]) } } }

const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB
  if (request === 'electron-log') return LOG_STUB
  if (request === 'electron-updater') return { autoUpdater }
  if (request === './quit-ack') return { createQuitAckTracker: () => ({}), runFlushRound: () => {} }
  if (request === './scheduler') return { flushFiredNow: () => {} }
  if (request === './lan-sync-bootstrap') return { stopSyncForQuit: async () => {} }
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const updater = require(path.join(ROOT, 'src', 'main', 'updater.js'))

const sleep = ms => new Promise(r => setTimeout(r, ms))
const feed404 = () => {
  const e = new Error('HttpError: 404 Not Found GET https://github.com/pickdone/pickdone/releases/download/v0.4.0-beta.24/latest.yml')
  e.statusCode = 404
  return e
}
const transient = () => {
  const e = new Error('socket hang up (ECONNRESET)')
  e.code = 'ECONNRESET'
  return e
}

test('classifyUpdateError: 404/ENOTFOUND/no-published-versions are FEED_MISSING; network jitter is TRANSIENT', () => {
  assert.equal(updater.classifyUpdateError(feed404()), 'FEED_MISSING')
  const dns = new Error('getaddrinfo ENOTFOUND github.com'); dns.code = 'ENOTFOUND'
  assert.equal(updater.classifyUpdateError(dns), 'FEED_MISSING')
  assert.equal(updater.classifyUpdateError(new Error('No published versions on GitHub')), 'FEED_MISSING')
  assert.equal(updater.classifyUpdateError(transient()), 'TRANSIENT')
  assert.equal(updater.classifyUpdateError(new Error('certificate has expired')), 'TRANSIENT')
})

test('fix 1 (P0): a persistent FEED_MISSING failure arms ZERO backoff re-checks — the 30s storm is dead', async () => {
  updater.init(fakeWin)
  emitErrorOnReject = true // the real-world pairing: every rejection also fires the 'error' event
  checkBehavior = async () => { throw feed404() }

  const r = await updater.check() // the wake: periodic/manual entry
  const afterWake = auCalls.checkForUpdates
  assert.equal(r.status, 'error')
  assert.equal(r.lastCheckError.kind, 'FEED_MISSING', 'a 404 feed is classified, not a generic network failure')

  await sleep(400) // ≫ several 40ms backoff windows: the pre-fix bug re-armed here indefinitely
  assert.equal(auCalls.checkForUpdates, afterWake, 'NO backoff re-check was armed for a missing feed (was: unbounded 30s chain)')
  emitErrorOnReject = false
})

test('fix 1 (P0): a persistent TRANSIENT failure retries with backoff but is CAPPED per wake', async () => {
  emitErrorOnReject = true // rejection pairs with the 'error' event, like production
  checkBehavior = async () => { throw transient() }

  await updater.check() // the wake resets the budget
  const afterWake = auCalls.checkForUpdates
  await sleep(600) // ≫ 3 × 40ms backoff windows: the cap must bind long before this elapses
  const rechecks = auCalls.checkForUpdates - afterWake
  assert.ok(rechecks >= 1, 'transient jitter still self-heals via backoff re-checks')
  assert.ok(rechecks <= 3, `the re-check chain is bounded (got ${rechecks}, pre-fix this grew without limit)`)
  assert.equal(updater.getStatus().lastCheckError.kind, 'TRANSIENT')
  emitErrorOnReject = false
  checkBehavior = async () => ({})
})

test("fixes 2+3: check()-path 404 records lastCheckError {kind,message,at}; getStatus exposes it; success clears it; repeat FEED_MISSING broadcasts ONCE", async () => {
  checkBehavior = async () => { throw feed404() }
  const before = fakeWin.webContents.sends.length
  const r = await updater.check()
  assert.equal(r.status, 'error')
  assert.equal(r.lastCheckError.kind, 'FEED_MISSING')
  assert.ok(r.lastCheckError.message.includes('404'))
  assert.ok(Number.isFinite(r.lastCheckError.at), 'the failure is timestamped')
  assert.equal(updater.getStatus().lastCheckError.kind, 'FEED_MISSING', 'state carries the classified failure, not just a raw message')
  const oneShotBroadcasts = fakeWin.webContents.sends.length - before

  // the SAME failure again (next silent poll): state refreshes, but NO new error broadcast (no toast storm)
  const r2 = await updater.check()
  assert.equal(r2.status, 'error')
  assert.equal(fakeWin.webContents.sends.length - before - oneShotBroadcasts, 0, 'an identical repeat FEED_MISSING is recorded but not re-broadcast')
  assert.equal(updater.getStatus().lastCheckError.kind, 'FEED_MISSING')

  // a DIFFERENT transient failure broadcasts again (it is a new, actionable state)
  checkBehavior = async () => { throw transient() }
  await updater.check()
  assert.equal(updater.getStatus().lastCheckError.kind, 'TRANSIENT')
  assert.ok(fakeWin.webContents.sends.length > before + oneShotBroadcasts, 'a kind change re-broadcasts')

  // a successful check clears the stale classified failure (the stub pairs the resolved check with
  // the real module's update-not-available event, which is what flips status off 'error')
  checkBehavior = async () => { autoUpdater.emit('update-not-available', { version: '0.4.0-beta.24' }); return {} }
  const ok = await updater.check()
  assert.equal(ok.status, 'uptodate')
  assert.equal(updater.getStatus().lastCheckError, null, 'a successful check clears lastCheckError')
})
