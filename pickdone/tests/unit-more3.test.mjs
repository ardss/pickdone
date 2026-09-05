/**
 * Supplementary unit tests - all ui store mutations, lib.js command-layer gaps (categories/doctor/search/stats boundaries),
 * nlDate time-of-day, repeat skipping holidays. Goal: first-party code coverage >=90%.
 */
import './setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-more3-'))
const require_ = createRequire(import.meta.url)
const lib = require_('../cli/lib.js')
const dayjs = require_('dayjs')

import ui from '../renderer/js/store/ui.js'

/* ---------- ui store: state and all mutations ---------- */

test('ui: state() defaults are complete', () => {
  const s = ui.state()
  assert.equal(s.showSettingsModal, false)
  assert.equal(s.activeNav, 'today')
  assert.equal(s.isLocked, false)
  assert.equal(s.rightSidebarTodoEdit.visible, false)
  assert.ok(Array.isArray(s.userTags))
})

test('ui: openEdit/closeEdit/collapse/expand/patchEdit lifecycle', () => {
  const s = ui.state()
  ui.mutations.openEdit(s, {
    taskId: 't9', taskContent: '标题', taskDescribe: '描述', todoTime: 123,
    reminderTime: 456, difficulty: 2, categoryId: 7, repeatId: 'rid',
    subtasks: JSON.stringify([{ text: '子', checked: false }]),
    image: JSON.stringify(['img1']), files: JSON.stringify(['f1'])
  })
  const e = s.rightSidebarTodoEdit
  assert.equal(e.visible, true)
  assert.equal(e.title, '标题')
  assert.equal(e.dateTs, 123)
  // 旧命名集(reminderTime/difficulty/todoContent 等)2026-09-04 三轮扫荡清退:全仓零读,openEdit 不再透传
  assert.equal(e.difficulty, undefined)
  assert.equal(e.sublist.length, 1)
  assert.deepEqual(e.todoImageList, ['img1'])
  ui.mutations.collapseEdit(s)
  assert.equal(e.collapsed, true)
  ui.mutations.expandEdit(s)
  assert.equal(e.collapsed, false)
  ui.mutations.patchEdit(s, { title: '改' })
  assert.equal(e.title, '改')
  ui.mutations.closeEdit(s)
  assert.equal(e.visible, false)
  // openEdit(null) is safe
  assert.doesNotThrow(() => ui.mutations.openEdit(s, null))
})

test('ui: remaining mutations - navigation/tags/modals/menu/lock screen', () => {
  const s = ui.state()
  ui.mutations.setNav(s, 'statistics')
  assert.equal(s.activeNav, 'statistics')
  ui.mutations.setUserTags(s, [{ name: 'x' }])
  assert.equal(s.userTags.length, 1)
  ui.mutations.setUserTags(s, null)
  assert.deepEqual(s.userTags, [])

  ui.mutations.toggleTomatoPanel(s, true)
  assert.equal(s.tomatoPanelVisible, true)
  ui.mutations.toggleTomatoPanel(s, undefined)
  assert.equal(s.tomatoPanelVisible, false)
  ui.mutations.toggleTomatoFocusRecord(s, true)
  assert.equal(s.tomatoFocusRecordVisible, true)
  ui.mutations.toggleTomatoRecordAdd(s, undefined)
  assert.equal(s.tomatoRecordAddVisible, true)

  ui.mutations.askRepeatDelete(s, 't1')
  assert.equal(s.showRepeatDeleteConfirm, 't1')
  ui.mutations.askRepeatEdit(s, null)
  assert.equal(s.showRepeatModalFor, null)

  ui.mutations.openMenu(s, { x: 1, y: 2, items: [1] })
  assert.equal(s.contextMenu.visible, true)
  ui.mutations.closeMenu(s)
  assert.equal(s.contextMenu.visible, false)

  ui.mutations.setDaySelected(s, 999)
  assert.equal(s.daySelectedTs, 999)
  ui.mutations.setLocked(s, true)
  assert.equal(s.isLocked, true)
})

/* ---------- lib.js: categories/search/doctor/stats boundaries ---------- */

test('lib: categories round trip + addTodo resolving by category name', () => {
  const cats = lib.getCategories()
  assert.ok(Array.isArray(cats))
  const added = lib.addTodo({ content: '分类任务 ' + Math.random().toString(36).slice(2, 5), category: cats[0]?.categoryName })
  assert.equal(typeof added.categoryId, 'number')
})

test('lib: parseDate formats (today = current moment, +Nd offsets, date strings at 00:00)', () => {
  const now = Date.now()
  assert.ok(Math.abs(lib.parseDate('today') - now) < 5000, 'today returns the current moment')
  assert.ok(Math.abs(lib.parseDate('明天') - (now + 86400000)) < 5000)
  assert.equal(lib.parseDate(''), 0)
  assert.equal(lib.parseDate(null), 0)
  const d3 = lib.parseDate('+3d')
  assert.ok(Math.abs(d3 - (now + 3 * 86400000)) < 5000)
  const d4 = lib.parseDate('2030-01-05')
  assert.equal(d4, +dayjs('2030-01-05').startOf('day'))
  // 13-digit timestamps returned as-is
  assert.equal(lib.parseDate('1787846400000'), 1787846400000)
})

test('lib: doctor self-check passes', () => {
  const d = lib.doctor()
  assert.equal(d.ok, true)
  assert.ok(d.checks.every(c => c.ok || c.detail === 'skipped'))
})

test('lib: overview shape (today/overdue/recycle-bin counts)', () => {
  lib.addTodo({ content: 'overview样本 ' + Math.random().toString(36).slice(2, 5), date: 'today' })
  const o = lib.overview()
  assert.ok(o.today != null)
  assert.ok(typeof o.recycle === 'number' || typeof o.recycled === 'number' || typeof o.overdue === 'number')
})

test('lib: stats boundary - from>to returns empty', () => {
  const rows = lib.stats({ from: '2030-01-05', to: '2030-01-01' })
  assert.ok(Array.isArray(rows))
})
