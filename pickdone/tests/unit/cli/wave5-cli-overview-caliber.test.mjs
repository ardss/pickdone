/**
 * Wave-5 P3 (behavior fix — the only one in this domain): CLI overview() keyed `today` on the
 * schedDay caliber (dayStart || startOfDay(todoTime)) but left overdue/noDate/upcoming7days on
 * the bare dayStart, so a pure-todoTime (dayStart=0) row was miscounted into noDate and vanished
 * from overdue/upcoming7days — disagreeing with the today block and with the renderer
 * (renderer/js/views/statistics/metrics.js:38, ds = dayStart || startOfDay(todoTime)).
 * Run: node --test tests/unit/cli/wave5-cli-overview-caliber.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const dayjs = require_('dayjs')

test('CLI overview: pure-todoTime (dayStart=0) rows count into overdue/upcoming7days by schedDay and stay OUT of noDate', () => {
  const d = dayjs
  const mkRow = (id, over = {}) => ({ taskId: id, complete: false, dayStart: 0, todoTime: 0, delete: false, ...over })
  const rows = [
    // pure todoTime yesterday -> overdue (was invisible: dayStart>0 required)
    mkRow('ovr', { todoTime: +d().subtract(1, 'day').hour(10) }),
    // pure todoTime in 3 days -> upcoming7days (was invisible)
    mkRow('up', { todoTime: +d().add(3, 'day').hour(9) }),
    // pure todoTime today -> counted in today, NOT in noDate (was miscounted into noDate)
    mkRow('td', { todoTime: +d().hour(8) }),
    // genuinely no date
    mkRow('nd')
  ]
  const lib = require_('../../../cli/lib-tasks.cjs')({
    dayjs: d,
    CliError: class CliError extends Error {},
    parseDate: x => x,
    normKey: x => x,
    open: () => ({ call: (name) => name === 'queryTodos' ? rows : [] })
  })
  const ov = lib.overview()
  assert.equal(ov.overdue, 1, 'pure-todoTime yesterday counts as overdue')
  assert.equal(ov.upcoming7days, 1, 'pure-todoTime +3d counts as upcoming7days')
  assert.equal(ov.noDate, 1, 'only the genuinely undated row stays in noDate (today pure-todoTime excluded)')
  assert.equal(ov.today.total, 1, 'today caliber unchanged')
  // regression against the old reading: dayStart-only caliber would report overdue=0, upcoming=0, noDate=3
  assert.ok(ov.overdue === 1 && ov.upcoming7days === 1 && ov.noDate === 1, 'full schedDay caliber on all three buckets')
})
