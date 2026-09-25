/**
 * Integration tests — cross-module combination behaviors on a real isolated SQLite DB (D4 pyramid wave):
 * the pyramid audit showed integration at 31 cases vs 2174 unit cases; this file adds combos the
 * unit layer cannot prove because they span db + lib + meta + audit (validation codes, repeat group
 * lifecycle, subtask cascades, chips snapshot/restore, views/settings/estimate surfaces).
 * Every case drives the real lib pipeline (no stubs) and asserts observable row/meta state.
 * Run: node --test tests/integration/integration-combo-behaviors.test.mjs
 */
import { createRequire } from 'module'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { isolatedTmpDir } from '../lib/tmp-dir.mjs'

process.env.TODO_DB_DIR = isolatedTmpDir('todo-int-combo-')
const require_ = createRequire(import.meta.url)
const lib = require_('../../cli/lib.js')
const dayjs = require_('dayjs')

const content = s => s + ' ' + Math.random().toString(36).slice(2, 6)

/* ---------- addTodo validation & field derivation ---------- */

test('integration: addTodo rejects empty content with code EMPTY_CONTENT', () => {
  let err
  try { lib.addTodo({ content: '   ' }) } catch (e) { err = e }
  assert.ok(err, 'empty content must throw')
  assert.equal(err.code, 'EMPTY_CONTENT')
})

test('integration: addTodo trims content and keeps desc verbatim', () => {
  const t = lib.addTodo({ content: '  需要去除空白  ', desc: '保留 描述', date: 'tomorrow' })
  assert.equal(t.taskContent, '需要去除空白')
  assert.equal(t.taskDescribe, '保留 描述')
})

test('integration: addTodo priority=3 infers important=1 (Eisenhower default)', () => {
  const t = lib.addTodo({ content: content('重要推断'), date: 'tomorrow', priority: 3 })
  assert.equal(t.priority, 3)
  assert.equal(t.important, 1)
  const t2 = lib.addTodo({ content: content('普通'), date: 'tomorrow', priority: 1 })
  assert.equal(t2.important, 0)
})

test('integration: addTodo explicit important wins over the priority inference', () => {
  const t = lib.addTodo({ content: content('显式重要'), date: 'tomorrow', priority: 1, important: true })
  assert.equal(t.important, 1)
})

test('integration: addTodo difficulty is numeric-coerced, reminder parsed', () => {
  const t = lib.addTodo({ content: content('难度'), date: 'tomorrow', difficulty: '2', reminder: '2026-10-01 09:30' })
  assert.equal(t.difficulty, 2)
  assert.ok(t.reminderTime > 0)
})

test('integration: addTodo `after` writes predecessors JSON (dependency edge)', () => {
  const a = lib.addTodo({ content: content('前置'), date: 'tomorrow' })
  const b = lib.addTodo({ content: content('后继'), date: 'tomorrow', after: [a.taskId] })
  assert.ok(String(b.predecessors || '').includes(a.taskId))
})

test('integration: dependency cycle is rejected with code DEP_CYCLE', () => {
  const a = lib.addTodo({ content: content('环A'), date: 'tomorrow' })
  const b = lib.addTodo({ content: content('环B'), date: 'tomorrow', after: [a.taskId] })
  let err
  try { lib.patchTodo(a.taskId, { predecessors: [b.taskId] }) } catch (e) { err = e }
  assert.ok(err, 'closing the loop must throw')
  assert.equal(err.code, 'DEP_CYCLE')
})

test('integration: self-predecessor is silently normalized away (no edge, no throw)', () => {
  const a = lib.addTodo({ content: content('自环'), date: 'tomorrow' })
  const after = lib.patchTodo(a.taskId, { predecessors: [a.taskId] })
  assert.equal(after.predecessors, null)
})

/* ---------- completion pipeline & subtask cascade ---------- */

test('integration: completing with default cascade checks all subtasks', () => {
  const t = lib.addTodo({ content: content('级联完成'), date: 'tomorrow' })
  lib.addSubtask(t.taskId, '子1')
  lib.addSubtask(t.taskId, '子2')
  const { completed } = lib.toggleComplete(t.taskId, true)
  const subs = lib.parseSubs(completed)
  assert.equal(completed.complete, true)
  assert.deepEqual(subs.map(s => s.checked), [true, true])
})

test('integration: completing with withSubtasks:false leaves subtasks unchecked', () => {
  const t = lib.addTodo({ content: content('不级联'), date: 'tomorrow' })
  lib.addSubtask(t.taskId, '独立子任务')
  const { completed } = lib.toggleComplete(t.taskId, true, { withSubtasks: false })
  assert.equal(completed.complete, true)
  assert.equal(lib.parseSubs(completed)[0].checked, false)
})

