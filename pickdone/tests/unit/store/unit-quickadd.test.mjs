/**
 * Quick-add effective-date decision (utils/quickAddDate) - the pure logic behind b14f885 making the inbox the default target.
 * Run: npm test
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveQuickAddDate } from '../../../renderer/js/utils/quickAddDate.js'

const TODAY = 1756500000000

test('quickadd: user explicitly chooses no date -> 0; NL parsing no longer applies', () => {
  assert.equal(resolveQuickAddDate({ pickedDate: 0, parsedTs: 123, inTodoBox: false, todayTs: TODAY }), 0)
  assert.equal(resolveQuickAddDate({ pickedDate: 0, parsedTs: 123, inTodoBox: true, todayTs: TODAY }), 0)
})

test('quickadd: an explicitly picked date wins', () => {
  assert.equal(resolveQuickAddDate({ pickedDate: 999, parsedTs: 123, inTodoBox: false, todayTs: TODAY }), 999)
})

test('quickadd: the NL-parsed date applies when nothing is explicitly picked', () => {
  assert.equal(resolveQuickAddDate({ pickedDate: null, parsedTs: 777, inTodoBox: false, todayTs: TODAY }), 777)
})

test('quickadd: nothing specified - the inbox page defaults to 0 (into the inbox); other pages default to today', () => {
  assert.equal(resolveQuickAddDate({ pickedDate: null, parsedTs: null, inTodoBox: true, todayTs: TODAY }), 0)
  assert.equal(resolveQuickAddDate({ pickedDate: null, parsedTs: null, inTodoBox: false, todayTs: TODAY }), TODAY)
})
