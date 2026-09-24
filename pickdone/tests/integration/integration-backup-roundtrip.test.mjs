/**
 * Data-safety round-trip: REAL task data through the REAL chain —
 *   db.js (encrypted SQLite) -> renderer-format critical backup JSON -> corrupt -> attemptDbRecovery
 *   -> restoreTasksFromCriticalBackup -> db.js again -> field-level equivalence.
 * Unlike the synthetic-JSON drills in integration-resilience, this proves fields actually SURVIVE
 * the round trip, not merely that the loader tolerates JSON. Temp dirs only; real userData untouched.
 */
import '../setup.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const dbRecovery = require('../../src/main/dbRecovery.cjs')
const dbm = require('../../src/main/db.js')

function tmpDir () {
  // 独立父目录：灾备 JSON 现默认外置到 userData 父目录的 pickdone-backups（与库分离）。
  // 若直接拿 os.tmpdir() 当父，会与其他用例共享同一个外置根造成污染，故先建一次性 base。
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-roundtrip-base-'))
  const ud = path.join(base, 'ud')
  fs.mkdirSync(ud, { recursive: true })
  return ud
}

test('round-trip: real db -> critical backup JSON -> corrupt -> recovery re-import -> fields equal', () => {
  // ---- Phase A: real encrypted db, real rows, renderer-format critical backup dump ----
  const udA = tmpDir()
  dbm.init(udA)
  const seed = [
    { taskId: 't1', taskContent: '普通任务 <含>&转义', done: false, important: 1, urgent: 0, priority: 1, deadlineTs: 1790000000000 },
    { taskId: 't2', taskContent: '已完成带提醒', complete: true, completedAt: Date.now() - 3600e3, reminderOffsets: [10, 30], reminderExtra: [15] },
    { taskId: 't3', taskContent: '回收站行', delete: true }
  ]
  for (const t of seed) dbm.call('upsert', t)
  const persisted = seed.map(t => dbm.call('getById', t.taskId))

  // Same dump shape as store/todo.js writeCriticalBackup (todoState carries both lists)
  const dump = {
    backup: {
      todoState: JSON.stringify({
        todoList: persisted.filter(t => !t.delete),
        recycleList: persisted.filter(t => t.delete),
        version: 0, remoteVersion: 0, todayTimestamp: Date.now(), ignoreReminder: {}, todosVersion: '0', isSyncing: false, views: {}
      }),
      // Same shape as writeCriticalBackup: categoryState is a nested JSON string of { list: [...] } (renderer app-shape rows)
      categoryState: JSON.stringify({
        list: [
          { categoryId: 7, categoryName: '工作 <转义>', categoryColor: '#ff8800', createTime: 1700000000000, listSort: 1, folderIs: false, folderId: 0, delete: false }
        ]
      })
    }
  }
  // Phase A dir keeps only the backup; the db itself is thrown away (never trusted post-corruption)
  dbm.close() // release the Windows file lock so the temp dir can be removed
  const udB = tmpDir()
  dbRecovery.writeCriticalStateBackupAtomic(udB, JSON.stringify(dump))

  // ---- Phase B: corrupt db + backup present -> recovery must re-import with fields intact ----
  fs.writeFileSync(path.join(udB, 'todos.db'), 'CORRUPT-AFTER-BACKUP')
  const from = dbRecovery.attemptDbRecovery(udB)
  assert.equal(from && from.source, 'json', 'no plaintext bak in this drill, must plan the JSON path')

  dbm.init(udB) // fresh (recreated) database, same module the main process uses
  let n = 0
  dbRecovery.restoreTasksFromCriticalBackup(udB, list => {
    n = list.length
    dbm.call('upsertMany', list)
  }, c => dbm.call('upsertCategory', c))
  assert.equal(n, seed.length, 'all seeded rows (main + recycle) re-imported')

  // Categories come back with the tasks (分类灾备恢复：任务回来分类不能全没)
  const cats = dbm.call('getAllCategories')
  assert.equal(cats.length, 1, 'the seeded category is re-imported')
  assert.equal(cats[0].categoryName, '工作 <转义>', 'category name survives')
  assert.equal(cats[0].categoryColor, '#ff8800', 'category color survives')

  const t1 = dbm.call('getById', 't1')
  assert.equal(t1.taskContent, seed[0].taskContent, 'content survives (incl. HTML-ish chars)')
  assert.equal(t1.important, 1, 'important flag survives')
  assert.equal(t1.deadlineTs, seed[0].deadlineTs, 'deadline survives')
  const t2 = dbm.call('getById', 't2')
  assert.equal(t2.complete, true, 'done flag survives')
  assert.deepEqual(t2.reminderOffsets, [10, 30], 'reminder offsets survive')
  assert.deepEqual(t2.reminderExtra, [15], 'reminder extra survives')
  const t3 = dbm.call('getById', 't3')
  assert.ok(t3.delete, 'recycle-bin rows come back as recycled')

  dbm.close()
  fs.rmSync(udA, { recursive: true, force: true })
  fs.rmSync(udB, { recursive: true, force: true })
})

