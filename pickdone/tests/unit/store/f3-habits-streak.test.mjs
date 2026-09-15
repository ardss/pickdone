/**
 * F3[6] 回归:streakOf 回溯此前不调用 isDueOn,按日历逐日要求记录——周一三五习惯在周日"断签"。
 * 修法:非打卡日跳过不计断;今天应打未打仍不断签(原宽限口径)。
 * Run: node --test tests/unit/store/f3-habits-streak.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { default: habitsStore, isDueOn } = await import('../../../renderer/js/store/habits.js')

const dayKey = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')

function habitWith (frequency, recordDays) {
  const s = habitsStore.state()
  s.habits = [{
    id: 'h1', name: 'x', createdAt: Date.now() - 30 * 86400000,
    frequency, records: Object.fromEntries(recordDays.map(k => [k, true]))
  }]
  return s
}

test('streak: 周一三五习惯跨周日连续(此前周日无记录就断签)', () => {
  // 回填过去 14 天内所有应打卡日(必然跨越至少一个周日)
  const records = []
  const d = new Date(); d.setDate(d.getDate() - 14)
  const dueDays = []
  for (let i = 0; i < 14; i++) {
    const k = dayKey(d)
    if (isDueOn({ frequency: { type: 'weekdays', weekdays: [0, 2, 4] } }, k)) { dueDays.push(k); records.push(k) }
    d.setDate(d.getDate() + 1)
  }
  assert.ok(dueDays.length >= 4, '样本里确有多个打卡日(含跨周日)')
  const s = habitWith({ type: 'weekdays', weekdays: [0, 2, 4] }, records)
  const streak = habitsStore.getters.streakOf(s)('h1')
  // 今天若为打卡日且未打卡:宽限不断签,只数到昨天为止的连续打卡日;否则全部计入
  const today = dayKey(new Date())
  const expected = isDueOn({ frequency: { type: 'weekdays', weekdays: [0, 2, 4] } }, today)
    ? dueDays.filter(k => k !== today).length
    : dueDays.length
  assert.equal(streak, expected, 'streak 跨非打卡日(周日)保持连续')
})

test('streak: 应打卡日缺记录仍断签(修法不放松真正的断签)', () => {
  const d = new Date()
  const keys = []
  for (let i = 14; i >= 1; i--) { const x = new Date(d); x.setDate(d.getDate() - i); keys.push(dayKey(x)) }
  const freq = { type: 'weekdays', weekdays: [0, 2, 4] }
  const due = keys.filter(k => isDueOn({ frequency: freq }, k))
  assert.ok(due.length >= 3, '样本里确有足够打卡日')
  // 缺"次新"的那个打卡日:它必是过去日(非今天宽限位)→ streak 在此断开,只剩更新的一天
  const gap = due[due.length - 2]
  const recorded = due.filter(k => k !== gap)
  const s1 = habitWith(freq, recorded)
  assert.equal(habitsStore.getters.streakOf(s1)('h1'), 1, '缺口处断签,只保留缺口之后的一天')
})

test('streak: daily 习惯无记录不断言为正数;interval 习惯回溯到 createdAt 即停(不死循环)', () => {
  const s1 = habitWith({ type: 'daily' }, [])
  assert.equal(habitsStore.getters.streakOf(s1)('h1'), 0)
  const s2 = habitsStore.state()
  s2.habits = [{ id: 'h2', name: 'i', createdAt: Date.now(), frequency: { type: 'interval', intervalN: 2 }, records: {} }]
  assert.equal(habitsStore.getters.streakOf(s2)('h2'), 0, 'createdAt 护栏使回溯终止')
})
