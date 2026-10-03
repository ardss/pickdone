/** C5 (2026-10-02) — downloadUpdate must restore the user's autoDownload opt-out.
 *
 * The manual "Download now" path set autoUpdater.autoDownload=true and never restored the
 * prior value: after ONE manual download the process behaved as auto-download-on until the
 * settings toggle was re-saved. The prior value is now captured and restored in finally
 * (success AND failure).
 *
 * Run: node --test tests/unit/main/c5-updater-autodownload-restore.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Module = require('module')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'c5-updater-'))

let autoUpdaterStub = null
const ELECTRON_STUB = { app: { getPath: () => TMP, getVersion: () => '0.0.0-test' } }
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB
  if (request === 'electron-updater') return { autoUpdater: autoUpdaterStub }
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

function freshUpdater (stub) {
  autoUpdaterStub = stub
  const resolved = require.resolve('../../../src/main/updater.js')
  delete require.cache[resolved]
  return require('../../../src/main/updater.js')
}

function makeAutoUpdater (downloadImpl) {
  const handlers = {}
  return {
    isUpdaterActive: () => true,
    autoDownload: false,
    on: (evt, fn) => { handlers[evt] = fn },
    /** Drive state to 'available' the way the settings flow does (a check finds a new version
     *  with auto-download off). downloadUpdate refuses anything but this state. */
    markAvailable: () => { handlers['update-available']?.({ version: '9.9.9' }) },
    checkForUpdates: async () => ({}),
    downloadUpdate: downloadImpl,
    quitAndInstall: () => {}
  }
}

test('C5: a successful manual download restores the opt-out (autoDownload back to false)', async () => {
  const autoUpdater = makeAutoUpdater(async () => ({}))
  const updater = freshUpdater(autoUpdater)
  updater.init(null)
  autoUpdater.autoDownload = false // user opt-out, "available" state per the settings flow
  autoUpdater.markAvailable()
  assert.equal(await updater.downloadUpdate(), true)
  assert.equal(autoUpdater.autoDownload, false,
    'red before the fix: autoDownload stayed true after the manual download')
})

test('C5: a FAILED manual download restores the opt-out too (finally, not the happy path)', async () => {
  const autoUpdater = makeAutoUpdater(async () => { throw new Error('network down') })
  const updater = freshUpdater(autoUpdater)
  updater.init(null)
  autoUpdater.autoDownload = false
  autoUpdater.markAvailable()
  assert.equal(await updater.downloadUpdate(), false)
  assert.equal(autoUpdater.autoDownload, false, 'failure path restores the prior value as well')
})

test('C5: when auto-download was ON before, the manual download leaves it ON (prior-value semantics)', async () => {
  const autoUpdater = makeAutoUpdater(async () => ({}))
  const updater = freshUpdater(autoUpdater)
  updater.init(null) // init's syncAutoDownload sets autoDownload=true (defaults on)
  assert.equal(autoUpdater.autoDownload, true)
  autoUpdater.markAvailable()
  await updater.downloadUpdate()
  assert.equal(autoUpdater.autoDownload, true, 'restore means PRIOR value, not a blanket false')
})
