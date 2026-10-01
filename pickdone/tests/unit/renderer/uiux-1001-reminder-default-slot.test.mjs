/**
 * [uiux-2026-10-01 J2 P3] 添加提醒 defaulted a new reminder row to 09:00 even at 17:00+, and the
 * in-past reminder was accepted — a past reminder never fires, so the user silently loses the
 * reminder's core promise. New rows for TODAY now default to the next half-hour slot instead
 * (future days keep 09:00; EditPanel's past-time warning stays as the backstop).
 * Run: node --test tests/unit/renderer/uiux-1001-reminder-default-slot.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import '../../setup.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const url = p => 'file://' + path.join(ROOT, p).replace(/\\/g, '/')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

// Parse EpReminders.vue's defaultRemindTime into a standalone function for behavior testing:
// the SFC method body only uses dayjs/FMT which the unit harness provides.
async function loadDefaultRemindTime () {
  const src = read('renderer/js/components/edit-panel/EpReminders.vue')
  const m = src.match(/defaultRemindTime \(day0\) \{([\s\S]*?)\n {4}\},/)
  assert.ok(m, 'defaultRemindTime helper present')
  const { dayjs, FMT } = await import(url('renderer/js/utils/core.js'))
  return new Function('dayjs', 'FMT', `return function (day0) {${m[1]}}`)(dayjs, FMT)
}

test('J2 P3: a today reminder row defaults to a slot in the future, not 09:00', async () => {
  const fn = await loadDefaultRemindTime()
  const dayjs = (await import(url('renderer/js/utils/core.js'))).dayjs
  const today0 = +dayjs().startOf('day')
  const out = fn(today0)
  assert.match(out, /^\d{2}:\d{2}$/, 'returns a HH:mm time')
  // Whatever the current wall clock, the default must not be before now (a past reminder never fires)
  const [h, mi] = out.split(':').map(Number)
  const chosen = dayjs(today0).hour(h).minute(mi).second(0).millisecond(0).valueOf()
  assert.ok(chosen > Date.now() - 60000, `default ${out} is not in the past`)
})

test('J2 P3: a future-day reminder row still defaults to 09:00', async () => {
  const fn = await loadDefaultRemindTime()
  const dayjs = (await import(url('renderer/js/utils/core.js'))).dayjs
  const future0 = +dayjs().add(7, 'day').startOf('day')
  assert.equal(fn(future0), '09:00')
  assert.equal(fn(null), '09:00', 'undated rows keep the 09:00 convention')
})
