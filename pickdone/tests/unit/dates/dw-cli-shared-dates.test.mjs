/**
 * dw wave — P2-1/P2-3: shared milestone-date parsing (shared/parse-date.mjs) + CLI parseDate
 * bare-M/D interception.
 *
 * Behavior fixes pinned here:
 *  - '9/22', '9.22' (any of the three separators) resolve to the CURRENT year, not 2001
 *    (V8 fallback Date parse used to land them 25 years in the past with isValid()===true).
 *  - Invalid month/day combos ('2-30', '13/1') return null / throw instead of dayjs's
 *    silent carry-over ('2026-2-30' used to come back as Mar 2).
 *  - Renderer utils/milestones.js and cli/lib.js parseMilestoneDate are the same core.
 *
 * Run: node --test tests/unit/dates/dw-cli-shared-dates.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-dw-dates-'))
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')
const { parseMilestoneDateCore } = require_('../../../shared/parse-date.mjs')
db.init(process.env.TODO_DB_DIR)

const dayjs = require_('dayjs')
const isoWeek = require_('dayjs/plugin/isoWeek')
dayjs.extend(isoWeek)

const year = dayjs().year()

test('shared core: bare M/D across all three separators resolves to the current year at 00:00 (not 2001)', () => {
  for (const s of ['9/22', '9.22', '9-22', '12/25']) {
    const ts = parseMilestoneDateCore(s, dayjs)
    assert.ok(ts, `${s} must parse`)
    const d = dayjs(ts)
    assert.equal(d.year(), year, `${s} must land in ${year}, got ${d.format()}`)
    assert.equal(d.format('HH:mm'), '00:00', `${s} must be start of day`)
  }
  const expected = +dayjs(`${year}-09-22`).startOf('day')
  assert.equal(parseMilestoneDateCore('9/22', dayjs), expected)
})

test('shared core: invalid month/day returns null instead of a silent carry-over', () => {
  assert.equal(parseMilestoneDateCore('2-30', dayjs), null, 'Feb 30 must not carry over to Mar 2')
  assert.equal(parseMilestoneDateCore('13/1', dayjs), null)
  assert.equal(parseMilestoneDateCore('0/5', dayjs), null)
  assert.equal(parseMilestoneDateCore('', dayjs), null)
})

test('shared core: keyword and relative forms keep working', () => {
  assert.equal(parseMilestoneDateCore('today', dayjs), +dayjs().startOf('day'))
  assert.equal(parseMilestoneDateCore('明天', dayjs), +dayjs().add(1, 'day').startOf('day'))
  assert.equal(parseMilestoneDateCore('+3d', dayjs), +dayjs().add(3, 'day').startOf('day'))
  assert.equal(parseMilestoneDateCore('-2d', dayjs), +dayjs().subtract(2, 'day').startOf('day'))
  const ymd = parseMilestoneDateCore('2026-09-22', dayjs)
  assert.equal(dayjs(ymd).format('YYYY-MM-DD'), '2026-09-22')
})

test('renderer milestones.parseMilestoneDate uses the shared core (P2-3 dedup, same results)', async () => {
  const { parseMilestoneDate } = await import('../../../renderer/js/utils/milestones.js')
  for (const s of ['9/22', '9.22', '9-22', '2-30', 'today', '2026-09-22']) {
    assert.equal(parseMilestoneDate(s), parseMilestoneDateCore(s, dayjs), `renderer diverges on ${JSON.stringify(s)}`)
  }
  const d = dayjs(parseMilestoneDate('12/25'))
  assert.equal(d.year(), year, `renderer '12/25' must land in ${year}, got ${d.format()}`)
})

test('cli lib.parseMilestoneDate uses the shared core (P2-3 dedup, same results)', () => {
  for (const s of ['9/22', '9.22', '2-30', 'today', '+14d']) {
    assert.equal(lib.parseMilestoneDate(s), parseMilestoneDateCore(s, dayjs), `CLI diverges on ${JSON.stringify(s)}`)
  }
})

test('cli parseDate: bare M/D and M/D HH:mm resolve to the current year (P2-1, --deadline vector)', () => {
  const ts = lib.parseDate('9/22')
  assert.equal(dayjs(ts).year(), year, `'9/22' used to fall into 2001 via the V8 fallback`)
  assert.equal(dayjs(ts).format('HH:mm'), '00:00')
  const ts2 = lib.parseDate('12/25 14:30')
  const d2 = dayjs(ts2)
  assert.equal(d2.year(), year)
  assert.equal(d2.format('HH:mm'), '14:30')
})

test('cli parseDate: invalid bare month/day throws instead of silently landing 2001', () => {
  assert.throws(() => lib.parseDate('2-30'), /invalid date/)
  assert.throws(() => lib.parseDate('13/1'), /invalid date/)
})

test('cli parseDate: existing explicit forms unaffected', () => {
  assert.equal(dayjs(lib.parseDate('2026-09-22')).format('YYYY-MM-DD'), '2026-09-22')
  assert.throws(() => lib.parseDate('2026-02-30'), /invalid date/)
  assert.throws(() => lib.parseDate('nope-date'), /cannot parse date/)
})

/* ---------- P2: bare relative forms normalize to midnight (parity with renderer nlDate) ---------- */
// The renderer's nlDate applies .startOf('day') to today/tomorrow/yesterday/+Nd; the CLI used to
// keep wall-clock h:m:s.ms, so EditPanel showed a time chip the user never picked and (via the
// D27 renewal anchor) repeat instances minted at 14:37 instead of 00:00.
const { parseNaturalDate } = await import('../../../renderer/js/utils/nlDate.js')
const appMidnight = input => { const nl = parseNaturalDate(input); return nl && nl.date ? +nl.date : null }

test('cli parseDate: bare relative forms land on local midnight, matching the renderer nlDate', () => {
  for (const s of ['today', '今天', 'tomorrow', '明天', 'yesterday', '昨天', '+3d', '-1w', '+2m']) {
    const ts = lib.parseDate(s)
    const d = dayjs(ts)
    assert.equal(d.format('HH:mm:ss.SSS'), '00:00:00.000', `${s} must normalize to midnight, got ${d.format()}`)
  }
  // cross-channel byte parity: the App's nlDate handles the English + offset forms directly
  // (the renderer file routes Chinese words through the shared core, so parity there is pinned
  // by the midnight assertion above + tests/unit/dates/unit-nl-en.test.mjs)
  for (const s of ['today', 'tomorrow', 'yesterday', '+3d', '-1w', '+2m']) {
    const app = appMidnight(s)
    assert.ok(app != null, `setup: nlDate parses ${s}`)
    assert.equal(lib.parseDate(s), app, `${s}: CLI and App must produce identical bytes`)
  }
})

test('cli parseDate: time-suffixed offsets keep their explicit time (offTime branch untouched)', () => {
  const d = dayjs(lib.parseDate('+3d 14:30'))
  assert.equal(d.format('HH:mm'), '14:30', 'explicit time must survive the normalization')
  assert.equal(+d.startOf('day'), +dayjs().add(3, 'day').startOf('day'), 'day part is still D+3')
  const kw = dayjs(lib.parseDate('tomorrow 09:15'))
  assert.equal(kw.format('HH:mm'), '09:15', 'keyword+time combos keep their time')
  assert.equal(+kw.startOf('day'), +dayjs().add(1, 'day').startOf('day'))
})
