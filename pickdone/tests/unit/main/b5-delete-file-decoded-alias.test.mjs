/** B5 (2026-10-02) — 'delete-file' must delete the alias under its DECODED key.
 *
 * url.slice(8) is still percent-encoded, but the device-local alias map is keyed by DECODED
 * names (lan-sync/att-transfer.js decodes before setAlias). Passing the encoded key meant an
 * attachment whose row key contains encodable characters ('a b.png' → local://a%20b.png,
 * conflict-renamed on disk to 'a b-1.png') never had its alias dropped — the stale entry kept
 * resolving the dead key forever and the missing-file guard could never re-pull.
 *
 * Run: node --test tests/unit/main/b5-delete-file-decoded-alias.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Module = require('module')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'b5-att-'))
const ELECTRON_STUB = {
  app: { getPath: () => TMP, getVersion: () => '0.0.0-test' },
  shell: { openPath: async () => '' }
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const attachmentHandlers = require('../../../src/main/handlers/attachments.js')
const attachments = require('../../../src/main/attachments.js')

const MAIN_WC = { id: 'main-wc' }
const eMain = { sender: MAIN_WC }
const handlers = attachmentHandlers({
  isLocked: () => false,
  isSafeExternal: u => false,
  getMainWindow: () => ({ webContents: MAIN_WC, isDestroyed: () => false })
})

const FILES = path.join(TMP, 'files')

/** Seed the LAN-conflict scenario: row key 'a b.png' encoded as local://a%20b.png; the pulled
 *  file with the same name but different content was renamed to 'a b-1.png' and aliased under
 *  the DECODED key (att-transfer.js: decodeURIComponent → setAlias('a b.png', 'a b-1.png')). */
function seedConflict () {
  fs.mkdirSync(FILES, { recursive: true })
  fs.writeFileSync(path.join(FILES, 'a b-1.png'), 'conflict bytes')
  fs.writeFileSync(path.join(FILES, 'aliases.json'), JSON.stringify({ 'a b.png': 'a b-1.png' }))
}

test('B5: delete-file drops the alias under the DECODED key and resolves the rename target', () => {
  seedConflict()
  const r = handlers['delete-file'](eMain, 'local://' + encodeURIComponent('a b.png'))
  assert.equal(r, true)
  assert.equal(fs.existsSync(path.join(FILES, 'a b-1.png')), false,
    'the alias map still resolved the encoded key to the conflict rename target — the file itself was deleted')
  const map = attachments.readAliases()
  assert.equal('a b.png' in map, false, 'red before the fix: deleteAlias got the ENCODED key and the alias survived')
})

test('B5: malformed percent-encoding falls back to the raw key (attachmentPath parity), never throws', () => {
  seedConflict()
  const r = handlers['delete-file'](eMain, 'local://a%zz.png') // invalid encoding → decode fallback
  assert.equal(r, true)
  // 'a%zz.png' has no alias entry and no file — the delete is idempotent success, no crash.
  assert.deepEqual(attachments.readAliases(), { 'a b.png': 'a b-1.png' }, 'unrelated alias entries untouched')
})

test('B5: non-encoded keys keep working (regression guard on the plain-name path)', () => {
  seedConflict()
  fs.writeFileSync(path.join(FILES, 'plain.png'), 'plain')
  fs.writeFileSync(path.join(FILES, 'aliases.json'), JSON.stringify({ 'plain.png': 'plain-1.png' }))
  fs.writeFileSync(path.join(FILES, 'plain-1.png'), 'renamed')
  const r = handlers['delete-file'](eMain, 'local://plain.png')
  assert.equal(r, true)
  assert.equal('plain.png' in attachments.readAliases(), false, 'plain (non-encoded) alias still dropped')
})