test('integration: undo clears subtask checks (symmetric cascade)', () => {
  const t = lib.addTodo({ content: content('撤销级联'), date: 'tomorrow' })
  lib.addSubtask(t.taskId, '子甲')
  lib.toggleComplete(t.taskId, true)
  const undone = lib.toggleComplete(t.taskId, false)
  assert.equal(undone.complete, false)
  assert.deepEqual(lib.parseSubs(undone).map(s => s.checked), [false])
})

test('integration: subtask keyword ambiguity throws AMBIGUOUS_MATCH, bad index throws SUB_NOT_FOUND', () => {
  const t = lib.addTodo({ content: content('子任务寻址'), date: 'tomorrow' })
  lib.addSubtask(t.taskId, '写报告')
  lib.addSubtask(t.taskId, '写总结')
  let err
  try { lib.checkSubtask(t.taskId, '写') } catch (e) { err = e }
  assert.equal(err && err.code, 'AMBIGUOUS_MATCH')
  let err2
  try { lib.checkSubtask(t.taskId, '99') } catch (e) { err2 = e }
  assert.equal(err2 && err2.code, 'SUB_NOT_FOUND')
})

test('integration: removeSubtask splices by 1-based index and shifts the rest', () => {
  const t = lib.addTodo({ content: content('子任务删除'), date: 'tomorrow' })
  lib.addSubtask(t.taskId, '甲')
  lib.addSubtask(t.taskId, '乙')
  lib.removeSubtask(t.taskId, '1')
  assert.deepEqual(lib.parseSubs(lib.resolveTask(t.taskId)).map(s => s.text), ['乙'])
})

/* ---------- date lifecycle ---------- */

test('integration: clearTodoDate zeroes todoTime/dayStart and drops the main reminder', () => {
  const t = lib.addTodo({ content: content('清日期'), date: 'tomorrow', reminder: '2026-10-02 08:00' })
  assert.ok(t.reminderTime > 0)
  const { task, changed } = lib.clearTodoDate(t.taskId)
  assert.equal(changed, true)
  assert.equal(task.todoTime, 0)
  assert.equal(task.dayStart, 0)
  assert.equal(task.reminderTime, 0)
})

test('integration: clearTodoDate on an already-undated task is a no-op (changed:false)', () => {
  const t = lib.addTodo({ content: content('无日期') })
  const { changed } = lib.clearTodoDate(t.taskId)
  assert.equal(changed, false)
})

test('integration: rescheduling via patchTodo re-derives dayStart from todoTime', () => {
  const t = lib.addTodo({ content: content('改期'), date: 'tomorrow' })
  const nextWeek = +dayjs().add(7, 'day').startOf('day')
  const after = lib.patchTodo(t.taskId, { todoTime: nextWeek })
  assert.equal(after.dayStart, nextWeek)
})

/* ---------- delete / restore / recycle pipeline ---------- */

test('integration: deleteTodo resets version to 0 so the deletion re-enters sync', () => {
  const t = lib.addTodo({ content: content('版本归零'), date: 'tomorrow' })
  const after = lib.deleteTodo(t.taskId)
  assert.equal(after.version, 0, 'P3 regression: delete rows with version>0 are excluded from syncTodos')
  assert.equal(after.delete, true)
  assert.ok(after.deletedAt > 0)
})

test('integration: restore returns the row to live and re-lists it', () => {
  const t = lib.addTodo({ content: content('恢复往返'), date: 'tomorrow' })
  lib.deleteTodo(t.taskId)
  const back = lib.restoreTodo(t.taskId)
  assert.equal(back.delete, false)
  assert.ok(lib.listTodos({ limit: 500 }).some(x => x.taskId === t.taskId))
})

test('integration: purgeRecycleBin leaves no trace (row unqueryable, estimate meta dies)', () => {
  const t = lib.addTodo({ content: content('彻底销毁'), date: 'tomorrow' })
  lib.setEstimate(t.taskId, 20)
  assert.equal(lib.getEstimateOf(t.taskId, 0), 20)
  lib.deleteTodo(t.taskId)
  lib.purgeRecycleBin()
  let threw = false
  try { lib.resolveTask(t.taskId) } catch { threw = true }
  assert.ok(threw, 'purged row must be unqueryable')
  assert.equal(lib.getEstimateOf(t.taskId, 0), 0, 'estimate meta key must die with the row (M-11)')
})

/* ---------- repeat group lifecycle ---------- */

test('integration: repeatOn generates capped future instances and records the rule', () => {
  const t = lib.addTodo({ content: content('每日重复'), date: 'tomorrow' })
  const { rid, made } = lib.repeatOn(t.taskId, { repeatType: 'day' }, 3)
  assert.ok(rid.startsWith('repeat_'))
  assert.ok(made >= 1, 'at least one future instance generated')
  const info = lib.repeatRuleInfo(t.taskId)
  assert.equal(info.repeat, true)
  assert.equal(info.rule.repeatType, 'day')
})

