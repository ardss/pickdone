// IPC dbCall op whitelist tests
import { test } from 'node:test'
import assert from 'node:assert/strict'
import '../../setup.mjs'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'
import { anchorPath } from '../../lib/source-anchors.mjs'
const require_ = createRequire(import.meta.url)

function tmpDir () { return fs.mkdtempSync(path.join(os.tmpdir(), 'todo-ipc-')) }

/** 真实白名单(从 src/main/index.js 源码提取,防手工副本与真实集合脱钩——2026-09-05 终审 P2) */
function realAllowedOps () {
  const wlPath = anchorPath(fs.existsSync(anchorPath('handlersTodo')) ? 'handlersTodo' : 'mainIndex')
  const src = fs.readFileSync(wlPath, 'utf8')
  const m = src.match(/const ALLOWED_RENDERER_OPS = new Set\(\[([\s\S]*?)\]\)/)
  assert.ok(m, 'ALLOWED_RENDERER_OPS 必须存在于 handlers/todo.js')
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]))
}
const ALLOWED_RENDERER_OPS = realAllowedOps()
function ipcCall (db, op, params) {
  if (!ALLOWED_RENDERER_OPS.has(op)) {
    throw new Error('DB op not allowed: ' + String(op))
  }
  return db.call(op, params)
}

test('IPC dbCall: whitelisted ops pass (upsert/getById/queryTodos/getMeta/...)', () => {
  process.env.TODO_DB_DIR = tmpDir()
  const db = require_('../../../src/main/db.js')
  db.init(process.env.TODO_DB_DIR)
  const ok = ipcCall(db, 'upsert', {
    taskId: 't1', userId: 1, taskContent: 'x', taskDescribe: '', complete: false,
    completedAt: 0, deletedAt: 0, delete: false, createTime: Date.now(), updateTime: Date.now(),
    syncTime: 0, scheduledAt: 0, scheduledDay: 0, remindAt: 0, sort: 0,
    focusMinutes: 0, difficulty: 0, recurGroupId: null, subtasks: null, imageUrls: null, fileAttach: null,
    categoryId: 0, priority: 0, deadlineTs: 0, important: 0, urgent: 0, status: 'add', version: 0,
    taskSort: 0, todoTime: 0,
    dayStart: 0, reminderTime: 0
  })
  assert.equal(ok, true, 'whitelisted op upsert should pass')
  assert.ok(ipcCall(db, 'getById', 't1'), 'whitelisted op getById should pass')
  assert.ok(Array.isArray(ipcCall(db, 'queryTodos', { deleted: 0 })), 'whitelisted op queryTodos should pass')
  assert.equal(ipcCall(db, 'getMeta', 'foo'), null, 'whitelisted op getMeta should pass')
  // isWriteOp is not in db OPS (a standalone function); the IPC whitelist lists it only for renderer probing; call the function directly
  assert.equal(db.isWriteOp('upsert'), true, 'isWriteOp returns true for write')
  assert.equal(db.isWriteOp('getById'), false, 'isWriteOp returns false for read')
})

test('IPC dbCall: dangerous non-whitelisted ops throw (prevents XSS injecting hardDelete etc.)', () => {
  process.env.TODO_DB_DIR = tmpDir()
  const db = require_('../../../src/main/db.js')
  db.init(process.env.TODO_DB_DIR)
  const dangerousOps = [
    'purgeRecycleBin', 'purgeSeedTodos', // 有专用通道(db:purge-*)且只许主窗,不走白名单
    'listMetaKeys', 'nextCliTomatoSeq' // 主进程/CLI 内部专用 op(clearCategories 死 op 已于 2026-09-05 删除)
  ]
  for (const op of dangerousOps) {
    assert.throws(
      () => ipcCall(db, op, ['t1']),
      e => /op not allowed/i.test(e.message),
      op + ' should be blocked by IPC whitelist'
    )
    // db.call accepts the dangerous op (it is in db OPS), but the IPC whitelist intercepts at the main-process entry - one layer of defense is enough
    const r = db.call(op, ['t1'])
    assert.ok(r !== undefined, 'db.call accepts the dangerous op; the defense lives at the IPC entry')
  }
})

test('IPC dbCall: a fabricated op name (in neither db OPS nor the whitelist) also throws', () => {
  process.env.TODO_DB_DIR = tmpDir()
  const db = require_('../../../src/main/db.js')
  db.init(process.env.TODO_DB_DIR)
  assert.throws(
    () => ipcCall(db, 'dropAllTables', {}),
    e => /op not allowed/i.test(e.message)
  )
})
