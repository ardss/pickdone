/* w29 P3 regression: cross-midnight manual tomato backfill landed its endTime in the FUTURE.
 *
 * Bug: taskMenu.js backfill clamped startTs to today's 00:00 when `now - min2*60000` reached
 * before midnight, but computed endTime as startTs + min2*60000 — backfilling e.g. 120min at
 * 00:30 produced endTime 02:30 of a day that had only lived 30 minutes. The record's dateKey
 * (derived from endTime) and its timeline slot sat ahead of now.
 *
 * Fix: endTime is clamped to now as well (endTs <= now always); the record still carries the
 * user's requested focusDuration.
 *
 * Run: node --test tests/unit/utils/w29-backfill-endtime-clamp.test.mjs
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import '../../setup.mjs' // injects window.dayjs (UMD stand-in) before the utils import

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
// augment (not replace) setup.mjs's window so window.dayjs survives
globalThis.window = Object.assign(globalThis.window || {}, { location: { hash: '' }, todoAPI: { dbCall: async () => ({ ok: true }) } })

const { dayjs } = await import('../../../renderer/js/utils/core.js')
const { buildTaskMenu } = await import('../../../renderer/js/utils/taskMenu.js')

let realNow = null
/** 00:30 LOCAL today — only 30 focus-capable minutes have elapsed since midnight */
function freezeAtHalfPastMidnight () {
  realNow = Date.now
  const now = +dayjs().startOf('day') + 30 * 60000
  Date.now = () => now
  return now
}

after(() => { if (realNow) Date.now = realNow })

function makeVm (task) {
  const commits = []
  const vm = {
    $store: {
      state: { todo: { todoList: [task] }, tomato: {} },
      commit (mut, payload) { commits.push({ mut, payload }) },
      dispatch () {}
    },
    $t: (k) => k,
    $message: { success () {}, warning () {}, error () {} },
    $prompt: () => Promise.resolve({ value: '120' })
  }
  return { vm, commits }
}

function findBackfillItem (vm) {
  const items = buildTaskMenu(vm, { taskId: 't1', taskContent: 'writing', tomato: true }, { move: false })
  return items.find(i => i.icon === 'plus')
}

test('P3: backfilling 120min at 00:30 clamps endTime to now (never lands in the future)', async () => {
  const now = freezeAtHalfPastMidnight()
  const task = { taskId: 't1', taskContent: 'writing', tomato: true, complete: false }
  const { vm, commits } = makeVm(task)
  const item = findBackfillItem(vm)
  assert.ok(item, 'the manual-backfill menu item (icon plus) must exist for tomato tasks')
  item.fn()
  await new Promise(r => setTimeout(r, 0)) // $prompt resolves → backfill(n)
  const rec = commits.find(c => c.mut === 'tomato/addRecord')
  assert.ok(rec, 'backfill commits tomato/addRecord')
  assert.ok(rec.payload.endTime <= now,
    `endTime (${rec.payload.endTime}) must not exceed now (${now}) after the midnight clamp`)
  assert.equal(rec.payload.focusDuration, 120, 'the requested duration is preserved on the record')
  assert.ok(rec.payload.dateKey, 'dateKey still derives from endTime')
})

test('P3: a normal mid-day backfill (start inside today) keeps the exact startTs+duration arithmetic', async () => {
  realNow = Date.now
  const now = +dayjs().startOf('day') + 8 * 3600000 // 08:00 today: 120min back reaches 06:00, no clamp
  Date.now = () => now
  const task = { taskId: 't2', taskContent: 'reading', tomato: true, complete: false }
  const { vm, commits } = makeVm(task)
  const item = findBackfillItem(vm)
  item.fn()
  await new Promise(r => setTimeout(r, 0))
  const rec = commits.find(c => c.mut === 'tomato/addRecord')
  assert.ok(rec.payload.endTime <= now)
  assert.equal(rec.payload.endTime, now, 'unclamped backfill: startTs=now-120min, so endTime lands exactly on now')
})
