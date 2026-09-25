/**
 * Regression test for the P1 todoBackup-meta-keys-omitted finding (2026-09-26).
 *
 * buildBackupDump emitted no meta segment, so backup/restore lost every DB-meta-only data
 * surface: repeat rules (repeatRule:<rid>), per-task tomato estimates (tomatoEstimateState:<taskId>),
 * and project deadline/status/flag/milestones (project*:<id> + projectCategoryIds). The fix adds
 * metaStateKeys/collectMetaState and emits a versioned `metaState` segment.
 *
 * Run: node --test tests/unit/main/todobackup-meta-state.test.mjs
 * Isolation: pure node --test; window.todoAPI is stubbed, no Electron, no real userData.
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const todoBackup = await import('../../../renderer/js/store/helpers/todoBackup.js')

process.env.TODO_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pickdone-metastate-'))
process.env.TODO_DB_DIR = path.join(process.env.TODO_USER_DATA_DIR, 'db')

let metaRows
beforeEach(() => {
  metaRows = {}
  globalThis.window = { todoAPI: {
    getMetaMany: async keys => keys.map(k => ({ key: k, value: metaRows[k] ?? null })),
    runAutoBackup: async () => ({ ok: true })
  } }
})
afterEach(() => { delete globalThis.window })

const STATE = {
  todoList: [{ taskId: 't1', repeatId: 'r1' }, { taskId: 't2' }],
  recycleList: [{ taskId: 't3', repeatId: 'r2' }],
  category: { list: [{ categoryId: 'c1' }, {}] }
}

test('metaStateKeys derives the meta-table key set from live state (repeat/estimate/project surfaces)', () => {
  const keys = todoBackup.metaStateKeys(STATE, STATE)
  for (const k of ['repeatRule:r1', 'repeatRule:r2', 'tomatoEstimateState:t1', 'tomatoEstimateState:t2',
    'tomatoEstimateState:t3', 'projectDeadline:c1', 'projectStatus:c1', 'projectCategoryFlag:c1',
    'projectMilestones:c1', 'projectCategoryIds']) {
    assert.ok(keys.includes(k), `missing key ${k}`)
  }
  assert.equal(keys.filter(k => k.startsWith('tomatoEstimateState:')).length, 3, 'todoList + recycleList both contribute estimates')
})

test('collectMetaState emits a versioned entries segment from getMetaMany, dropping empty values', async () => {
  metaRows = { 'repeatRule:r1': '{"freq":"daily"}', 'tomatoEstimateState:t1': '3', 'projectStatus:c1': '' }
  const seg = await todoBackup.collectMetaState(STATE, STATE)
  const parsed = JSON.parse(seg)
  assert.equal(parsed.schemaV, todoBackup.SCHEMA_V)
  assert.ok(parsed.entries.some(e => e.key === 'repeatRule:r1' && e.value === '{"freq":"daily"}'))
  assert.ok(parsed.entries.some(e => e.key === 'tomatoEstimateState:t1' && e.value === '3'))
  assert.ok(!parsed.entries.some(e => e.key === 'projectStatus:c1'), 'empty stored values are dropped')
  assert.ok(parsed.entries.length >= 2)
})

test('collectMetaState returns null when no relevant entries exist or the host is degraded', async () => {
  assert.equal(await todoBackup.collectMetaState(STATE, STATE), null, 'all meta absent → omit the segment')
  delete globalThis.window
  assert.equal(await todoBackup.collectMetaState(STATE, STATE), null, 'degraded host → omit the segment')
})

test('buildBackupDump includes the metaState segment and omits it when null/degraded', () => {
  const rootState = { ...STATE, settings: {}, tomato: { tomatoRecordList: [] }, habits: { habits: [], moments: [], savedAt: 0 }, filters: { list: [] } }
  const withMeta = todoBackup.buildBackupDump(rootState, STATE, { metaState: JSON.stringify({ schemaV: 1, entries: [{ key: 'repeatRule:r1', value: 'x' }] }) })
  assert.ok(withMeta.backup.metaState.includes('repeatRule:r1'))
  const withoutMeta = todoBackup.buildBackupDump(rootState, STATE)
  assert.equal(withoutMeta.backup.metaState, undefined, 'empty/degraded metaState is omitted (JSON.stringify drops undefined)')
})

test('end to end shape: collect → dump carries the same segment the restore side parses', async () => {
  metaRows = { 'repeatRule:r1': '{"freq":"daily"}' }
  const seg = await todoBackup.collectMetaState(STATE, STATE)
  const rootState = { ...STATE, settings: {}, tomato: { tomatoRecordList: [] }, habits: { habits: [], moments: [], savedAt: 0 }, filters: { list: [] } }
  const dump = todoBackup.buildBackupDump(rootState, STATE, { metaState: seg })
  const parsed = JSON.parse(dump.backup.metaState)
  assert.deepEqual(parsed.entries, [{ key: 'repeatRule:r1', value: '{"freq":"daily"}' }])
})
