/** CLI/browser-shim fix regression tests — isolated temp DB via TODO_DB_DIR, never touches real data.
 *  Covers: undo subtask uncheck symmetry (#2) / isCompleteWithSubtasks gate (#1) / repeat reminderTime per-instance re-derive (#3)
 *  / repeat cap from settings.maxRepeat (#4) / record fix 600-min clamp errors (#6) / shim tomatoAppendMany dateKey re-derive (#8).
 *  Run: node --test tests/cli-fixes-subtasks-repeat-ledger.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { ANCHORS, REPO_ROOT } from '../../lib/source-anchors.mjs'
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'module'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-cli-fixes-'))
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
    reminderTime: 0, reminderOffsets: [], estimate: 0, difficulty: 0,
    repeatId: null, subtasks: null, image: null, files: null,
    categoryId: 0, updateTime: now, syncTime: 0,
    taskContent: '任务', taskDescribe: '',
    taskSort: 0, todoTime: 0, userId: 1, status: 'add', version: 0, ...over
  }
  if (!t.taskId) t.taskId = core.genTaskId(1, now)
  db.call('upsert', t)
  return db.call('getById', t.taskId)
}

/** settingsDoc mirror via CLI (meta db.settingsState) */
function setSetting (key, value) {
  let doc = {}
  try { doc = JSON.parse(db.call('getMeta', 'db.settingsState') || 'null') || {} } catch { /* rebuild */ }
  doc[key] = value
  doc._savedAt = Date.now()
  doc.schemaV = doc.schemaV || 1
  db.call('setMeta', ['db.settingsState', JSON.stringify(doc)])
}
function clearSetting (key) {
  let doc = {}
  try { doc = JSON.parse(db.call('getMeta', 'db.settingsState') || 'null') || {} } catch { /* rebuild */ }
  delete doc[key]
  db.call('setMeta', ['db.settingsState', JSON.stringify(doc)])
}

test('#1/#2 complete honors isCompleteWithSubtasks=false; undo unchecks symmetrically', () => {
  // default (no setting): complete cascades to subtasks, undo unchecks them (symmetry with renderer toggleComplete)
  const a = seed({ taskContent: '修复级联默认', subtasks: JSON.stringify([{ text: '子甲', checked: false }, { text: '子乙', checked: false }]) })
  const done = lib.toggleComplete(a.taskId, true)
  assert.equal(done.completed.complete, true)
  assert.ok(lib.parseSubs(done.completed).every(s => s.checked), 'default complete must check all subtasks')
  const undone = lib.toggleComplete(a.taskId, false)
  assert.equal(undone.complete, false)
  assert.ok(lib.parseSubs(undone).every(s => !s.checked), 'undo must uncheck all subtasks (else subsCompleteTarget re-completes the parent)')

  // setting off: neither direction cascades
  setSetting('isCompleteWithSubtasks', false)
  const b = seed({ taskContent: '修复级联关', subtasks: JSON.stringify([{ text: '子丙', checked: false }]) })
  const done2 = lib.toggleComplete(b.taskId, true)
  assert.equal(lib.parseSubs(done2.completed)[0].checked, false, 'isCompleteWithSubtasks=false must skip the cascade')
  const undone2 = lib.toggleComplete(b.taskId, false)
  assert.equal(lib.parseSubs(undone2)[0].checked, false)
  clearSetting('isCompleteWithSubtasks')

  // explicit override beats the setting (CLI --no-sub-cascade)
  const c = seed({ taskContent: '修复级联覆盖', subtasks: JSON.stringify([{ text: '子丁', checked: false }]) })
  const done3 = lib.toggleComplete(c.taskId, true, { withSubtasks: false })
  assert.equal(lib.parseSubs(done3.completed)[0].checked, false, 'explicit withSubtasks:false overrides the setting')
})