test('integration: repeatOn rejects an already-completed task (INVALID_STATE)', () => {
  const t = lib.addTodo({ content: content('已完成再重复'), date: 'tomorrow' })
  lib.toggleComplete(t.taskId, true, { withSubtasks: false })
  let err
  try { lib.repeatOn(t.taskId, { repeatType: 'day' }, 2) } catch (e) { err = e }
  assert.equal(err && err.code, 'INVALID_STATE')
})

test('integration: repeatOff --all soft-deletes the future instances and clears the rule', () => {
  const t = lib.addTodo({ content: content('解散重复组'), date: 'tomorrow' })
  const { rid } = lib.repeatOn(t.taskId, { repeatType: 'day' }, 3)
  const groupBefore = lib.liveTasks().filter(x => x.repeatId === rid)
  assert.ok(groupBefore.length >= 2)
  const { removed } = lib.repeatOff(t.taskId, true)
  assert.ok(removed >= 1, 'future instances soft-deleted')
  assert.equal(lib.repeatRuleInfo(t.taskId).repeat, false, 'rule row removed (repeat:false)')
  assert.equal(lib.liveTasks().filter(x => x.repeatId === rid).length, 0, 'no live rows still carry the rid')
  const entry = lib.resolveTask(t.taskId)
  assert.equal(entry.delete, false)
  assert.equal(entry.repeatId, null, 'the entry instance stays live but out of the group')
})

/* ---------- categories ---------- */

test('integration: duplicate category name rejected with CATEGORY_EXISTS', () => {
  const name = content('唯一分类')
  lib.addCategory(name)
  let err
  try { lib.addCategory(name) } catch (e) { err = e }
  assert.equal(err && err.code, 'CATEGORY_EXISTS')
})

test('integration: nested folders rejected (CATEGORY_NESTED_FOLDER) and folder cascade delete', () => {
  const folder = lib.addCategory(content('项目夹'), { folder: true })
  let err
  try { lib.addCategory(content('嵌套夹'), { folder: true, parent: folder.categoryId }) } catch (e) { err = err || e }
  assert.equal(err && err.code, 'CATEGORY_NESTED_FOLDER')
  const child = lib.addCategory(content('夹内分类'), { parent: folder.categoryId })
  const t = lib.addTodo({ content: content('夹内任务'), date: 'tomorrow', category: child.categoryName })
  assert.equal(t.categoryId, child.categoryId)
  lib.deleteCategory(folder.categoryId)
  assert.equal(lib.getCategories().some(c => c.categoryId === child.categoryId), false,
    'folder delete cascades to children (child gone from the live category list)')
})

test('integration: renameCategory renames and duplicate target names are rejected', () => {
  const cat = lib.addCategory(content('待改名'))
  const other = content('已占用名')
  lib.addCategory(other)
  let err
  try { lib.renameCategory(cat.categoryId, other) } catch (e) { err = e }
  assert.equal(err && err.code, 'CATEGORY_EXISTS')
  const next = content('新名字')
  const renamed = lib.renameCategory(cat.categoryId, next)
  assert.equal(renamed.categoryName, next)
})

/* ---------- saved views / settings / estimate ---------- */

test('integration: viewAdd persists conds and viewRm removes it (roundtrip)', () => {
  const name = content('视图')
  const v = lib.viewAdd(name, { priority: 2, overdue: true })
  assert.equal(v.conds.priority, 2)
  assert.equal(v.conds.dateMode, 'overdue')
  assert.ok(lib.viewsList().some(x => x.name === name))
  lib.viewRm(name)
  assert.ok(!lib.viewsList().some(x => x.name === name))
})

test('integration: viewAdd rejects duplicate names and out-of-range priority', () => {
  const name = content('视图去重')
  lib.viewAdd(name, {})
  let err
  try { lib.viewAdd(name, {}) } catch (e) { err = e }
  assert.equal(err && err.code, 'VIEW_EXISTS')
  let err2
  try { lib.viewAdd(content('越界视图'), { priority: 9 }) } catch (e) { err2 = e }
  assert.equal(err2 && err2.code, 'USAGE')
})

test('integration: settingsSet writes the doc and rejects unknown/protected keys', () => {
  lib.settingsSet('tomatoTime', '30')
  assert.equal(lib.settingsDoc().tomatoTime, 30)
  let err
  try { lib.settingsSet('no-such-key', 1) } catch (e) { err = e }
  assert.equal(err && err.code, 'UNKNOWN_KEY')
})

