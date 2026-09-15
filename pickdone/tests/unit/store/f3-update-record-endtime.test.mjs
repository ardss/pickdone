/**
 * F3[2] 回归:updateRecord 对无效 endTime(<=0/NaN)拒绝该字段。
 * 旧代码 Math.max(0, …) 把 0 写进 endTime,且 DB 层无条件用 endTime 导 dateKey → 掉进 1970 桶。
 * Run: node --test tests/unit/store/f3-update-record-endtime.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import tomato from '../../../renderer/js/store/tomato.js'

const DAY = 86400000

function makeState () {
  return {
    tomatoRecordList: [{
      tomatoId: 'tmt_f_1', endTime: Date.now(), dateKey: tomatoSafe(), focusDuration: 25, restDuration: 5, succeed: true
    }]
  }
}
// dateKey 与 endTime 同日(用被测模块同款 dayjs 约定)
function tomatoSafe () {
  return tomatoDayjs(Date.now())
}
function tomatoDayjs (ts) {
  return globalThis.window.dayjs(ts).format('YYYY-MM-DD')
}

test('updateRecord: endTime 无效值(0/负数/NaN)整字段拒绝,不产生 1970 桶', () => {
  for (const bad of [0, -5, NaN]) {
    const s = makeState()
    const before = s.tomatoRecordList[0]
    tomato.mutations.updateRecord(s, { tomatoId: 'tmt_f_1', patch: { endTime: bad, focusDuration: 30 } })
    const rec = s.tomatoRecordList[0]
    assert.equal(rec.endTime, before.endTime, 'endTime=' + bad + ' 被拒绝,原值保留')
    assert.equal(rec.dateKey, before.dateKey, 'dateKey 不被重导到 1970 桶')
    assert.equal(rec.focusDuration, 30, '同一 patch 里的有效字段照常生效')
  }
})

test('updateRecord: 有效 endTime 照常更新并重导 dateKey(原行为保留)', () => {
  const s = makeState()
  const yesterday = Date.now() - DAY
  tomato.mutations.updateRecord(s, { tomatoId: 'tmt_f_1', patch: { endTime: yesterday } })
  const rec = s.tomatoRecordList[0]
  assert.equal(rec.endTime, Math.round(yesterday))
  assert.equal(rec.dateKey, tomatoDayjs(yesterday), 'dateKey 跟随新 endTime')
})
