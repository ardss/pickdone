/**
 * W16 (2026-10-28) pre-install sync-safety settle — regression tests.
 *
 * quitAndInstall runs OUTSIDE the quit chain (electron-updater spawns the NSIS installer whose
 * customInit taskkills the process), so it must re-fire the quit-path flush triggers itself
 * BEFORE spawning the installer:
 *   - scheduler.flushFiredNow() (debounced dbMirror/reminder flush)
 *   - lan-sync-bootstrap.stopSyncForQuit() (in-flight LAN round settle + watermark persist)
 * Both must happen BEFORE autoUpdater.quitAndInstall. The portable / not-ready branches must
 * NOT trigger the settle (or the installer).
 *
 * Run: node --test tests/unit/main/w16-updater-preinstall-settle.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Module = require('module')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'w16-updater-'))

const ELECTRON_STUB = { app: { getPath: () => TMP, getVersion: () => '0.0.0-test' } }
const origLoad = Module._load

function freshUpdater ({ autoUpdater, settleCalls }) {
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return ELECTRON_STUB
    if (request === 'electron-updater') return { autoUpdater }
    if (request === './scheduler' && String(parent && parent.filename || parent || '').endsWith('updater.js')) {
      return { flushFiredNow: () => settleCalls.push('flushFiredNow') }
    }
    if (request === './lan-sync-bootstrap' && String(parent && parent.filename || parent || '').endsWith('updater.js')) {
      return { stopSyncForQuit: () => settleCalls.push('stopSyncForQuit') }
    }
    return origLoad.call(this, request, parent, isMain)
  }
  const resolved = require.resolve('../../../src/main/updater.js')
  delete require.cache[resolved]
  return require('../../../src/main/updater.js')
}

function makeAutoUpdater () {
  const handlers = new Map()
  let installed = false
  return {
    isUpdaterActive: () => true,
    autoDownload: false,
    on: (evt, fn) => { handlers.set(evt, fn) },
    checkForUpdates: async () => ({}),
    downloadUpdate: async () => ({}),
    quitAndInstall: () => { installed = true },
    _fireDownloaded: () => { const h = handlers.get('update-downloaded'); if (h) h({ version: '9.9.9' }) },
    _installed: () => installed,
  }
}

test('W16: quitAndInstall fires the sync-safety settle (flush + LAN round settle) BEFORE the installer', async () => {
  const settleCalls = []
  const autoUpdater = makeAutoUpdater()
  const updater = freshUpdater({ autoUpdater, settleCalls })
  const win = { isDestroyed: () => false, webContents: { send: () => {} } }
  updater.init(win)
  // Drive into the 'ready' state the same way production does.
  autoUpdater._fireDownloaded()
  assert.equal(updater.getStatus().status, 'ready', 'state is ready')

  const ok = updater.quitAndInstall()
  assert.equal(ok, true, 'install handoff accepted')
  assert.equal(autoUpdater._installed(), true, 'installer spawned')
  assert.deepEqual(settleCalls, ['flushFiredNow', 'stopSyncForQuit'], 'settle triggers ran, flush first')
})

test('W16: portable-style refusal (not ready) does NOT settle or install', async () => {
  const settleCalls = []
  const autoUpdater = makeAutoUpdater()
  const updater = freshUpdater({ autoUpdater, settleCalls })
  updater.init({ isDestroyed: () => false, webContents: { send: () => {} } })
  // state stays 'idle' — quitAndInstall must refuse without any settle side effects.
  const ok = updater.quitAndInstall()
  assert.equal(ok, false, 'refused when no update is ready')
  assert.deepEqual(settleCalls, [], 'no settle side effects on refusal')
  assert.equal(autoUpdater._installed(), false, 'installer not spawned')
})

test('W16: settle failures never block the install handoff (best-effort by contract)', async () => {
  const settleCalls = []
  const autoUpdater = makeAutoUpdater()
  // Re-stub with THROWING settle deps: quitAndInstall must still return true and spawn.
  const updater = freshUpdater({ autoUpdater, settleCalls })
  updater.init({ isDestroyed: () => false, webContents: { send: () => {} } })
  autoUpdater._fireDownloaded()
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return ELECTRON_STUB
    if (request === 'electron-updater') return { autoUpdater }
    if (request === './scheduler' && String(parent && parent.filename || parent || '').endsWith('updater.js')) {
      return { flushFiredNow: () => { throw new Error('stub flush boom') } }
    }
    if (request === './lan-sync-bootstrap' && String(parent && parent.filename || parent || '').endsWith('updater.js')) {
      return { stopSyncForQuit: () => { throw new Error('stub settle boom') } }
    }
    return origLoad.call(this, request, parent, isMain)
  }
  const ok = updater.quitAndInstall()
  assert.equal(ok, true, 'install handoff survives settle failures')
  assert.equal(autoUpdater._installed(), true, 'installer spawned despite settle failures')
})

process.on('exit', () => { Module._load = origLoad })
