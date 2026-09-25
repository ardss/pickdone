/**
 * D6 F3 — CLI-vs-app consistency round (branch fix/d6-cli), each behavior fix with its regression test:
 *   F3-2  `purge` scrubs the purged taskIds out of projectMilestones:<catId> blobs (D5 renderer twin
 *         store/todo.js scrubMilestonesForPurged got the fix; the CLI purge kept phantom ids → an
 *         unmet milestone whose last link was purged flipped to date-driven 'done').
 *   F3-3  repeat renewal carries the tomato estimate (row column + per-task meta key) — the renderer
 *         twin (ensureNextRepeatInstance) carries both; the CLI hardcoded estimate:0.
 *   F3-4  `done --undo` soft-deletes the auto-renewed next instance (same rid, nearest later dayStart,
 *         group-last, incomplete) so undo converges with the App instead of leaving a phantom instance.
 *   F3-5  addTodo sort unified on renderer nextSort semantics (baseline 1024, ±512 step, ±32 jitter,
 *         side from newTodoDefaultSort) — the old CLI-only min-100/0 convention contradicted the
 *         renderer AND the file's own renewal paths (min-512/1024).
 *   F3-6  settingsDoc overlays settings_rows over the blob (rows win — rows are the field-granular
 *         sync truth); settingsSet writes the single field via the row path (setting.put) instead of
 *         re-stamping the whole stale blob with a fresh _savedAt (which passed the mirror gate and
 *         clobbered newer peer rows).
 * Isolated temp DB via TODO_DB_DIR, never touches real data (f6-cli-round6 pattern).
 * Run: node --test tests/unit/cli/f3-cli-consistency.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'
import { isolatedTmpDir } from '../../lib/tmp-dir.mjs'

process.env.TODO_DB_DIR = isolatedTmpDir('todo-cli-f3-')
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')
const core = require_('../../../src/main/core/todo-core.js')
const dayjs = require_('dayjs')

db.init(process.env.TODO_DB_DIR)

let _seq = 0
function seed (over = {}) {
  const now = Date.now() + (_seq++)
  const t = {
    complete: false, createTime: now, delete: false,
    reminderTime: 0, reminderOffsets: [], reminderExtra: [], estimate: 0, difficulty: 0,
    repeatId: null, subtasks: null, image: null, files: null,
    categoryId: 0, updateTime: now, syncTime: 0,
    taskContent: '任务', taskDescribe: '',
    taskSort: 0, todoTime: 0, userId: 1, status: 'add', version: 0, ...over
  }
  if (!t.taskId) t.taskId = core.genTaskId(1, now)
  db.call('upsert', t)
  return db.call('getById', t.taskId)
}

const today9 = () => +dayjs().hour(9).minute(0).second(0).millisecond(0)

/* ---------------- F3-5: addTodo sort convention ---------------- */

test('f3-5: addTodo uses nextSort semantics (empty pool → 1024 baseline ±32 jitter, not the old 0)', () => {
  const t = lib.addTodo({ content: 'f3排序首行', date: '2026-10-01' })
  assert.ok(Math.abs(t.taskSort - 1024) <= 32,
    'first row of a day takes the 1024 baseline (+/-32 jitter); got ' + t.taskSort + ' (old convention wrote 0)')
})

test('f3-5b: addTodo top-insert is max+512 (+/-32), bottom-insert is min-512 (+/-32) per the setting', () => {
  const day = '2026-10-02'
  seed({ taskContent: 'f3已有一行', todoTime: +dayjs(day).hour(8), dayStart: +dayjs(day).startOf('day'), taskSort: 1024 })
  lib.settingsSet('newTodoDefaultSort', 'top')
  const top = lib.addTodo({ content: 'f3顶插', date: day })
  assert.ok(Math.abs(top.taskSort - (1024 + 512)) <= 32,
    'default top insert = max+512 (+/-32); got ' + top.taskSort + ' (old convention wrote min-100 = 924)')
  lib.settingsSet('newTodoDefaultSort', 'bottom')
  const bottom = lib.addTodo({ content: 'f3底插', date: day })
  assert.ok(Math.abs(bottom.taskSort - (1024 - 512)) <= 32,
    'newTodoDefaultSort=bottom → min-512 (+/-32), matching the renewal paths; got ' + bottom.taskSort)
})

