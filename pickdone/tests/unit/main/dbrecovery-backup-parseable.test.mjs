/**
 * Regression tests for three dbRecovery findings (2026-09-26):
 *   1. json-exists-vs-parseable (P2): attemptDbRecovery used fs.existsSync only on the disaster
 *      backup JSON — a torn/corrupt file yielded source:'json' → "recovery" onto an EMPTY db that
 *      also outranked a usable todos.db.plain-bak. Now the whole file must JSON.parse (with object
 *      shape) to count as a JSON source; an unparseable file falls through to plain-bak (with a
 *      truthful label) or returns null when plain-bak is absent too.
 *   2. B2 filter/plan LWW restamp: restored saved-filter and plan-chip rows carry backup-time
 *      updatedAt; LAN LWW on a newer peer silently reverted the restore. Restore must re-stamp fresh.
 *   3. meta-keys-omitted restore side: the metaState segment re-puts whitelisted meta entries only.
 *
 * Run: node --test tests/unit/main/dbrecovery-backup-parseable.test.mjs
 * Isolation: fresh mkdtemp dirs only; the real %APPDATA%/pickdone is never touched.
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dbRecovery = await import('../../../src/main/dbRecovery.cjs')

let ud
beforeEach(() => { ud = fs.mkdtempSync(path.join(os.tmpdir(), 'pickdone-parseable-')) })
afterEach(() => { try { fs.rmSync(ud, { recursive: true, force: true }) } catch {} })

const writeCorruptDb = () => fs.writeFileSync(path.join(ud, 'todos.db'), 'THIS IS NOT A SQLITE FILE')
const backupJson = () => path.join(ud, 'backups', 'critical-state-backup.json')
const writeBackupJson = (text) => { fs.mkdirSync(path.join(ud, 'backups'), { recursive: true }); fs.writeFileSync(backupJson(), text) }
const writePlainBak = () => fs.writeFileSync(path.join(ud, 'todos.db.plain-bak'), 'PLAINBAK-CONTENT')

test('backupJsonParseable: parseable object → true; torn JSON / array-free garbage / missing file → false', () => {
  writeBackupJson('{"backup":{}}')
  assert.equal(dbRecovery.backupJsonParseable(backupJson()), true)
  writeBackupJson('{"backup": torn')
  assert.equal(dbRecovery.backupJsonParseable(backupJson()), false)
  writeBackupJson('null')
  assert.equal(dbRecovery.backupJsonParseable(backupJson()), false)
  assert.equal(dbRecovery.backupJsonParseable(path.join(ud, 'nope.json')), false)
})

test('corrupt JSON + usable plain-bak → recovery comes from plain-bak, NOT a fake json recovery', () => {
  writeCorruptDb()
  writeBackupJson('{"backup": torn') // exists but unparseable
  writePlainBak()
  const r = dbRecovery.attemptDbRecovery(ud)
  // Pre-fix this returned { source: 'json' } — steering recovery away from the usable bak onto an empty DB.
  assert.equal(r.source, 'plain-bak')
  assert.match(r.label, /unparseable/, 'the dialog label must tell the truth about why plain-bak was used')
  assert.equal(fs.readFileSync(path.join(ud, 'todos.db'), 'utf8'), 'PLAINBAK-CONTENT')
})

test('corrupt JSON + NO plain-bak → nothing recoverable (null), never an empty-db "json" recovery', () => {
  writeCorruptDb()
  writeBackupJson('{"backup": torn')
  assert.equal(dbRecovery.attemptDbRecovery(ud), null)
})

test('a parseable JSON backup still wins as source json (unchanged happy path)', () => {
  writeCorruptDb()
  writeBackupJson(JSON.stringify({ backup: { todoState: JSON.stringify({ schemaV: 1, todoList: [{ taskId: 't1' }] }) } }))
  const r = dbRecovery.attemptDbRecovery(ud)
  assert.equal(r.source, 'json')
})

test('B2: restored saved-filter rows are re-stamped with a fresh updatedAt (LAN LWW cannot self-revert)', () => {
  const before = Date.now()
  const raw = { backup: { filterState: JSON.stringify({ schemaV: 1, list: [{ id: 'f1', name: 'a', updatedAt: 1000 }] }) } }
  fs.mkdirSync(path.join(ud, 'backups'), { recursive: true })
  fs.writeFileSync(backupJson(), JSON.stringify(raw))
  let got = null
  // restoreTasksFromCriticalBackup returns the TASK count (0 here — no todoState segment); the
  // filter rows are observed through the filterPutMany callback, like index.js wires it.
  dbRecovery.restoreTasksFromCriticalBackup(ud, undefined, undefined, undefined, {
    filterPutMany: rows => { got = rows; return rows.length }
  })
  assert.equal(got.length, 1)
  assert.ok(got[0].updatedAt >= before, `restored updatedAt must be fresh (got ${got[0].updatedAt}, before ${before})`)
  assert.equal(got[0].id, 'f1')
})

test('B2: restored plan-chip rows are re-stamped with a fresh updatedAt', () => {
  const before = Date.now()
  const raw = { backup: { planState: JSON.stringify({ schemaV: 1, chips: [{ id: 'p1', taskId: 't1', day: '2026-09-26', mm: 30, updatedAt: 1000 }] }) } }
  fs.mkdirSync(path.join(ud, 'backups'), { recursive: true })
  fs.writeFileSync(backupJson(), JSON.stringify(raw))
  let got = null
  const n = dbRecovery.restoreTasksFromCriticalBackup(ud, undefined, undefined, undefined, {
    planPutMany: chips => { got = chips; return chips.length }
  })
  assert.equal(n, 0, 'task count stays 0 without the todo segment')
  assert.equal(got.length, 1)
  assert.ok(got[0].updatedAt >= before, `restored chip updatedAt must be fresh (got ${got[0].updatedAt}, before ${before})`)
})

test('metaState restore: whitelisted entries round-trip via metaPut; non-whitelisted/empty entries are skipped', () => {
  const raw = { backup: { metaState: JSON.stringify({ schemaV: 1, entries: [
    { key: 'repeatRule:r1', value: '{"freq":"daily"}' },
    { key: 'tomatoEstimateState:t1', value: '3' },
    { key: 'projectDeadline:c1', value: '1780000000000' },
    { key: 'projectCategoryIds', value: '["c1"]' },
    { key: 'catProjectMetaBak.c1', value: 'transient - must be excluded' },
    { key: 'todosVersion', value: '9' },
    { key: 'projectStatus:c2', value: '' }, // empty value → skipped
    { key: 42, value: 'x' } // malformed entry → skipped
  ] }) } }
  const puts = []
  const n = dbRecovery.restoreMetaEntriesFromCriticalBackup(raw, pair => puts.push(pair))
  assert.equal(n, 4)
  assert.deepEqual(puts, [
    ['repeatRule:r1', '{"freq":"daily"}'],
    ['tomatoEstimateState:t1', '3'],
    ['projectDeadline:c1', '1780000000000'],
    ['projectCategoryIds', '["c1"]']
  ])
})

test('metaState restore: schemaV-gated segment and missing callback are honest no-ops', () => {
  const raw = { backup: { metaState: JSON.stringify({ schemaV: 99, entries: [{ key: 'repeatRule:r1', value: 'x' }] }) } }
  assert.equal(dbRecovery.restoreMetaEntriesFromCriticalBackup(raw, () => {}), 0, 'schemaV > supported → refuse the segment')
  const okRaw = { backup: { metaState: JSON.stringify({ schemaV: 1, entries: [{ key: 'repeatRule:r1', value: 'x' }] }) } }
  assert.equal(dbRecovery.restoreMetaEntriesFromCriticalBackup(okRaw, undefined), 0, 'no callback → 0')
})

test('startup restore pipeline re-imports metaState when metaPut is wired (registry integration)', () => {
  const raw = { backup: { metaState: JSON.stringify({ schemaV: 1, entries: [{ key: 'repeatRule:r1', value: '{"freq":"weekly"}' }] }) } }
  fs.mkdirSync(path.join(ud, 'backups'), { recursive: true })
  fs.writeFileSync(backupJson(), JSON.stringify(raw))
  const puts = []
  dbRecovery.restoreTasksFromCriticalBackup(ud, undefined, undefined, undefined, { metaPut: pair => puts.push(pair) })
  assert.deepEqual(puts, [['repeatRule:r1', '{"freq":"weekly"}']])
})