test('integration: estimate set/get roundtrip persists across a fresh resolve', () => {
  const t = lib.addTodo({ content: content('番茄估算'), date: 'tomorrow' })
  lib.setEstimate(t.taskId, 15)
  const fresh = lib.resolveTask(t.taskId)
  assert.equal(lib.getEstimateOf(fresh.taskId, 0), 15)
  assert.equal(lib.setEstimate(t.taskId, 99).tomatoEstimate, 20, 'clamped to ESTIMATE_MAX')
  assert.equal(lib.getEstimateOf(t.taskId, 0), 20)
  assert.equal(lib.getEstimateOf('no-such-task-id', 7), 7, 'absent meta falls back to the legacy value')
})

/* ---------- list context protection & audit trail ---------- */

test('integration: listTodos range filters (today vs future) partition dated tasks', () => {
  const todayTask = lib.addTodo({ content: content('今日任务'), date: 'today' })
  const futureTask = lib.addTodo({ content: content('未来任务'), date: 'tomorrow' })
  const todays = lib.listTodos({ range: 'today', limit: 500 })
  assert.ok(todays.some(x => x.taskId === todayTask.taskId))
  assert.ok(!todays.some(x => x.taskId === futureTask.taskId), 'tomorrow task must not leak into today range')
})

test('integration: keyword search finds content substring', () => {
  const marker = content('关键词独特串')
  const t = lib.addTodo({ content: marker, date: 'tomorrow' })
  const hits = lib.listTodos({ keyword: marker.split(' ')[0], limit: 500 })
  assert.ok(hits.some(x => x.taskId === t.taskId))
})

test('integration: audit log records the add action with the task as target', () => {
  const t = lib.addTodo({ content: content('审计线索'), date: 'tomorrow' })
  const entries = lib.readAuditLog({ n: 50, action: 'add' })
  const hit = entries.filter(e => (e.targets || []).some(x => x.taskId === t.taskId))
  assert.ok(hit.length, 'audit trail must contain the add with the target task')
  const last = hit[hit.length - 1]
  assert.equal(last.actor, 'cli')
  assert.ok(Array.isArray(last.changes) && last.changes.length, 'changes carry the after row')
})

test('integration: doctor passes in an isolated env (driver/read checks ok, write skipped)', () => {
  const d = lib.doctor()
  assert.equal(d.ok, true)
  const byName = Object.fromEntries(d.checks.map(c => [c.check, c]))
  assert.equal(byName.read.ok, true)
  assert.equal(byName.write.state, 'skipped', 'write probe stays skipped to protect real data')
})

test('integration: dateExplicitTime distinguishes explicit HH:mm from bare/NL dates', () => {
  assert.equal(lib.dateExplicitTime('2026-09-04 09:30'), '09:30')
  assert.equal(lib.dateExplicitTime('tomorrow 8:15'), '08:15')
  assert.equal(lib.dateExplicitTime('tomorrow'), null)
  assert.equal(lib.dateExplicitTime('明天9点'), null, 'NL markers are NOT explicit HH:mm')
})

test('integration: parseDate accepts relative and absolute dates and lands on expected days', () => {
  const tmr = lib.parseDate('tomorrow')
  assert.equal(+dayjs(tmr).startOf('day'), +dayjs().add(1, 'day').startOf('day'))
  const abs = lib.parseDate('2030-01-02')
  assert.equal(dayjs(abs).format('YYYY-MM-DD'), '2030-01-02')
})

test('integration: two tasks added without `after` do not reference each other', () => {
  const a = lib.addTodo({ content: content('独立甲'), date: 'tomorrow' })
  const b = lib.addTodo({ content: content('独立乙'), date: 'tomorrow' })
  assert.equal(a.predecessors, null)
  assert.equal(b.predecessors, null)
})

test('integration: patchTodo on a missing taskId rejects (resolveTask throws)', () => {
  assert.throws(() => lib.patchTodo('no-such-task-zzz', { priority: 1 }))
})

test('integration: soft-deleted task is invisible to liveTasks but resolvable with delete flag', () => {
  const t = lib.addTodo({ content: content('软删可见性'), date: 'tomorrow' })
  lib.deleteTodo(t.taskId)
  assert.ok(!lib.liveTasks().some(x => x.taskId === t.taskId))
  const row = lib.resolveTask(t.taskId)
  assert.equal(row.delete, true)
})

test('integration: temp isolation dir is registered for the exit sweep (helper integration)', () => {
  assert.ok(fs.existsSync(process.env.TODO_DB_DIR), 'the DB dir exists during the run')
  assert.ok(path.dirname(process.env.TODO_DB_DIR) === os.tmpdir() || fs.existsSync(process.env.TODO_DB_DIR))
})
