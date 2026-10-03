/** C2 + C7 (2026-10-02) — backup handler ingress cap + dedup twin compare.
 *
 * C2: 'write-critical-state-backup' / 'run-auto-backup' accepted unbounded renderer JSON;
 * both now clamp at the handler door (>64MB → coded PAYLOAD_TOO_LARGE rejection).
 * C7: the dedup twin compare used a full readFileSync + whole-string equality on the main
 * thread; now a size short-circuit plus a chunked positional compare (twinMatches).
 *
 * Run: node --test tests/unit/main/backup-ingress-cap-dedup-compare.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Module = require('module')

// electron stub (backup.js → dbRecovery/i18n/backup-dirs → electron.app.getPath)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-backup-'))
const ELECTRON_STUB = { app: { getPath: () => TMP, getVersion: () => '0.0.0-test' } }
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const backupHandlers = require('../../../src/main/handlers/backup.js')
const { assertIngressSize, twinMatches, INGRESS_MAX_BYTES } = backupHandlers

const MAIN_WC = { id: 'main-wc' }
const eMain = { sender: MAIN_WC }
const ctx = {
  isLocked: () => false,
  app: { getPath: () => TMP },
  getMainWindow: () => ({ webContents: MAIN_WC, isDestroyed: () => false })
}

test('C2: assertIngressSize admits normal payloads and rejects >64MB with a coded error', () => {
  assert.doesNotThrow(() => assertIngressSize('{"ok":1}', 'ch'), 'normal payload admitted')
  assert.doesNotThrow(() => assertIngressSize(null, 'ch'), 'non-string collapses to 0 bytes (other guards own typing)')
  const huge = 'a'.repeat(INGRESS_MAX_BYTES + 1)
  try {
    assertIngressSize(huge, 'write-critical-state-backup')
    assert.fail('must have thrown')
  } catch (err) {
    assert.equal(err.code, 'PAYLOAD_TOO_LARGE', 'red before the fix: no cap existed')
    assert.match(err.message, /write-critical-state-backup/)
  }
})

test('C2: the write-critical-state-backup handler clamps at the door', () => {
  const handlers = backupHandlers(ctx)
  const huge = 'x'.repeat(INGRESS_MAX_BYTES + 1)
  assert.throws(() => handlers['write-critical-state-backup'](eMain, huge),
    err => err.code === 'PAYLOAD_TOO_LARGE')
})

test('C2: the run-auto-backup handler clamps with the coded rejection intact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-backups-root-'))
  process.env.TODO_BACKUP_DIR = dir
  const handlers = backupHandlers(ctx)
  const huge = 'y'.repeat(INGRESS_MAX_BYTES + 1)
  // raised OUTSIDE the handler's try: the coded error must not degrade to {ok:false,error}
  assert.throws(() => handlers['run-auto-backup'](eMain, huge, { recent: 2 }),
    err => err.code === 'PAYLOAD_TOO_LARGE')
  // nothing was written
  assert.equal(fs.readdirSync(dir).filter(f => /^(auto|evt)-/.test(f)).length, 0)
})

test('C7: twinMatches — equal content true; different length false WITHOUT reading the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c7-twin-'))
  const file = path.join(dir, 'twin.json')
  fs.writeFileSync(file, '{"a":1}')
  assert.equal(twinMatches(fs, file, '{"a":1}'), true)
  // different length: the statSync short-circuit must fire before any content read
  let reads = 0
  const countingFs = Object.assign({}, fs, { openSync: (...a) => { reads++; return fs.openSync(...a) } })
  assert.equal(twinMatches(countingFs, file, '{"a":22}'), false)
  assert.equal(reads, 0, 'red before the fix: full readFileSync ran even when sizes differ')
})

test('C7: twinMatches — chunked positional compare (equal across the 1MB boundary, unequal later)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c7-twin-'))
  const file = path.join(dir, 'big.json')
  const payload = 'k'.repeat(2 * 1024 * 1024 + 7) + '!tail' // spans 3 chunks
  fs.writeFileSync(file, payload)
  assert.equal(twinMatches(fs, file, payload), true, 'multi-chunk equal content matches')
  // flip one byte inside the LAST chunk — must compare false (and be found positionally)
  const mutated = payload.slice(0, payload.length - 2) + 'X' + payload.slice(payload.length - 1)
  assert.equal(twinMatches(fs, file, mutated), false, 'byte-level difference inside a later chunk detected')
  // missing file → false, never throws
  assert.equal(twinMatches(fs, path.join(dir, 'gone.json'), payload), false)
})

test('C7: the run-auto-backup dedup path still dedups identical content through twinMatches', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c7-backups-root-'))
  process.env.TODO_BACKUP_DIR = dir
  const handlers = backupHandlers(ctx)
  const snapshot = JSON.stringify({ todos: Array.from({ length: 50 }, (_, i) => ({ id: i })) })
  const first = handlers['run-auto-backup'](eMain, snapshot, { recent: 4 })
  assert.equal(first.ok, true)
  const second = handlers['run-auto-backup'](eMain, snapshot, { recent: 4 })
  assert.equal(second.dedup, true, 'equal content dedups (chunked compare says equal)')
  const changed = handlers['run-auto-backup'](eMain, snapshot + ' ', { recent: 4 })
  assert.equal(changed.dedup, undefined, 'one-byte change (same length!) is NOT deduped')
  assert.equal(changed.ok, true)
})