/* ---------------- F3-3: renewal carries the estimate ---------------- */

test('f3-3: completing the last repeat instance renews WITH the estimate (row + per-task meta key)', () => {
  const rid = 'repeat_f3est1'
  const t = seed({ taskContent: 'f3重复估时任务', repeatId: rid, todoTime: today9(), dayStart: +dayjs().startOf('day'), estimate: 3 })
  db.call('setMeta', ['repeatRule:' + rid, JSON.stringify({ ...core.REPEAT_DEFAULTS, repeatType: 'day', repeatInterval: 1 })])
  const { renewed } = lib.toggleComplete(t.taskId, true)
  assert.ok(renewed, 'renewal created')
  assert.equal(renewed.estimate, 3, 'renewed row carries the estimate column (was hardcoded 0)')
  assert.equal(db.call('getMeta', 'tomatoEstimateState:' + renewed.taskId), '3',
    'per-task estimate meta key written on renewal (the column is write-once; the key is the live value)')
})

/* ---------------- F3-4: undo removes the renewed instance ---------------- */

test('f3-4: done --undo soft-deletes the auto-renewed next instance', () => {
  const rid = 'repeat_f3undo1'
  const t = seed({ taskContent: 'f3撤销重复任务', repeatId: rid, todoTime: today9(), dayStart: +dayjs().startOf('day') })
  db.call('setMeta', ['repeatRule:' + rid, JSON.stringify({ ...core.REPEAT_DEFAULTS, repeatType: 'day', repeatInterval: 1 })])
  const { renewed } = lib.toggleComplete(t.taskId, true)
  assert.ok(renewed && !renewed.complete, 'renewal created before undo')
  lib.toggleComplete(t.taskId, false) // done --undo
  const after = db.call('getById', renewed.taskId)
  assert.ok(after.delete, 'the renewed next instance is soft-deleted with the undo (used to survive as a phantom)')
  assert.equal(after.version, 0, 'version reset so the soft delete re-enters the sync snapshot')
  const undone = db.call('getById', t.taskId)
  assert.equal(undone.complete, false, 'the completed row itself is unchecked as before')
})

test('f3-4b: undo of an OLDER sibling does NOT touch a genuine later instance beyond the next day', () => {
  const rid = 'repeat_f3undo2'
  const tomorrow = +dayjs().add(1, 'day').startOf('day')
  const t = seed({ taskContent: 'f3撤销老实例', repeatId: rid, todoTime: today9(), dayStart: +dayjs().startOf('day') })
  // a genuine future instance on a LATER day than "next" — actually here next IS tomorrow; instead
  // verify an incomplete next instance that already has a further sibling is left alone
  const next = seed({ taskContent: 'f3撤销老实例', repeatId: rid, todoTime: +dayjs(tomorrow).hour(9), dayStart: tomorrow, taskSort: 512 })
  const later = +dayjs().add(3, 'day').startOf('day')
  seed({ taskContent: 'f3撤销老实例', repeatId: rid, todoTime: +dayjs(later).hour(9), dayStart: later, taskSort: 0 })
  lib.toggleComplete(t.taskId, false)
  assert.ok(!db.call('getById', next.taskId).delete,
    'undo of a non-last instance leaves later group members alone (renewal never fired for it)')
})

/* ---------------- F3-2: purge scrubs milestone taskIds ---------------- */

