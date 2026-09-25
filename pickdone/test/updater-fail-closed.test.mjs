/* updater-config-read-fail-open (2026-09-26): syncAutoDownload failed OPEN — on a config read
 * failure the updater auto-downloaded updates even though the user's autoDownloadUpdates=false
 * opt-out was on file. The real fail-open path is readConfig's defaults-on-corruption (an
 * unreadable config resets every preference); the updater now fails CLOSED when the opt-out
 * state is UNKNOWABLE (known-failed read via config-store.isReadFailed, or a throw), while
 * keeping the defaults-on behavior for a MISSING config (first install) and for a
 * quarantinable corruption (documented config-store semantics: keys are lost, not destroyed).
 * Plain node: electron-updater / electron / electron-log stubbed, config-store pointed at a
 * fresh temp dir via __setConfigDir — never the real %APPDATA%.
 * NOTE: pickdone/test/ is NOT auto-discovered by tests/run-all.mjs; run directly:
 * node --test test/updater-fail-closed.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const Module = require_('module')

const autoUpdaterStub = { autoDownload: null, isUpdaterActive: () => false }
const stubs = {
  electron: { app: { getPath: () => os.tmpdir(), isPackaged: false } },
  'electron-updater': { autoUpdater: autoUpdaterStub },
  'electron-log': { info () {}, warn () {}, error () {} },
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (stubs[request]) return stubs[request]
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const updater = require_('../src/main/updater.js')
const configStore = require_('../src/main/config-store.js')

function freshDir () { return fs.mkdtempSync(path.join(os.tmpdir(), 'upd-failclosed-')) }

test('opted-out readable config keeps auto-download OFF (existing behavior preserved)', () => {
  const dir = freshDir()
  configStore.__setConfigDir(dir)
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ autoDownloadUpdates: false }))
  updater.syncAutoDownload()
  assert.equal(autoUpdaterStub.autoDownload, false, 'an explicit opt-out must be honored')
})

test('missing config keeps the defaults-on default (first install, not a fail-open)', () => {
  configStore.__setConfigDir(freshDir())
  updater.syncAutoDownload()
  assert.equal(autoUpdaterStub.autoDownload, true, 'no config = no opt-out = default on')
})

test('corrupt config that FAILS to quarantine: auto-download is refused (fail CLOSED — THE FIX)', () => {
  const dir = freshDir()
  configStore.__setConfigDir(dir)
  // config.json is a DIRECTORY (read EISDIR) and the quarantine target .bad exists as a
  // non-empty directory too (rename fails) — config-store sets _readFailed=true.
  fs.mkdirSync(path.join(dir, 'config.json'))
  fs.mkdirSync(path.join(dir, 'config.json.bad'))
  fs.writeFileSync(path.join(dir, 'config.json.bad', 'evidence.txt'), 'x')
  assert.equal(configStore.isReadFailed(), false, 'precondition: clean state')
  updater.syncAutoDownload()
  assert.equal(configStore.isReadFailed(), true, 'precondition: quarantine failed, reads known-broken')
  assert.equal(autoUpdaterStub.autoDownload, false,
    'THE FIX: with a known-failed config read the updater must NOT auto-download (pre-fix: true)')
})

test('corrupt config that quarantines successfully: defaults apply (documented residual, default on)', () => {
  const dir = freshDir()
  configStore.__setConfigDir(dir)
  fs.writeFileSync(path.join(dir, 'config.json'), '{ truncated json')
  updater.syncAutoDownload()
  assert.equal(configStore.isReadFailed(), false)
  assert.equal(fs.existsSync(path.join(dir, 'config.json.bad')), true, 'evidence quarantined')
  assert.equal(autoUpdaterStub.autoDownload, true, 'residual: defaults-on matches the app-wide config semantics (documented)')
})
