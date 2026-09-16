/* H1 regression (2026-09-16): updateRecord clamped restDuration to the inline 120 while the DB
 * layer (src/main/db.js _recToRow) clamps to 600 — an entry-card patch silently truncated a
 * 300-minute rest in memory while the ledger kept 600, diverging on next reload. The store-side
 * cap is now 600, same source as db.js.
 * Run: node --test tests/unit/store/h1-rest-duration-clamp.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import tomato from '../../../renderer/js/store/tomato.js'

function makeState () {
  return {
    tomatoRecordList: [{
      tomatoId: 'tmt_f_1', endTime: Date.now(), dateKey: globalThis.window.dayjs(Date.now()).format('YYYY-MM-DD'),
      focusDuration: 25, restDuration: 0, succeed: true
    }]
  }
}

test('H1: restDuration clamp matches the DB layer cap (600, not 120)', () => {
  const s = makeState()
  tomato.mutations.updateRecord(s, { tomatoId: 'tmt_f_1', patch: { restDuration: 300 } })
  assert.equal(s.tomatoRecordList[0].restDuration, 300, 'a 300-minute rest survives the store clamp')
  tomato.mutations.updateRecord(s, { tomatoId: 'tmt_f_1', patch: { restDuration: 1000 } })
  assert.equal(s.tomatoRecordList[0].restDuration, 600, 'above 600 clamps to the DB-layer cap')
  tomato.mutations.updateRecord(s, { tomatoId: 'tmt_f_1', patch: { restDuration: -5 } })
  assert.equal(s.tomatoRecordList[0].restDuration, 0, 'negative still clamps to 0')
})
