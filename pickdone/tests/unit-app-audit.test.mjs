/**
 * Unit tests for the app-side audit trail (src/main/audit.js).
 * Verifies:
 *  1. recordAppOp appends a valid JSONL line with the exact CLI audit schema fields
 *  2. rotation triggers at the injected (tiny) threshold and rolls to cli-audit.jsonl.1
 *  3. the op→action mapping matches the CLI audit vocabulary; reads are filtered by shouldAudit
 *  4. the db.settingsState settings-mirror blob is skipped (renderer persists it on every change)
 *  5. upsert refinement via the pre-write row: add/done/undo/delete/restore/subtask/edit
 *  6. audit is best-effort: garbage params never throw
 * Run: node --test tests/unit-app-audit.test.mjs
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const appAudit = require('../src/main/audit.js')

let tmpDir = ''

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-audit-test-'))
  appAudit.setDirResolver(() => tmpDir)
})

afterEach(() => {
  appAudit.resetForTests()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function readLines () {
  const file = path.join(tmpDir, 'cli-audit.jsonl')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
}

test('auditFile resolves inside the injected directory with the CLI file name', () => {
  const file = appAudit.auditFile()
  assert.equal(path.dirname(file), tmpDir)
  assert.equal(path.basename(file), 'cli-audit.jsonl')
})

test('recordAppOp appends a valid JSONL line with the exact CLI schema fields', () => {
  appAudit.recordAppOp('hardDelete', 'task-1')
  const lines = readLines()
  assert.equal(lines.length, 1)
  const e = lines[0]
  assert.equal(typeof e.ts, 'number')
  assert.match(e.time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  assert.equal(e.actor, 'app')
  assert.equal(e.action, 'purge')
  assert.deepEqual(e.argv, ['hardDelete'])
  assert.deepEqual(e.targets, [{ taskId: 'task-1' }])
  assert.deepEqual(e.changes, [])
  assert.equal('note' in e, false) // note omitted unless set, same as cli/audit.js
})

test('read ops and unknown ops leave no line (shouldAudit filters at the decision point)', () => {
  appAudit.recordAppOp('getAll', {})
  appAudit.recordAppOp('queryTodos', { deleted: 0 })
  appAudit.recordAppOp('getMeta', 'todosVersion')
  appAudit.recordAppOp('getById', 't1')
  appAudit.recordAppOp('getAllCategories')
  appAudit.recordAppOp('filterList')
  appAudit.recordAppOp('countAll')
  appAudit.recordAppOp('planAll')
  appAudit.recordAppOp('tomatoAll')
  appAudit.recordAppOp('notARealOp', {})
  assert.equal(readLines().length, 0)
  for (const op of ['getById', 'getAll', 'queryTodos', 'getMeta', 'getAllCategories', 'filterList', 'countAll', 'countSeedTodos', 'planAll', 'tomatoAll']) {
    assert.equal(appAudit.shouldAudit(op, {}), false, op)
  }
  assert.equal(appAudit.shouldAudit('upsert', { taskId: 't' }), true)
  assert.equal(appAudit.shouldAudit('noSuchOp', {}), false)
})

test('db.settingsState mirror blob is skipped; other meta keys are kept and refined', () => {
  appAudit.recordAppOp('setMeta', ['db.settingsState', JSON.stringify({ theme: 'dark' })])
  assert.equal(appAudit.shouldAudit('setMeta', ['db.settingsState', '{}']), false)
  assert.equal(readLines().length, 0)

  appAudit.recordAppOp('setMeta', ['repeatRule:r1', JSON.stringify({ mode: 'daily' })])
  appAudit.recordAppOp('setMeta', ['repeatRule:r2', ''])
  appAudit.recordAppOp('setMeta', ['projectDeadline:c1', '1757500000000'])
  appAudit.recordAppOp('setMeta', ['userTags', JSON.stringify(['a'])])
  appAudit.recordAppOp('deleteMeta', ['planChipsSnapshot:t9'])

  const lines = readLines()
  assert.deepEqual(lines.map(l => l.action), ['repeat.on', 'repeat.off', 'project.deadline', 'meta.set', 'meta.rm'])
  assert.equal(lines[0].note, 'meta key repeatRule:r1')
  assert.equal(lines[4].note, 'meta key removed: planChipsSnapshot:t9')
  assert.deepEqual(lines[3].targets, [])
})

test('upsert refinement via the pre-write row: add/done/undo/delete/restore/subtask/edit', () => {
  const T = 'task-1'
  appAudit.recordAppOp('upsert', { taskId: T, taskContent: 'new', status: 'add' }, { before: null })
  appAudit.recordAppOp('upsert', { taskId: T, taskContent: 'x', complete: true, updateTime: 2 }, { before: { taskId: T, taskContent: 'x', complete: false, updateTime: 1 } })
  appAudit.recordAppOp('upsert', { taskId: T, taskContent: 'x', complete: false, updateTime: 3 }, { before: { taskId: T, taskContent: 'x', complete: true, updateTime: 2 } })
  appAudit.recordAppOp('upsert', { taskId: T, taskContent: 'x', delete: false, status: 'update', updateTime: 4 }, { before: { taskId: T, taskContent: 'x', delete: 1, updateTime: 3 } })
  appAudit.recordAppOp('upsert', { taskId: T, taskContent: 'x', delete: 1, deletedAt: 9, status: 'delete', updateTime: 5 }, { before: { taskId: T, taskContent: 'x', delete: 0, updateTime: 4 } })
  appAudit.recordAppOp('upsert', { taskId: T, taskContent: 'x', subtasks: '[{"text":"a"}]', updateTime: 6 }, { before: { taskId: T, taskContent: 'x', subtasks: '[]', updateTime: 5 } })
  appAudit.recordAppOp('upsert', { taskId: T, taskContent: 'renamed', updateTime: 7 }, { before: { taskId: T, taskContent: 'x', updateTime: 6 } })
  appAudit.recordAppOp('upsert', { taskId: T, taskContent: 'y', status: 'update', updateTime: 8 }, { before: null })

  const actions = readLines().map(l => l.action)
  assert.deepEqual(actions, ['add', 'done', 'undo', 'restore', 'delete', 'subtask', 'edit', 'edit'])
})

test('upsert changes carry a filtered semantic snapshot of before/after', () => {
  appAudit.recordAppOp(
    'upsert',
    { taskId: 't2', taskContent: 'after', complete: true, image: 'HUGE_BLOB', updateTime: 2 },
    { before: { taskId: 't2', taskContent: 'before', complete: false, image: 'HUGE_BLOB', updateTime: 1 } }
  )
  const [e] = readLines()
  assert.equal(e.action, 'done')
  assert.equal(e.changes.length, 1)
  assert.equal(e.changes[0].taskId, 't2')
  assert.equal(e.changes[0].before.taskContent, 'before')
  assert.equal(e.changes[0].after.taskContent, 'after')
  assert.equal('image' in e.changes[0].before, false) // large fields excluded, same as cli/audit.js SNAPSHOT_FIELDS
})

test('upsertMany maps to add/delete only when every row agrees, else edit', () => {
  appAudit.recordAppOp('upsertMany', [{ taskId: 'a', status: 'add' }, { taskId: 'b', status: 'add' }])
  appAudit.recordAppOp('upsertMany', [{ taskId: 'c', delete: 1, status: 'delete' }, { taskId: 'd', delete: 1 }])
  appAudit.recordAppOp('upsertMany', [{ taskId: 'e', status: 'add' }, { taskId: 'f', status: 'update' }])
  const actions = readLines().map(l => l.action)
  assert.deepEqual(actions, ['add', 'delete', 'edit'])
})

test('plan chip ops map into the CLI plan.* vocabulary', () => {
  appAudit.recordAppOp('planAddMany', [{ taskId: 't1', day: '2026-09-10', mm: '09:00' }])
  appAudit.recordAppOp('planUpdateChip', { id: 7, day: '2026-09-10', mm: '10:00' })
  appAudit.recordAppOp('planMoveTask', { taskId: 't1', fromDay: '2026-09-10', toDay: '2026-09-11' })
  appAudit.recordAppOp('planRemoveIds', [3, 4])
  appAudit.recordAppOp('planDeleteTask', 't1')
  appAudit.recordAppOp('planDeleteTaskDay', { taskId: 't1', day: '2026-09-11' })
  appAudit.recordAppOp('planPrune', { keepDays: ['2026-09-10'] }, { result: 2 })
  const lines = readLines()
  assert.deepEqual(lines.map(l => l.action), ['plan.set', 'plan.set', 'plan.move', 'plan.remove', 'plan.remove', 'plan.remove', 'plan.prune'])
  assert.equal(lines[2].note, '2026-09-10 → 2026-09-11')
  assert.equal(lines[2].targets[0].taskId, 't1')
  assert.equal(lines[6].note, 'pruned 2 chip row(s)')
})

test('tomato ledger and bumpSnow ops map into the CLI tomato.* vocabulary with best-effort targets', () => {
  appAudit.recordAppOp('bumpSnow', { taskId: 't1', minutes: 25 })
  appAudit.recordAppOp('tomatoAppendMany', [{ tomatoId: 'k1', focusTaskId: 't1', endTime: 1 }, { tomatoId: 'k2', endTime: 2 }])
  appAudit.recordAppOp('tomatoUpdateById', { tomatoId: 'k1', patch: { focusTaskId: 't9' } })
  appAudit.recordAppOp('tomatoRemoveByIds', ['k1', 'k2'])
  appAudit.recordAppOp('tomatoMigrateFromMeta', undefined, { result: 5 })
  const lines = readLines()
  assert.deepEqual(lines.map(l => l.action), ['tomato.bump', 'tomato.append', 'tomato.update', 'tomato.remove', 'tomato.migrate'])
  assert.deepEqual(lines[0].targets, [{ taskId: 't1' }])
  assert.equal(lines[0].note, '+25min focus credit')
  assert.deepEqual(lines[1].targets, [{ taskId: 't1' }, { taskId: 'k2' }])
  assert.deepEqual(lines[3].targets, [{ taskId: 'k1' }, { taskId: 'k2' }])
  assert.equal(lines[4].note, 'migrated 5 ledger row(s) from meta blob')
})

test('category and filter ops keep the CLI target conventions', () => {
  appAudit.recordAppOp('upsertCategory', { id: 'c1', name: 'Work', color: '#000' })
  appAudit.recordAppOp('filterUpsert', { name: 'Urgent', conds: {} }, { result: 3 })
  appAudit.recordAppOp('filterDelete', 3)
  appAudit.recordAppOp('hardDeleteMany', ['a', 'b'])
  const lines = readLines()
  assert.deepEqual(lines.map(l => l.action), ['category.upsert', 'view.add', 'view.rm', 'purge'])
  assert.deepEqual(lines[0].targets, [{ taskId: 'cat:c1', content: 'Work' }])
  assert.deepEqual(lines[1].targets, [{ taskId: 'filter:3', content: 'Urgent' }])
  assert.deepEqual(lines[2].targets, [{ taskId: 'filter:3' }])
  assert.deepEqual(lines[3].targets, [{ taskId: 'a' }, { taskId: 'b' }])
})

test('rotation triggers at the injected tiny threshold and rolls to .1', () => {
  appAudit.setMaxBytes(1) // any content exceeds 1 byte
  appAudit.recordAppOp('hardDelete', 'first') // no file yet → appended directly
  assert.equal(readLines().length, 1)
  assert.equal(fs.existsSync(path.join(tmpDir, 'cli-audit.jsonl.1')), false)

  appAudit.recordAppOp('hardDelete', 'second') // size > threshold → roll, then append
  const rolled = fs.readFileSync(path.join(tmpDir, 'cli-audit.jsonl.1'), 'utf8').split('\n').filter(Boolean)
  const current = fs.readFileSync(path.join(tmpDir, 'cli-audit.jsonl'), 'utf8').split('\n').filter(Boolean)
  assert.equal(rolled.length, 1)
  assert.equal(JSON.parse(rolled[0]).targets[0].taskId, 'first')
  assert.equal(current.length, 1)
  assert.equal(JSON.parse(current[0]).targets[0].taskId, 'second')

  appAudit.recordAppOp('hardDelete', 'third') // rolls again, previous .1 replaced
  const rolled2 = fs.readFileSync(path.join(tmpDir, 'cli-audit.jsonl.1'), 'utf8').split('\n').filter(Boolean)
  assert.equal(JSON.parse(rolled2[0]).targets[0].taskId, 'second')
})

test('audit is best-effort: garbage args never throw and never corrupt the trail', () => {
  assert.doesNotThrow(() => appAudit.recordAppOp('upsert', null))
  assert.doesNotThrow(() => appAudit.recordAppOp('upsert', { taskId: 't1' }, { before: 'garbage-string' }))
  assert.doesNotThrow(() => appAudit.recordAppOp('setMeta', undefined))
  assert.doesNotThrow(() => appAudit.recordAppOp('setMeta', [42, 'x']))
  assert.doesNotThrow(() => appAudit.recordAppOp('hardDeleteMany', 'not-an-array'))
  assert.doesNotThrow(() => appAudit.recordAppOp('tomatoAppendMany', { not: 'an array' }))
  assert.doesNotThrow(() => appAudit.recordAppOp(null, null))
  assert.equal(appAudit.actionFor('upsert', 'garbage', null), 'edit')
  assert.equal(appAudit.actionFor('upsert', null, { taskId: 't' }), 'edit')
  assert.deepEqual(appAudit.actionFor('unknownOp', {}, null), 'edit')
  const good = readLines().filter(l => l.targets.length)
  assert.ok(good.length >= 1) // the valid hardDeleteMany-adjacent calls that parse still landed safely or were dropped whole
})