test('#3 repeat on re-derives reminderTime per instance (wall-clock kept, date re-based)', () => {
  const base = +dayjs().add(1, 'day').startOf('day')
  const tpl = seed({ taskContent: '修复提醒重导Unique', todoTime: base, reminderTime: +dayjs(base).hour(9).minute(30) })
  const rule = lib.buildRepeatRule({ type: 'daily', interval: 1 })
  const r = lib.repeatOn(tpl.taskId, rule, 3)
  assert.ok(r.made >= 1)
  const group = db.call('queryTodos', { deleted: 0, repeatId: r.rid })
  const future = group.filter(t => t.taskId !== tpl.taskId)
  assert.ok(future.length >= 1)
  for (const inst of future) {
    assert.equal(dayjs(inst.reminderTime).hour(), 9, 'instance reminder keeps the template wall-clock hour')
    assert.equal(dayjs(inst.reminderTime).minute(), 30)
    assert.equal(dayjs(inst.reminderTime).startOf('day').valueOf(), dayjs(inst.todoTime).startOf('day').valueOf(),
      'instance reminder must land on the instance day, not the template day')
  }
  lib.repeatOff(tpl.taskId, true)
})

test('#4 repeat generation cap defaults to settings.maxRepeat (default 2), explicit count overrides', () => {
  clearSetting('maxRepeat')
  const base = +dayjs().add(2, 'day').startOf('day')
  const t1 = seed({ taskContent: '修复上限缺省Unique', todoTime: base })
  const r1 = lib.repeatOn(t1.taskId, lib.buildRepeatRule({ type: 'daily', interval: 1 }), 0)
  assert.equal(r1.made, 2, 'default cap must be maxRepeat default 2, not the old hardcoded 24')
  lib.repeatOff(t1.taskId, true)

  setSetting('maxRepeat', '4')
  const t2 = seed({ taskContent: '修复上限设置Unique', todoTime: base })
  const r2 = lib.repeatOn(t2.taskId, lib.buildRepeatRule({ type: 'daily', interval: 1 }), 0)
  assert.equal(r2.made, 4, 'maxRepeat setting must raise the default cap')
  lib.repeatOff(t2.taskId, true)
  clearSetting('maxRepeat')

  const t3 = seed({ taskContent: '修复上限显式Unique', todoTime: base })
  const r3 = lib.repeatOn(t3.taskId, lib.buildRepeatRule({ type: 'daily', interval: 1 }), 5)
  assert.equal(r3.made, 5, 'explicit --count must override the setting')
  lib.repeatOff(t3.taskId, true)
})

test('#6 record fix rejects >600 minutes with USAGE (DB clamp is 600, old 720 was silent truncation)', () => {
  const rec = lib.backfillRecord({ content: '修复上限审计', date: dayjs().format('YYYY-MM-DD'), at: '10:00', minutes: 25 })
  assert.throws(
    () => lib.recordFix(rec.tomatoId, { minutes: 601 }),
    e => e.code === 'USAGE',
    '>600 must fail with USAGE, not silently clamp'
  )
  const ok = lib.recordFix(rec.tomatoId, { minutes: 600 })
  assert.equal(ok.rec.focusDuration, 600)
  lib.recordRemove(rec.tomatoId)
})

test('#8 browser shim tomatoAppendMany re-derives dateKey from endTime (desktop db.js parity)', async () => {
  // Minimal browser globals; the shim is a browser IIFE, loaded in a vm sandbox
  const store = new Map()
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k)
  }
  const window = { dayjs, console }
  const sandbox = { window, localStorage, console, URLSearchParams, setTimeout, clearTimeout, location: { search: '', href: 'http://localhost:5175/' } }
  vm.createContext(sandbox)
  const code = fs.readFileSync(path.join(REPO_ROOT, ANCHORS.browserShim), 'utf8')
  vm.runInContext(code, sandbox)
  // 22:50 on day D plus a 25min focus ends 23:15 same day; feed a WRONG caller dateKey (next day) and expect the derived one
  const endTime = +dayjs('2026-06-01 23:15')
  await window.todoAPI.dbCall('tomatoAppendMany', { tomatoId: 'tmt_fixtest_1', endTime, dateKey: '2026-06-02', focusDuration: 25 })
  const m = JSON.parse(localStorage.getItem('appBrowserShim.meta'))
  const rec = m.__shimTomatoRecords.find(r => r.tomatoId === 'tmt_fixtest_1')
  assert.ok(rec, 'record persisted')
  assert.equal(rec.dateKey, '2026-06-01', 'dateKey must be re-derived from endTime, caller value distrusted')
})
