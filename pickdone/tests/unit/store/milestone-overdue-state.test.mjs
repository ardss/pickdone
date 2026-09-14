/* G3 fix regression (2026-09-14): milestoneState must not treat every past-dated milestone as 'done'.
 * A past date with linked unfinished tasks is 'overdue' (red ✗ on the timeline, red ring, overdue-days
 * tag); 'done' only when all linked tasks are complete — or when the milestone carries no (surviving)
 * linked tasks, where the legacy date-driven contract applies (see milestones.js docstring).
 * Omitting `tasks` keeps the legacy behavior for old callers. No electron required.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const TODAY = 1700000000000 // any instant; caller supplies today0 explicitly (no dayjs dependency)

// milestones.js → core.js → i18n needs a window shim before the dynamic import (same as f6-milestones.test.mjs)
globalThis.window = { todoAPI: { dbCall: async () => null } }

const mod = await import('../../../renderer/js/utils/milestones.js')
const { milestoneState } = mod

const tasks = [
  { taskId: 't1', complete: true },
  { taskId: 't2', complete: false }
]

test('过期 + 关联任务未全完成 → overdue', () => {
  assert.equal(milestoneState({ date: TODAY - 864e5, taskIds: ['t1', 't2'] }, TODAY, tasks), 'overdue')
  assert.equal(milestoneState({ date: TODAY - 864e5, taskIds: ['t2'] }, TODAY, tasks), 'overdue',
    '仅部分完成同样不算达成')
})

test('过期 + 关联任务全完成 → done', () => {
  assert.equal(milestoneState({ date: TODAY - 864e5, taskIds: ['t1'] }, TODAY, [{ taskId: 't1', complete: true }]), 'done')
})

test('过期 + 无关联任务 → done（遗留日期驱动契约，无法判定完成度）', () => {
  assert.equal(milestoneState({ date: TODAY - 864e5 }, TODAY, tasks), 'done')
  assert.equal(milestoneState({ date: TODAY - 864e5, taskIds: [] }, TODAY, tasks), 'done')
})

test('过期 + 关联任务全部已被删除（tasks 中找不到）→ done（无从判定，退回日期驱动）', () => {
  assert.equal(milestoneState({ date: TODAY - 864e5, taskIds: ['gone'] }, TODAY, tasks), 'done')
})

test('未来日期 → future；今天 → today', () => {
  assert.equal(milestoneState({ date: TODAY + 864e5, taskIds: ['t2'] }, TODAY, tasks), 'future')
  assert.equal(milestoneState({ date: TODAY, taskIds: ['t2'] }, TODAY, tasks), 'today')
})

test('省略 tasks 参数 → 遗留行为（过期即 done），向后兼容', () => {
  assert.equal(milestoneState({ date: TODAY - 864e5, taskIds: ['t2'] }, TODAY), 'done')
})
