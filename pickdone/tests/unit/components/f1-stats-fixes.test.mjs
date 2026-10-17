/**
 * F1 fixes regression (2026-10-18), statistics view models:
 *   1. heatmap trailing streak: future cells (rest of current week) neither counted nor break the streak
 *   2. heatmap day-caliber: calendar-day stepping (dayShift) — window stays 7*weeks cells with unique
 *      date keys across a DST fall-back day (ms stepping reproduced a duplicated 23:00 key)
 *   3. timeline 24h dedup key includes tomatoId — distinct real records are not swallowed
 *   4. streak cap unified at 3650 across metrics.js / achievements.js
 *
 * Run: node --test tests/unit/components/f1-stats-fixes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'
import { execFileSync } from 'child_process'

// Browser-host globals before utils load (utils/core.js expects the UMD dayjs global, isoWeek extended).
const require_ = createRequire(import.meta.url)
const dayjs = require_('dayjs')
dayjs.extend(require_('dayjs/plugin/isoWeek'))
globalThis.window = globalThis
globalThis.dayjs = dayjs

const { buildHeatmap, buildTimelineRows } = await import('../../../renderer/js/views/statistics/chartModels.js')

const NOW = new Date(2026, 9, 14, 12, 0, 0).getTime() // 2026-10-14 (Wednesday), noon local
const t = (k, p) => k + (p ? JSON.stringify(p) : '')
const todo = (id, ts) => ({ taskId: id, complete: true, delete: false, completedAt: ts, updateTime: ts })

test('heatmap streak: done today, rest of the week empty (future cells) -> streak counts today', () => {
  // NOW is mid-week: everything after today up to the window's Sunday is future grid
  const hm = buildHeatmap({ todos: [todo('a', NOW)], records: [], weeks: 26, nowTick: NOW })
  const last = hm.cells[hm.cells.length - 1]
  assert.ok(new Date(last.key).getTime() > NOW, 'window still ends on the coming Sunday')
  assert.equal(hm.streak, 1)
})

test('heatmap streak: today empty, yesterday done -> streak counts from yesterday', () => {
  const hm = buildHeatmap({ todos: [todo('a', NOW - 24 * 3600 * 1000)], records: [], weeks: 26, nowTick: NOW })
  assert.equal(hm.streak, 1)
})

test('heatmap streak: two consecutive days then a gap -> streak stops at the gap', () => {
  const day = 24 * 3600 * 1000
  const hm = buildHeatmap({
    todos: [todo('a', NOW), todo('b', NOW - day), todo('c', NOW - 3 * day)],
    records: [], weeks: 26, nowTick: NOW
  })
  assert.equal(hm.streak, 2)
})

test('heatmap window is calendar-exact: weeks*7 cells, one key per day (col/dow layout preserved)', () => {
  const hm = buildHeatmap({ todos: [], records: [], weeks: 26, nowTick: NOW })
  assert.equal(hm.cells.length, 26 * 7)
  assert.equal(new Set(hm.cells.map(c => c.key)).size, 26 * 7, 'no duplicated date keys (24h stepping signature)')
  const lastCol = hm.cells[hm.cells.length - 1]
  assert.equal(lastCol.col, 25)
  assert.equal(lastCol.dow, 6)
  assert.equal(new Date(lastCol.key).getDay(), 0)
})

test('heatmap across a DST fall-back day still yields one cell per calendar day (child proc, TZ=America/New_York)', () => {
  // 2026-11-01 is a Sunday and US fall-back day (clocks 2:00->1:00, a 25h day).
  // The pre-fix ms stepping (start += DAY_MS) lands on 23:00 of the same day after the
  // transition and duplicates a date key; the dayShift stepping must not.
  // Windows dev hosts ignore the TZ env var, so when the child's offset matches this
  // process's (no DST simulation possible) we fall back to a source-level guard: the
  // heatmap loop must consume dayShift and contain no ms day step.
  const script = `
    const require_ = require('module').createRequire(process.cwd() + '/');
    const dayjs = require_('dayjs'); dayjs.extend(require_('dayjs/plugin/isoWeek'));
    globalThis.window = globalThis; globalThis.dayjs = dayjs;
    import(${JSON.stringify(new URL('../../../renderer/js/views/statistics/chartModels.js', import.meta.url).href)}).then(m => {
      const now = new Date(2026, 10, 2, 12, 0, 0).getTime() // Monday after the fall-back Sunday
      const hm = m.buildHeatmap({ todos: [], records: [], weeks: 26, nowTick: now })
      const keys = hm.cells.map(c => c.key)
      console.log(JSON.stringify({
        n: hm.cells.length, uniq: new Set(keys).size, last: keys[keys.length - 1],
        off: -new Date(now).getTimezoneOffset() / 60
      }))
    })
  `
  const out = execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8', cwd: process.cwd()
  })
  const { n, uniq, last, off } = JSON.parse(out.trim().split('\n').pop())
  const localOff = -new Date(2026, 10, 2).getTimezoneOffset() / 60
  if (off === localOff) {
    // TZ env not effective here (e.g. Windows without tzset) — guard the mechanism instead.
    const src = require_('fs').readFileSync(new URL('../../../renderer/js/views/statistics/chartModels.js', import.meta.url), 'utf8')
    assert.match(src, /ts = \+dayShift\(ts, 1\)/, 'heatmap loop steps via the calendar dayShift primitive')
    assert.doesNotMatch(src, /ts \+= day\b/, 'no ms day step left in the heatmap loop')
    return
  }
  assert.equal(n, 26 * 7)
  assert.equal(uniq, 26 * 7, 'fall-back day must not duplicate a date key')
  assert.equal(new Date(last).getDay(), 0, 'still ends on the current week Sunday')
})

test('timeline dedup: distinct records (different tomatoId) with identical times both count', () => {
  const today = +dayjs(NOW).startOf('day')
  const noon = today + 12 * 3600 * 1000
  const mk = id => ({ tomatoId: id, endTime: String(noon), focusDuration: 25, restDuration: 0, succeed: true, focus: 'TaskA' })
  const rows = buildTimelineRows({ records: [mk('p1'), mk('p2')], todos: [], t, now: NOW })
  assert.equal(rows[6].count, 2, 'both real records counted')
  assert.equal(rows[6].minutes, 50, 'focus minutes not swallowed')
})

test('timeline dedup: a fully identical duplicate (same tomatoId) is still deduped', () => {
  const today = +dayjs(NOW).startOf('day')
  const noon = today + 12 * 3600 * 1000
  const mk = () => ({ tomatoId: 'p1', endTime: String(noon), focusDuration: 25, restDuration: 0, succeed: true, focus: 'TaskA' })
  const rows = buildTimelineRows({ records: [mk(), mk()], todos: [], t, now: NOW })
  assert.equal(rows[6].count, 1)
  assert.equal(rows[6].minutes, 25)
})

test('streak cap unified at 3650 in metrics.js and achievements.js', () => {
  const fs = require_('fs')
  const metrics = fs.readFileSync(new URL('../../../renderer/js/views/statistics/metrics.js', import.meta.url), 'utf8')
  const achievements = fs.readFileSync(new URL('../../../renderer/js/views/statistics/achievements.js', import.meta.url), 'utf8')
  assert.match(metrics, /i < 3650/, 'metrics streak cap is 3650')
  assert.doesNotMatch(metrics, /i < 365\b/, 'no old 365 cap left')
  assert.match(achievements, /i < 3650/, 'achievements streak cap is 3650')
})
