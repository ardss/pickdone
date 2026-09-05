/** 字段语义化契约测试（2026-09-03 todos 列名债清偿）——TDD 红绿流程的契约锚点。
 *  历史债：DB 列早已语义化(recurGroupId/subtasks/imageUrls/fileAttach/categoryId/focusMinutes/difficulty)，
 *  但 rowToTodo/todoToTodo 吐给渲染端与 CLI 的 API 字段还是 standbyStrN 与 standbyInt1、snowAdd、snowAssess 天书名。
 *  本测试锁定新 API 契约：语义字段跨层往返不丢。红→改 db.js 映射→全栈 token 改名→绿。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'field-semantics-'))
const require_ = createRequire(import.meta.url)
const db = require_('../src/main/db.js')
db.init(process.env.TODO_DB_DIR)

const base = {
  complete: false, createTime: 111, delete: false, deletedAt: 0, completedAt: 0,
  reminderTime: 0, reminderOffsets: [], reminderExtra: [],
  taskContent: '语义化契约', taskDescribe: '', taskSort: 100,
  todoTime: +new Date('2026-09-03T09:00:00'),
  userId: 1, status: 'add', version: 0, updateTime: 111, syncTime: 0,
  taskId: 'tid_semantics_1',
  repeatId: 'repeat_x1',
  subtasks: JSON.stringify([{ text: '子任务', checked: false }]),
  image: 'img://a.png',
  files: 'attach://a.pdf',
  categoryId: 9101,
  estimate: 3,
  difficulty: 2
}

test('契约:写(readable语义字段)→读回来的行仍带语义字段且值不丢', () => {
  db.call('upsert', { ...base })
  const row = db.call('getById', base.taskId)
  for (const [k, v] of Object.entries({
    repeatId: 'repeat_x1',
    categoryId: 9101,
    estimate: 3,
    difficulty: 2
  })) {
    assert.equal(row[k], v, `语义字段 ${k} 往返失真`)
  }
  assert.equal(row.subtasks, base.subtasks)
  assert.equal(row.image, base.image)
  assert.equal(row.files, base.files)
  // 旧天书字段必须从 API 层消失（留着就是第二本账）
  for (const legacy of ['standbyStr1', 'standbyStr2', 'standbyStr3', 'standbyStr4', 'standbyInt1', 'snowAdd', 'snowAssess']) {
    assert.equal(legacy in row, false, `旧字段 ${legacy} 不应再出现在 API 行对象上`)
  }
})

test('契约:queryTodos 走语义过滤(repeatId/categoryId)', () => {
  const rows = db.call('queryTodos', { deleted: 0, repeatId: 'repeat_x1', categoryId: 9101 })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].taskId, base.taskId)
})
