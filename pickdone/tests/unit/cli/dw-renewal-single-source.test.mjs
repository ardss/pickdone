/**
 * dw wave — P2-4: repeat renewal decision + carried fields sink into the shared core
 * (shared/repeat-core.mjs via src/main/core/todo-core.js), single source for the CLI twin
 * (cli/lib.js toggleComplete renewal) and the renderer twin (store/todo.js ensureNextRepeatInstance).
 * Pins:
 *  - isLastRepeatInstance: only the group's last instance renews; no-date instances never renew.
 *  - renewalCarryFields: exactly the D5 parity set with `t.x || 0` semantics (both twins consume it).
 * Run: node --test tests/unit/cli/dw-renewal-single-source.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const core = require_('../../../src/main/core/todo-core.js')
const { isLastRepeatInstance, renewalCarryFields } = await import('../../../shared/repeat-core.mjs')

test('P2-4: isLastRepeatInstance — future instance present → no renewal; last instance → renew', () => {
  const group = [
    { taskId: 'a', dayStart: 100 },
    { taskId: 'b', dayStart: 200 },
    { taskId: 'c', dayStart: 300 }
  ]
  assert.equal(core.isLastRepeatInstance(group[1], group), false, 'middle instance must not renew')
  assert.equal(core.isLastRepeatInstance(group[2], group), true, 'last instance renews')
  assert.equal(core.isLastRepeatInstance({ dayStart: 0 }, group), false, 'no-date instance never renews (1970 guard)')
  assert.equal(core.isLastRepeatInstance(group[2], []), false, 'empty group → no renewal')
})

test('P2-4: shared core and todo-core re-export are the same functions (single source, no copy)', () => {
  assert.equal(core.isLastRepeatInstance, isLastRepeatInstance)
  assert.equal(core.renewalCarryFields, renewalCarryFields)
})

test('P2-4: renewalCarryFields — D5 parity set with `t.x || 0` fallbacks', () => {
  const t = {
    reminderOffsets: [5], reminderExtra: [{ ts: 1 }], difficulty: 2, priority: 3,
    deadlineTs: 12345, important: 1, urgent: 0, repeatId: 'r1',
    estimate: 7 // NOT carried here (CLI resolves the live meta estimate separately)
  }
  const out = renewalCarryFields(t, { reminderTime: 999 })
  assert.deepEqual(out, {
    reminderTime: 999,
    reminderOffsets: [5], reminderExtra: [{ ts: 1 }],
    difficulty: 2, priority: 3, deadlineTs: 12345, important: 1, urgent: 0,
    repeatId: 'r1'
  })
  const zeros = renewalCarryFields({ repeatId: 'r2' }, { reminderTime: 0 })
  assert.equal(zeros.difficulty, 0)
  assert.equal(zeros.priority, 0)
  assert.equal(zeros.deadlineTs, 0)
  assert.equal(zeros.important, 0)
  assert.equal(zeros.urgent, 0)
  assert.deepEqual(zeros.reminderOffsets, [])
  assert.deepEqual(zeros.reminderExtra, [])
})
