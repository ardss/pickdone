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
