/**
 * D22 (P2 2026-10-02) — relay-state.json durability + corrupt-load quarantine.
 *
 * Red before the fix:
 *   1. fileStore.persist was a bare writeFileSync (no tmp, no fsync, no rename) while the
 *      comment claimed "fsync-on-mutation via atomic rename" — a crash mid-write could leave a
 *      TORN relay-state.json.
 *   2. The startup load was an unguarded JSON.parse — a torn/corrupt file crashed the relay at
 *      boot; a still-parseable partial file could REGRESS seq and cause client replay storms.
 *
 * Green after the fix: writes go through durable-fs writeFileDurable (tmp -> fsync -> rename);
 * a corrupt load is quarantined to relay-state.json.bad and the relay boots FRESH.
 * Run: node --test tests/unit/sync/d22-relay-durable-state.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { fileStore } = require('../../../server/sync-relay.mjs')

function tmpDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'd22-relay-'))
}

test('D22: a torn relay-state.json boots FRESH with a .bad quarantine instead of crashing', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'relay-state.json')
  fs.writeFileSync(file, '{"seq":41,"envelopes":[{"serverSeq":41,') // torn mid-write
  const store = fileStore(dir)
  assert.equal(store.kind, 'file')
  assert.equal(store.lastSeq(), 0, 'the relay starts fresh, it does not crash or load garbage')
  assert.ok(fs.existsSync(file + '.bad'), 'the corrupt file is quarantined to relay-state.json.bad')
  assert.equal(fs.existsSync(file), false, 'the live path is free for the next persist')
  // The relay keeps working: a mutation persists a clean state file again.
  store.appendEnvelope('acc', 'op1', '{}')
  const reloaded = fileStore(dir)
  assert.equal(reloaded.lastSeq(), 1, 'the post-quarantine persist is durable and reloadable')
})

test('D22: a healthy relay-state.json still loads (no false quarantine)', () => {
  const dir = tmpDir()
  const s1 = fileStore(dir)
  s1.appendEnvelope('acc', 'op1', 'e1')
  s1.appendEnvelope('acc', 'op2', 'e2')
  const s2 = fileStore(dir)
  assert.equal(s2.lastSeq(), 2)
  assert.equal(fs.existsSync(path.join(dir, 'relay-state.json.bad')), false)
})

test('D22: persists leave no .dtmp residue (tmp -> fsync -> rename semantics)', () => {
  const dir = tmpDir()
  const store = fileStore(dir)
  store.appendEnvelope('acc', 'op1', '{}')
  store.flush()
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.endsWith('.dtmp')), [],
    'red before the fix: bare writeFileSync had no tmp lifecycle at all')
})

test('D22: source anchor — persist goes through writeFileDurable, not a bare writeFileSync', () => {
  const src = fs.readFileSync(new URL('../../../server/sync-relay.mjs', import.meta.url), 'utf8')
  assert.ok(src.includes("import { writeFileDurable } from '../src/main/durable-fs.js'"), 'durable write helper imported')
  assert.ok(src.includes('writeFileDurable(file,'), 'persist routes through writeFileDurable')
  assert.ok(!src.includes('writeFileSync(file,'), 'red before the fix: bare writeFileSync on relay-state.json')
  assert.ok(/catch \(err\)[\s\S]*?renameSync\(file, bad\)/.test(src), 'corrupt load is quarantined via rename to .bad')
})
