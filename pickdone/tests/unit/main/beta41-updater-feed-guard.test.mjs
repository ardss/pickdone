/** beta.41 — an install with no update feed must be INERT, not a retry generator.
 *
 * `npm run pack` builds with electron-builder --dir, which emits no app-update.yml. autoUpdater
 * .isUpdaterActive() only consults app.isPackaged, so it returned true, the 4h wake issued a real
 * checkForUpdates(), that threw `ENOENT ... resources\app-update.yml`, classifyUpdateError() called
 * it TRANSIENT and armed up to MAX_ERROR_RETRIES (3) backoff retries. Observed in main.log on
 * 2026-11-20 at 17:52 and 21:52: four ENOENT lines per wake, forever, on a build that can never
 * self-update.
 *
 * Fix has two halves, both asserted here:
 *   1. feedConfigured() makes isActive() false when resources/app-update.yml is absent, so the
 *      periodic check never leaves the process (getStatus().active=false hides the UI entry too).
 *   2. classifyUpdateError() files a missing-feed ENOENT under FEED_MISSING (never retried) as
 *      defence in depth for the case where the feed disappears after boot.
 *
 * Run: node --test tests/unit/main/beta41-updater-feed-guard.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Module = require('module')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'beta41-updater-'))
const RES_NO_FEED = path.join(TMP, 'resources-no-feed')
const RES_WITH_FEED = path.join(TMP, 'resources-with-feed')
fs.mkdirSync(RES_NO_FEED, { recursive: true })
fs.mkdirSync(RES_WITH_FEED, { recursive: true })
fs.writeFileSync(path.join(RES_WITH_FEED, 'app-update.yml'), 'provider: github\n')

const ELECTRON_STUB = { app: { getPath: () => TMP, getVersion: () => '0.0.0-test', isPackaged: true } }
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB
  if (request === 'electron-updater') return { autoUpdater: autoUpdaterStub }
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

let autoUpdaterStub = null
let checkCalls = 0

function makeAutoUpdater (checkImpl) {
  return {
    isUpdaterActive: () => true, // the real lib only checks app.isPackaged — this is the trap
    autoDownload: false,
    on: () => {},
    checkForUpdates: async () => { checkCalls++; return checkImpl ? checkImpl() : {} },
    downloadUpdate: async () => ({}),
    quitAndInstall: () => {}
  }
}

function freshUpdater (stub, resourcesPath) {
  autoUpdaterStub = stub
  checkCalls = 0
  if (resourcesPath === undefined) delete process.resourcesPath
  else process.resourcesPath = resourcesPath
  const resolved = require.resolve('../../../src/main/updater.js')
  delete require.cache[resolved]
  return require('../../../src/main/updater.js')
}

test('beta41: unpacked build with no app-update.yml is inert (active:false, no check fires)', async () => {
  const updater = freshUpdater(makeAutoUpdater(), RES_NO_FEED)
  assert.equal(updater.getStatus().active, false,
    'a build that cannot self-update must not advertise an active updater')
  const r = await updater.check()
  assert.equal(r.active, false)
  assert.equal(checkCalls, 0,
    'red before the fix: the 4h wake reached checkForUpdates() and threw ENOENT')
})

test('beta41: a build that DOES ship app-update.yml keeps updating', async () => {
  const updater = freshUpdater(makeAutoUpdater(), RES_WITH_FEED)
  assert.equal(updater.getStatus().active, true)
  const r = await updater.check()
  assert.equal(r.active, true)
  assert.equal(checkCalls, 1, 'the feed exists — the guard must not disable real updates')
})

test('beta41: missing-feed ENOENT is classified FEED_MISSING, so it is never backed off', async () => {
  const enoent = Object.assign(
    new Error("ENOENT: no such file or directory, open '/x/resources/app-update.yml'"),
    { code: 'ENOENT' }
  )
  // feed present at boot (active), then the file vanishes → the check throws
  const updater = freshUpdater(makeAutoUpdater(async () => { throw enoent }), RES_WITH_FEED)
  await updater.check()
  const status = updater.getStatus()
  assert.equal(status.status, 'error')
  assert.equal(status.lastCheckError.kind, 'FEED_MISSING',
    'red before the fix: kind was TRANSIENT and armed 3 retries per wake')
})

test('beta41: unknown environment (no process.resourcesPath) leaves isUpdaterActive() as the gate', async () => {
  const updater = freshUpdater(makeAutoUpdater(), undefined)
  assert.equal(updater.getStatus().active, true,
    'node --test / ad-hoc dev runs cannot judge the feed; do not disable updates there')
})
