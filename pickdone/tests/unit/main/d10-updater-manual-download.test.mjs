/** D10 (2026-09-27): updater state race. A periodic/error-retry check() overlapping a MANUAL
 *  downloadUpdate used to clobber state: 'update-available' reset status to 'available' and
 *  replaced info mid-download, so a second downloadUpdate double-called autoUpdater.downloadUpdate.
 *  While a manual download is in flight its status/info are owned by it, and downloadUpdate is
 *  idempotent (returns the in-flight promise).
 * Run: node --test tests/unit/main/d10-updater-manual-download.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Module = require('module')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'd10-updater-'))

// Persistent interception for the whole file: 'electron' is a path string under plain node, and
// updater.getStatus() reads require('electron').app at CALL time — the stub must stay installed.
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

test('d10: update-available during a manual download cannot clobber status; downloadUpdate is idempotent', async () => {
  let downloadCalls = 0
  let availHandler = null
  let checkHandler = null
  const autoUpdater = {
    isUpdaterActive: () => true,
    autoDownload: false,
    on: (evt, fn) => { if (evt === 'update-available') availHandler = fn; if (evt === 'checking-for-update') checkHandler = fn },
    checkForUpdates: async () => ({}),
    downloadUpdate: async () => { downloadCalls++; await new Promise(r => setTimeout(r, 80)); return {} },
    quitAndInstall: () => {},
  }
  const updater = freshUpdater(autoUpdater)
  updater.init(null)
  // init()'s syncAutoDownload() set autoDownload=true (no config → default on); the scenario is the
  // "new version found but NOT auto-downloaded" state, so flip the toggle like the settings page.
  autoUpdater.autoDownload = false

  // state → 'available' (new version found, auto-download off)
  availHandler({ version: '9.9.9' })
  assert.equal(updater.getStatus().status, 'available')

  // user clicks "Download now"; WHILE it is in flight a periodic check fires update-available
  const p1 = updater.downloadUpdate()
  assert.equal(updater.getStatus().status, 'downloading')
  availHandler({ version: '9.9.9' }) // would reset status to 'available' before the fix
  checkHandler?.() // would reset status to 'checking' before the fix
  assert.equal(updater.getStatus().status, 'downloading', 'red before the fix: mid-download status clobbered by the event')

  // second click while the download is in flight: idempotent, no second autoUpdater.downloadUpdate
  const p2 = updater.downloadUpdate()
  assert.equal(p2, p1, 'second click returns the SAME in-flight promise')
  assert.equal(await p1, true)
  assert.equal(await p2, true)
  assert.equal(downloadCalls, 1, 'red before the fix: status reset re-opened the gate → double downloadUpdate call')
})

test('d10: after the manual download settles the gate reopens; normal download path unchanged', async () => {
  let availHandler = null
  const autoUpdater = {
    isUpdaterActive: () => true,
    autoDownload: false,
    on: (evt, fn) => { if (evt === 'update-available') availHandler = fn },
    checkForUpdates: async () => ({}),
    downloadUpdate: async () => ({}),
    quitAndInstall: () => {},
  }
  const updater = freshUpdater(autoUpdater)
  updater.init(null)
  autoUpdater.autoDownload = false
  availHandler({ version: '9.9.9' })
  assert.equal(updater.getStatus().status, 'available', 'event path works normally when no download is in flight')
  assert.equal(await updater.downloadUpdate(), true, 'normal download path unchanged when idle')
})
