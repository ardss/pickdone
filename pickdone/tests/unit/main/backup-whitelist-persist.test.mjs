/** ES4 (2026-10-02) whitelist persist error propagation:
 *  - saveAllowedBackupDirs used to swallow every write error, and 'pick-backup-dir' returned the
 *    picked path as success unconditionally — the renderer showed "location updated" while the
 *    picked directory silently unregistered itself on the next launch (resolveBackupDir falls
 *    back to the default root for unregistered dirs).
 *  Red before the fix: the persist-failure case returned the path instead of throwing.
 * Run: node --test tests/unit/main/backup-whitelist-persist.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Module = require('module')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'es4-whitelist-'))

// Dialog result is swapped per test via DIALOG_SPY.
let DIALOG_SPY = { canceled: false, filePaths: [] }

const ELECTRON_STUB = {
  app: { getPath: () => TMP, getVersion: () => '0.0.0-test' },
  dialog: { showOpenDialog: async () => DIALOG_SPY }
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const { allowedBackupDirs, loadAllowedBackupDirs, saveAllowedBackupDirs } = require('../../../src/main/backup-dirs')
const backupHandlers = require('../../../src/main/handlers/backup.js')

const MAIN_WC = { id: 'main-wc' }
const eMain = { sender: MAIN_WC }
const noop = () => {}
function freshCtx () {
  return {
    isLocked: () => false,
    app: { getPath: () => TMP },
    getMainWindow: () => ({ webContents: MAIN_WC, isDestroyed: () => false }),
    isSafeExternal: () => true,
    allowWithinRate: () => true,
    i18n: { mt: k => k },
    log: { warn: noop, error: noop, info: noop }
  }
}
function resetWhitelist () {
  allowedBackupDirs.clear()
  try { fs.rmSync(path.join(TMP, 'allowed-backup-dirs.json'), { force: true }) } catch {}
}

test('ES4: pick-backup-dir propagates a whitelist persist failure instead of reporting success', async () => {
  resetWhitelist()
  const picked = path.join(TMP, 'picked-dir')
  DIALOG_SPY = { canceled: false, filePaths: [picked] }
  const origWrite = fs.writeFileSync
  fs.writeFileSync = (file, data, opts) => {
    if (String(file).endsWith('allowed-backup-dirs.json')) {
      const e = new Error('EACCES: permission denied, open whitelist'); e.code = 'EACCES'
      throw e
    }
    return origWrite.call(fs, file, data, opts)
  }
  // D21 (2026-10-02): the whitelist persist moved to writeFileDurable (tmp -> fsync -> rename),
  // so the injected failure must also cover the final rename — that is now the step that
  // publishes the whitelist file.
  const origRename = fs.renameSync
  fs.renameSync = (from, to) => {
    if (String(to).endsWith('allowed-backup-dirs.json')) {
      const e = new Error('EACCES: permission denied, rename whitelist'); e.code = 'EACCES'
      throw e
    }
    return origRename.call(fs, from, to)
  }
  try {
    await assert.rejects(
      () => backupHandlers(freshCtx())['pick-backup-dir'](eMain),
      /failed to persist backup-dir whitelist/,
      'red before the fix: the handler returned the picked path even though the whitelist file was never written'
    )
    // the in-memory set must not keep a registration that did not persist durably
    assert.equal(allowedBackupDirs.has(path.resolve(picked)), false,
      'failed-persist directory must not stay registered in memory')
  } finally {
    fs.writeFileSync = origWrite
    fs.renameSync = origRename
  }
})

test('ES4: pick-backup-dir happy path persists the whitelist and returns the path', async () => {
  resetWhitelist()
  const picked = path.join(TMP, 'picked-ok')
  fs.mkdirSync(picked, { recursive: true })
  DIALOG_SPY = { canceled: false, filePaths: [picked] }
  const r = await backupHandlers(freshCtx())['pick-backup-dir'](eMain)
  assert.equal(r, picked)
  const onDisk = JSON.parse(fs.readFileSync(path.join(TMP, 'allowed-backup-dirs.json'), 'utf8'))
  assert.deepEqual(onDisk, [path.resolve(picked)], 'picked dir must land in the whitelist file')
  allowedBackupDirs.clear()
  loadAllowedBackupDirs()
  assert.ok(allowedBackupDirs.has(path.resolve(picked)), 'next session reloads the registration')
})

test('ES4: saveAllowedBackupDirs returns a structured result; load survives a corrupt file with a warning', () => {
  resetWhitelist()
  allowedBackupDirs.add(path.join(TMP, 'x'))
  const origWrite = fs.writeFileSync
  fs.writeFileSync = () => { throw new Error('ENOSPC: no space left on device') }
  try {
    const res = saveAllowedBackupDirs()
    assert.deepEqual(res, { ok: false, error: 'ENOSPC: no space left on device' },
      'persist failure must be structured, not swallowed')
  } finally { fs.writeFileSync = origWrite }
  allowedBackupDirs.clear()
  fs.writeFileSync(path.join(TMP, 'allowed-backup-dirs.json'), '{not json')
  try {
    loadAllowedBackupDirs() // must not throw on corrupt content
    assert.equal(allowedBackupDirs.size, 0, 'corrupt file yields an empty whitelist, no crash')
  } catch (e) {
    assert.fail('loadAllowedBackupDirs must not throw on corrupt content: ' + e.message)
  }
})
