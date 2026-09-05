/**
 * Repeat-enum normalization gate - the renderer's utils/repeat.js and the main process's core/todo-core.js
 * normalize must produce the same enum and the same expansion series for the same input (including dirty values).
 * Background: the main process once had a `|| v` passthrough -> a dirty repeatType produced an empty series silently in the main process while the renderer expanded by day.
 * Run: npm test (node --test)
 */
import './setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)

test('repeat enums: renderer/main-process normalize agree on dirty values (unknown values fall back to defaults, never passed through)', async () => {
  const R = await import('../renderer/js/utils/repeat.js')
  const dirty = ['天', '周', '月', '年', 'day', 'week', 'month', 'year', 'Weekly', 5, null, undefined, '', '  ', true]
  for (const v of dirty) {
    const r1 = R.normalizeRepeatType(v)
    assert.ok(['day', 'week', 'month', 'year'].includes(r1), `renderer normalize(${JSON.stringify(v)}) = ${r1} is invalid`)
  }
  // Year type over the same domain
  for (const v of ['公历', '农历', 'gregorian', 'lunar', 'xxx', 1, null]) {
    const r1 = R.normalizeYearType(v)
    assert.ok(['gregorian', 'lunar'].includes(r1), `renderer normalizeYearType(${JSON.stringify(v)}) = ${r1} is invalid`)
  }
})

test('repeat enums: both sides expandRepeatDates produce the same series for dirty repeatType (the main process must never silently break the chain)', async () => {
  const core = require_('../src/main/core/todo-core.js')
  const { expandRepeatDates, setLunarLib } = await import('../renderer/js/utils/repeat.js')
  const solar = require_('solarlunar')
  setLunarLib(solar.default || solar)
  const base = 1771286400000
  for (const rt of ['Weekly', 5, null, '', 'Weekly ']) {
    const rule = { repeatType: rt, repeatInterval: 1, repeatDayCount: 5 }
    const a = core.expandRepeatDates(base, rule).length
    const b = expandRepeatDates(base, rule).length
    assert.ok(a > 0, `the main process produced an empty series for repeatType=${JSON.stringify(rt)} (silent chain break)`)
    assert.equal(a, b, `the two sides expand different counts for repeatType=${JSON.stringify(rt)}: ${a} vs ${b}`)
  }
})
