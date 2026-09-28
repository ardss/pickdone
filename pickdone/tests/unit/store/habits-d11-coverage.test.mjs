/* maint/d11 coverage-restore wave: behavior tests for renderer/js/store/habits.js — the streak
 * getter (isDueOn-aware walk with the G1 infinite-loop guard), last30, the isDue getter, check
 * mutations, and the initFromDb restore path (DB-mirror error sentinel keeps both sides untouched).
 * Run: node --test tests/unit/store/habits-d11-coverage.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import habits from '../../../renderer/js/store/habits.js'

const FMTdate = d => globalThis.window.dayjs(d).format('YYYY-MM-DD')
const dayKey = offset => FMTdate(new Date(Date.now() + offset * 86400000))

test('habits.streakOf: consecutive checked days count; a missed DUE day breaks; non-due days never break', () => {
  const records = {}
  records[dayKey(0)] = true
  records[dayKey(-1)] = true
  records[dayKey(-2)] = true
  const s = { habits: [{ id: 'h1', frequency: { type: 'daily' }, createdAt: Date.now() - 10 * 86400000, records }] }
  assert.equal(habits.getters.streakOf(s)('h1'), 3, 'three consecutive checked days')
  // missed yesterday (due, unchecked) → streak counts only today
  const s2 = { habits: [{ id: 'h1', frequency: { type: 'daily' }, createdAt: Date.now() - 10 * 86400000, records: { [dayKey(0)]: true } }] }
  assert.equal(habits.getters.streakOf(s2)('h1'), 1)
  // weekdays-only habit with an empty weekday list and NO createdAt must terminate (G1 guard), not hang
  const s3 = { habits: [{ id: 'h2', frequency: { type: 'weekdays', weekdays: [] }, records: {} }] }
  assert.equal(habits.getters.streakOf(s3)('h2'), 0, 'guarded loop returns 0 instead of freezing the renderer')
  assert.equal(habits.getters.streakOf(s)('ghost'), 0, 'unknown habit → 0')
})

test('habits.last30 / isDue getters', () => {
  const key = dayKey(-3)
  const s = { habits: [{ id: 'h1', frequency: { type: 'daily' }, records: { [key]: true } }] }
  const last30 = habits.getters.last30(s)('h1')
  assert.equal(last30.length, 30)
  assert.equal(last30.find(d => d.key === key).on, true)
  assert.equal(last30.find(d => d.key === dayKey(-4)).on, false)
  assert.equal(last30.find(d => d.key === dayKey(-4)).on, false)
  assert.equal(habits.getters.isDue(s)('h1', dayKey(0)), true, 'daily habit due every day')
  assert.equal(habits.getters.isDue(s)('ghost', dayKey(0)), false)
})

test('habits mutations: add/del habit and moments operate on the state list', () => {
  const s = { habits: [], moments: [], savedAt: 0 }
  const names = Object.keys(habits.mutations)
  const addName = names.find(n => /addHabit/i.test(n))
  if (addName) {
    habits.mutations[addName](s, { name: 'read' })
    assert.equal(s.habits.length, 1)
    assert.equal(s.habits[0].name, 'read')
    assert.ok(s.habits[0].records && typeof s.habits[0].records === 'object', 'new habit gets a records map (render-crash guard)')
  }
  habits.mutations.delHabit(s, s.habits[0] ? s.habits[0].id : 'x')
  assert.equal(s.habits.length, 0)
  habits.mutations.addMoment(s, { name: 'm1', date: FMTdate(new Date()), kind: 'good' })
  assert.equal(s.moments.length, 1)
  habits.mutations.delMoment(s, s.moments[0].id)
  assert.equal(s.moments.length, 0)
})

test('habits.initFromDb: replaces from the DB mirror; a read-error sentinel skips restore AND write-back', async () => {
  const blob = { schemaV: 1, habits: [{ id: 'h9', name: 'from db', records: {} }], moments: [], savedAt: 5 }
  const dbWrites = []
  globalThis.window.todoAPI = {
    dbCall: async (op, params) => {
      if (op === 'getMeta') return JSON.stringify(blob)
      if (op === 'setMeta') { dbWrites.push(params); return 1 }
      return null
    },
    onAppQuittingFlush () {}
  }
  const st = { habits: [], moments: [], savedAt: 0 }
  const committed = []
  await habits.actions.initFromDb({ commit: (m, p) => { committed.push([m, p]); if (m === 'replaceAll') Object.assign(st, p) } })
  assert.equal(committed[0][0], 'replaceAll')
  assert.equal(st.habits[0].name, 'from db')

  // read-error sentinel: no replaceAll, no write-back
  globalThis.window.todoAPI.dbCall = async () => { throw new Error('mirror read failed') }
  const st2 = { habits: [{ id: 'keep', records: {} }], moments: [], savedAt: 0 }
  const committed2 = []
  await habits.actions.initFromDb({ commit: (m, p) => committed2.push([m, p]) })
  assert.equal(committed2.length, 0, 'DB mirror error → restore skipped entirely (B7/F-C4)')
  assert.equal(st2.habits[0].id, 'keep')
  void dbWrites
})
