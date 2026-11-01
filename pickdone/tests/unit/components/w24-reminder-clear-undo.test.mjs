/**
 * W24 P2 —「删除最后一行提醒 → 撤销」丢 reminderOffsets 回归。
 *
 * 根因:removeRemindRow 删空后走 clearRemind → onRemindersClear 把 reminderOffsets 清零并
 * queueSave([]) 落库;撤销走 commitReminders → onRemindersCommit,其 patch 只含
 * {reminderTime, reminderExtra, todoTime},不含 reminderOffsets —— 提醒恢复而 chips 永久丢失。
 *
 * 修法:do() 的 clear 分支快照删前 offsets,undo 在 commit 之后经 'offsets' 通道恢复。
 *
 * 本测试驱动真实的 removeRemindRow/commitReminders 方法体(从 .vue 源提取,new Function 求值,
 * h7 pure-block 先例)+ 真实 reminderOps host 处理器,断言最终 queueSave/patch 流水。
 *
 * Run: node --test tests/unit/components/w24-reminder-clear-undo.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { dayjs, FMT } from '../../../renderer/js/utils/core.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const SRC = readFileSync(path.join(ROOT, 'renderer/js/components/edit-panel/EpReminders.vue'), 'utf8')
const OPS = await import(pathToFileURL(path.join(ROOT, 'renderer/js/components/editpanel/reminderOps.js')).href)

/** Extract a plain-JS method body from the SFC and evaluate it as a standalone function
 *  (module imports are injected as parameters). */
function extractMethod (name, params) {
  const m = SRC.match(new RegExp(name + ' \\(i?\\w*\\)? \\{([\\s\\S]*?)\\n    \\},'))
  assert.ok(m, `method ${name} not found in EpReminders.vue`)
  // eslint-disable-next-line no-new-func
  return new Function(...params, m[1])
}

const DAY = dayjs().startOf('day').add(1, 'day').valueOf()
const R1 = dayjs(DAY).hour(9).valueOf()
const R2 = dayjs(DAY).hour(10).valueOf()

/** A fake component `this` whose emits route into the REAL reminderOps host handlers, so the
 *  assertion covers the full snapshot+queueSave pipeline exactly like EditPanel does. */
function makeHarness () {
  const patches = []
  const host = {
    e: { taskId: 't1', dateTs: DAY, remindTs: R1, reminderExtra: [R2], reminderOffsets: [-10] },
    queueSave (p) { patches.push(p) },
    $message: null,
    $t: k => k
  }
  const emitted = []
  const vm = {
    remindOpen: false,
    remindRows: [],
    task: host.e,
    commitReminders () { commitRemindersFn.call(this, dayjs, FMT) },
    clearRemind () { this.remindOpen = false; this.$emit('clear') },
    $emit (ev, a, b) {
      emitted.push([ev, a, b])
      if (ev === 'commit') OPS.onRemindersCommit(host, a, b)
      else if (ev === 'clear') OPS.onRemindersClear(host)
      else if (ev === 'offsets') OPS.onRemindersOffsets(host, a)
    }
  }
  const calls = []
  const removeWithUndo = (self, doRemove, undo) => { calls.push({ doRemove, undo }); doRemove() }
  const sameTask = (a, b) => !!a && a === b
  const removeRemindRowFn = extractMethod('removeRemindRow', ['i', 'removeWithUndo', 'sameTask'])
  const commitRemindersFn = extractMethod('commitReminders', ['dayjs', 'FMT'])
  return {
    vm, host, patches, emitted,
    removeRemindRow (i) { removeRemindRowFn.call(vm, i, removeWithUndo, sameTask) },
    undoLast () { const c = calls[calls.length - 1]; assert.ok(c && c.undo, 'no undo captured'); c.undo() }
  }
}

test('w24: 删最后一行(主提醒)→ clear 落库 offsets=[],撤销后 remindTs 与 reminderOffsets 都恢复', () => {
  const h = makeHarness()
  h.vm.remindRows = [
    { date: DAY, time: '09:00' }, // row 0 = main reminder
    { date: DAY, time: '10:00' }  // row 1 = extra
  ]
  // 1) delete the extra row — ordinary commit path
  h.removeRemindRow(1)
  assert.equal(h.host.e.remindTs, R1, 'main reminder survives the extra-row removal')
  assert.equal(h.host.e.reminderOffsets.length, 1, 'offsets untouched by the ordinary removal')
  // 2) delete the LAST row → the clear path wipes AND persists offsets=[]
  h.removeRemindRow(0)
  assert.equal(h.host.e.remindTs, 0, 'clear resets the reminder')
  assert.deepEqual(h.host.e.reminderOffsets, [], 'clear wipes offsets in the snapshot (onRemindersClear invariant)')
  const clearPatch = h.patches.find(p => p.reminderOffsets && p.reminderTime === 0)
  assert.ok(clearPatch, 'the clear persists reminderOffsets: []')
  // 3) undo — reminders come back AND the offset chips must come back with them
  h.undoLast()
  assert.equal(h.host.e.remindTs, R1, 'undo restores the reminder timestamp')
  assert.deepEqual(h.host.e.reminderOffsets, [-10], 'undo restores the offsets the clear persist had wiped')
  const lastPatch = h.patches[h.patches.length - 1]
  assert.deepEqual(lastPatch.reminderOffsets, [-10], 'the restored offsets reach queueSave (persisted, not snapshot-only)')
})

test('w24: 普通删除(仍有余行)的撤销不引入 offsets 恢复(行为不回归)', () => {
  const h = makeHarness()
  h.vm.remindRows = [{ date: DAY, time: '09:00' }, { date: DAY, time: '10:00' }]
  h.removeRemindRow(1)
  h.undoLast()
  assert.equal(h.host.e.remindTs, R1)
  assert.deepEqual(h.host.e.reminderOffsets, [-10], 'offsets stay as they were')
  const lastPatch = h.patches[h.patches.length - 1]
  assert.ok(!('reminderOffsets' in lastPatch), 'the ordinary-commit undo does not emit/persist offsets (no spurious write)')
})

test('w24: 撤销跨任务守卫仍生效 — clear 路径的 offsets 也不跨任务恢复', () => {
  const h = makeHarness()
  h.vm.remindRows = [{ date: DAY, time: '09:00' }]
  h.removeRemindRow(0) // clear path with the offsets snapshot captured
  const newTask = { taskId: 't2', dateTs: DAY, remindTs: 0, reminderExtra: [], reminderOffsets: [] } // panel switched tasks
  h.vm.task = newTask
  h.host.e = newTask
  h.undoLast()
  assert.equal(h.host.e.taskId, 't2', 'the host now edits the new task')
  assert.deepEqual(h.host.e.reminderOffsets, [], 'the previous task\'s offsets are NOT restored across the switch')
})
