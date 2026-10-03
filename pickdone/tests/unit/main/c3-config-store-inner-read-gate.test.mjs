/** C3 (2026-10-02) — writeConfig must re-consult the read-failed gate AFTER the inner read.
 *
 * The gate was checked at writeConfig ENTRY only: when the inner readConfig() itself failed
 * (transient-IO budget exhausted, or a failed quarantine), _readFailed got set mid-write yet
 * defaults+patch were persisted anyway — clobbering the very on-disk state the gate protects.
 * The write now bails with the same degrade contract (return null, write nothing).
 *
 * Run: node --test tests/unit/main/c3-config-store-inner-read-gate.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const cfg = require('../../../src/main/config-store.js')

function withDir () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-cfg-'))
  cfg.__setConfigDir(dir)
  return dir
}

function ebusyAllConfigReads () {
  const origRead = fs.readFileSync
  fs.readFileSync = (p, enc) => {
    if (String(p).endsWith('config.json')) {
      const e = new Error('EBUSY: resource busy'); e.code = 'EBUSY'
      throw e
    }
    return origRead(p, enc)
  }
  return () => { fs.readFileSync = origRead }
}

test('C3: an inner readConfig failure during writeConfig bails — on-disk state is NOT clobbered', () => {
  const dir = withDir()
  const file = path.join(dir, 'config.json')
  // Real prior state on disk (the asset the gate exists to protect).
  fs.writeFileSync(file, JSON.stringify({ locale: 'en', winBounds: { width: 900 } }), 'utf8')
  assert.equal(cfg.isReadFailed(), false, 'entry gate clear at start')
  const restore = ebusyAllConfigReads()
  try {
    // Entry gate passes (_readFailed false), but the INNER readConfig exhausts the transient
    // budget → _readFailed set mid-write. The write must bail, not persist defaults+patch.
    const r = cfg.writeConfig({ locale: 'fr' })
    assert.equal(r, null, 'red before the fix: defaults+patch were persisted over the unreadable file')
    assert.equal(cfg.isReadFailed(), true)
  } finally { restore() }
  // Nothing was clobbered: the prior on-disk config survived untouched.
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(onDisk.locale, 'en', 'the prior on-disk config survived untouched')
  assert.equal(onDisk.winBounds.width, 900)
  assert.ok(!('shortcutKeySettings' in onDisk), 'no amputated defaults object was merged in')
  // Recovery: a successful read clears the gate and writes resume normally.
  assert.equal(cfg.readConfig().locale, 'en')
  assert.equal(cfg.isReadFailed(), false)
  const after = cfg.writeConfig({ locale: 'fr' })
  assert.equal(after.locale, 'fr', 'normal writes resume after a successful read')
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).winBounds.width, 900, 'merge still preserves prior keys')
})