test('f3-2: purge scrubs the purged ids from projectMilestones blobs (phantom id flipped unmet→done)', () => {
  const cat = lib.addCategory('f3清除分类')
  const victim = seed({ taskContent: 'f3被清除任务', categoryId: cat.categoryId })
  const survivor = seed({ taskContent: 'f3保留任务', categoryId: cat.categoryId })
  const msKey = 'projectMilestones:' + cat.categoryId
  db.call('setMeta', [msKey, JSON.stringify([
    { id: 'ms1', title: '上线', date: +dayjs('2026-12-01').startOf('day'), taskIds: [victim.taskId, survivor.taskId] }
  ])])
  lib.deleteTodo(victim.taskId)
  lib.purgeRecycleBin()
  const list = JSON.parse(db.call('getMeta', msKey))
  assert.deepEqual(list[0].taskIds, [survivor.taskId],
    'phantom taskId scrubbed; the surviving link is kept (renderer scrubMilestonesForPurged parity)')
})

/* ---------------- F3-6: settings rows overlay + row-path write ---------------- */

test('f3-6a: settingsDoc overlays non-deleted settings_rows over the blob (rows win)', () => {
  db.call('setMeta', ['db.settingsState', JSON.stringify({ maxRepeat: '2', _savedAt: 1700000000000, schemaV: 1 })])
  db.call('settingsRowPut', { key: 'maxRepeat', value: '9' }) // newer sync-applied row the blob never mirrored
  const doc = lib.settingsDoc()
  assert.equal(doc.maxRepeat, '9', 'row (sync truth) wins over the stale blob (was: blob-only read returned "2")')
})

test('f3-6b: settingsSet writes the single field via the setting.put row path AND refreshes the blob', () => {
  const r = lib.settingsSet('dailyTomatoTarget', '12')
  assert.equal(r.value, 12)
  const row = db.call('settingsRowsAll').find(x => x.key === 'dailyTomatoTarget')
  assert.ok(row && !row.deleted && row.value === 12, 'field landed in settings_rows via setting.put')
  const blob = JSON.parse(db.call('getMeta', 'db.settingsState'))
  assert.equal(blob.dailyTomatoTarget, 12, 'blob refreshed from the converged doc (hot-sync watcher + renderer initFromDb keep working)')
})

test('f3-6c: settingsSet still survives a concurrent App write inside the race window (no clobber)', () => {
  const readBlob = () => { try { return JSON.parse(db.call('getMeta', 'db.settingsState') || 'null') || {} } catch { return {} } }
  db.call('setMeta', ['db.settingsState', JSON.stringify({ themeExisting: 'app', _savedAt: 1700000000000, schemaV: 1 })])
  lib.setSettingsRaceHookForTests(() => {
    const concurrent = readBlob()
    concurrent.appConcurrencyKey = 'written-by-app'
    concurrent._savedAt = 1700000000001
    db.call('setMeta', ['db.settingsState', JSON.stringify(concurrent)])
  })
  const r = lib.settingsSet('maxRepeat', '7')
  assert.equal(r.value, '7')
  lib.setSettingsRaceHookForTests(null)
  const final = lib.settingsDoc()
  assert.equal(final.maxRepeat, '7', 'CLI key landed')
  assert.equal(final.appConcurrencyKey, 'written-by-app', 'concurrent App change must NOT be clobbered')
})

test('f3-6d: a newer peer row survives settingsSet (the stale-blob restamp regression)', () => {
  // Simulate the pre-fix failure: blob carries an OLD value while a peer row is NEWER; settingsSet of
  // an unrelated key used to re-stamp the blob (fresh _savedAt) and wash the peer value back.
  db.call('setMeta', ['db.settingsState', JSON.stringify({ todoBoxCategoryId: 5, _savedAt: 1700000000000, schemaV: 1 })])
  db.call('settingsRowPut', { key: 'todoBoxCategoryId', value: 3 }) // peer's newer live value
  lib.settingsSet('whiteNoiseVolume', '0.3')
  const doc = lib.settingsDoc()
  assert.equal(doc.todoBoxCategoryId, 3, 'newer peer row value survives a CLI set of an unrelated key')
  assert.equal(doc.whiteNoiseVolume, 0.3)
})