/**
 * F19+F11 (dw wave6 2026-09-24): the tomato ledger rows, saved filters, plan chips and the habits
 * blob from a backup JSON must survive the startup-recovery re-import — the production wiring
 * (index.js restoreTasksFromCriticalBackup) passes filterPutMany/planPutMany/habitsPut through the
 * same bus doors the renderer uses; before this test the whole re-import path of these segments
 * had ZERO coverage (grep tests/ for appendTomatoRecords/restoreTomatoRecords* found only the
 * write side) and a silently broken chain (callbacks not functions → return 0) would never go red.
 */
test('round-trip: tomatoRecords/filterState/planState/habitsState segments re-import via the F11 callbacks, idempotently', () => {
  // dump is hand-built in renderer shape (no seeding db needed — the segments under test carry
  // their rows verbatim); only the restore-side db is real.
  const rec = {
    tomatoId: 'tmt_rt_1', endTime: Date.now() - 60e3, dateKey: '', focus: '账本回灌',
    focusTaskId: 't1', focusDuration: 25, rest: 5, restDuration: 5, succeed: true, manual: false, status: '', abandonReason: '', extra: {}
  }
  const dump = {
    backup: {
      todoState: JSON.stringify({ schemaV: 1, todoList: [], recycleList: [], version: 0, remoteVersion: 0, todayTimestamp: Date.now(), ignoreReminder: {}, todosVersion: '0', isSyncing: false, views: {} }),
      categoryState: JSON.stringify({ schemaV: 1, list: [] }),
      tomatoRecords: JSON.stringify([rec, { tomatoId: null, endTime: 1 }, { tomatoId: 'tmt_rt_2', endTime: Date.now() - 30e3, focusDuration: 50 }]),
      filterState: JSON.stringify({ schemaV: 1, list: [{ id: 91, name: '工作紧急', conds: { catId: 3, priority: 2, dateMode: 'all' }, sort: 1, updatedAt: Date.now() }] }),
      planState: JSON.stringify({ schemaV: 1, chips: [{ id: 'pl_rt_1', taskId: 't1', day: '2026-09-24', mm: '09:30', sort: 2, updatedAt: Date.now() }] }),
      habitsState: JSON.stringify({ schemaV: 1, habits: [{ id: 'h1', name: '跑步', createdAt: 123 }], moments: [], savedAt: 42 })
    }
  }
  const udB = tmpDir()
  dbRecovery.writeCriticalStateBackupAtomic(udB, JSON.stringify(dump))
  dbm.close()

  // corrupt db + backup → JSON recovery path, exactly like the main process
  fs.writeFileSync(path.join(udB, 'todos.db'), 'CORRUPT')
  const from = dbRecovery.attemptDbRecovery(udB)
  assert.equal(from && from.source, 'json')

  dbm.init(udB)
  // Same write doors as index.js (main-internal db.call ops behind the bus verbs)
  const n = dbRecovery.restoreTasksFromCriticalBackup(udB,
    list => dbm.call('upsertMany', list),
    c => dbm.call('upsertCategory', c),
    rows => dbm.call('tomatoAppendMany', rows),
    {
      filterPutMany: rows => dbm.call('filterUpsertMany', rows),
      planPutMany: chips => dbm.call('planAddMany', chips),
      habitsPut: pair => dbm.call('setMeta', pair)
    })
  assert.equal(n, 0, 'no task rows in this dump — but the other segments must still import')

  const ledger = dbm.call('tomatoAll')
  assert.equal(ledger.length, 2, 'both valid ledger rows re-import (row without tomatoId skipped)')
  const back1 = ledger.find(r => r.tomatoId === 'tmt_rt_1')
  assert.equal(back1.focus, '账本回灌', 'ledger focus text survives')
  assert.equal(back1.focusDuration, 25, 'ledger duration survives')
  assert.ok(back1.dateKey, 'dateKey re-derived from endTime')

  const filters = dbm.call('filterList')
  assert.equal(filters.length, 1, 'the saved filter re-imports')
  assert.equal(filters[0].name, '工作紧急')
  assert.deepEqual(filters[0].conds, { catId: 3, priority: 2, dateMode: 'all' }, 'filter conditions survive (normConds canonical shape)')

  const chips = dbm.call('planAll')
  assert.equal(chips.length, 1, 'the plan chip re-imports')
  assert.equal(chips[0].id, 'pl_rt_1', 'chip keeps its id (idempotent upsert key)')
  assert.equal(chips[0].sort, 2, 'chip sort survives (H2 regression guard)')

  const habits = JSON.parse(dbm.call('getMeta', 'db.habitsState'))
  assert.equal(habits.savedAt, 42, 'habits blob re-published through the meta door')
  assert.equal(habits.habits.length, 1, 'one habit survives')
  assert.equal(habits.habits[0].name, '跑步', 'habit name survives')

  // Idempotency: replaying the restore (crash between restore and init retry, or double pass)
  // must NOT duplicate ledger rows / filters / chips.
  dbRecovery.restoreTasksFromCriticalBackup(udB,
    list => dbm.call('upsertMany', list),
    c => dbm.call('upsertCategory', c),
    rows => dbm.call('tomatoAppendMany', rows),
    {
      filterPutMany: rows => dbm.call('filterUpsertMany', rows),
      planPutMany: chips2 => dbm.call('planAddMany', chips2),
      habitsPut: pair => dbm.call('setMeta', pair)
    })
  assert.equal(dbm.call('tomatoAll').length, 2, 'replay does not double the ledger (idempotent by tomatoId)')
  assert.equal(dbm.call('filterList').length, 1, 'replay does not duplicate the filter (upsert by id)')
  assert.equal(dbm.call('planAll').length, 1, 'replay does not duplicate the chip (upsert by id)')

  // A broken chain (callbacks not functions) silently imports nothing — pin that it stays at 0 rows
  // rather than throwing, so the caller's restoredN gate keeps the bak file alive.
  const nSilent = dbRecovery.restoreTasksFromCriticalBackup(udB, undefined, undefined, undefined)
  assert.equal(nSilent, 0, 'missing callbacks degrade to a no-op, not a crash')

  dbm.close()
  fs.rmSync(udB, { recursive: true, force: true })

  // Adversarial-round pin: a NON-empty todoState with a missing upsertTasks callback must return
  // 0 — the old shape returned list.length while importing nothing, which could have opened the
  // caller's restoredN>0 gate (bak cleanup) on a restore that touched zero rows.
  const udC = tmpDir()
  dbRecovery.writeCriticalStateBackupAtomic(udC, JSON.stringify({
    backup: { todoState: JSON.stringify({ schemaV: 1, todoList: [{ taskId: 't9', taskContent: 'x' }], recycleList: [], version: 0, remoteVersion: 0, todayTimestamp: Date.now(), ignoreReminder: {}, todosVersion: '0', isSyncing: false, views: {} }) }
  }))
  const nGhost = dbRecovery.restoreTasksFromCriticalBackup(udC, undefined, undefined, undefined)
  assert.equal(nGhost, 0, 'missing callback + non-empty todoState reports 0 imported (never a ghost count)')
  dbm.init(udC)
  assert.ok(!dbm.call('getById', 't9'), 'and indeed no row landed in the db')
  dbm.close()
  fs.rmSync(udC, { recursive: true, force: true, maxRetries: 3 })
})
