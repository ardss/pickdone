/** H3 fix-round regression tests (2026-09-16) — covers:
 *  1. settingsSet CAS guard: concurrent App-side settings writes are detected via _savedAt drift and the
 *     whole-package write is refused (SETTINGS_STALE); --force bypasses.
 *  2. importEvents: future-dated events only create the task (no fabricated complete + ledger backfill).
 *  3. SETTINGS_MANIFEST enum drift: expiredUncompletedTodoRange no longer accepts 'today' (renderer enum parity).
 *  4. guessUserId empty-DB fallback is 840001 (renderer parity), not 0.
 *  6. stats --from/--to go through parseDate (keywords like `today` work, bad input fails fast in the CLI).
 *  7. settings set numbers: non-finite (Infinity) and negative values rejected.
 *  8. list --range week = ISO week (saved-view/FilterView parity); next7d carries the old rolling-7-days window.
 *  9. recordFix restDuration clamp is 600 (db.js _recToRow parity), not 120.
 *  Isolated temp DB via TODO_DB_DIR, never touches real data (unit-cli-v03/v04 pattern).
 *  Run: node --test tests/unit/cli/h3-agent-fixes.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'module'
import { fileURLToPath } from 'node:url'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-cli-h3-'))
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')
const dayjs = require_('dayjs')

db.init(process.env.TODO_DB_DIR)

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')

const ymdOf = offset => dayjs().add(offset, 'day').format('YYYY-MM-DD')

/* ---- fix 1: settingsSet CAS guard ---- */
test('h3-1: settingsSet refuses the whole-package write when the App changed settings since read', () => {
  // App baseline in the meta store
  db.call('setMeta', ['db.settingsState', JSON.stringify({ colorMode: 'light', _savedAt: 1000, schemaV: 1 })])
  const orig = db.call
  let reads = 0
  try {
    db.call = function (op, p) {
      const r = orig.call(db, op, p)
      // after the 2nd internal read (snapshot + working doc), simulate an App-side write bumping _savedAt
      if (op === 'getMeta' && p === 'db.settingsState' && ++reads === 2) {
        orig.call(db, 'setMeta', ['db.settingsState', JSON.stringify({ colorMode: 'dark', whiteNoiseVolume: 0.7, _savedAt: 2000, schemaV: 1 })])
      }
      return r
    }
    assert.throws(() => lib.settingsSet('colorMode', 'dark'), e => e.code === 'SETTINGS_STALE' && /--force/.test(e.message))
  } finally {
    db.call = orig
  }
  const after = JSON.parse(db.call('getMeta', 'db.settingsState'))
  assert.equal(after._savedAt, 2000, 'the CLI must not clobber the App-side package')
  assert.equal(after.whiteNoiseVolume, 0.7, "the App's concurrent setting survives")

  // --force bypasses the guard deliberately
  const r = lib.settingsSet('colorMode', 'dark', { force: true })
  assert.equal(r.value, 'dark')
})

test('h3-1b: settingsSet without interleaved writes still succeeds (no false stale)', () => {
  const r = lib.settingsSet('calendarFontSize', 'large')
  assert.equal(r.value, 'large')
})

/* ---- fix 2: importEvents future events ---- */
test('h3-2: future-dated event creates the task only — no complete toggle, no ledger backfill', async () => {
  const before = db.call('tomatoAll').length
  const res = await lib.importEvents([
    { date: ymdOf(7), start: '09:00', end: '10:00', title: 'h3未来事件' },
    { date: ymdOf(-1), start: '09:00', end: '10:00', title: 'h3过去事件' }
  ])
  assert.equal(res.created, 2)
  assert.equal(res.failed.length, 0)
  const tasks = lib.liveTasks().filter(t => String(t.taskContent).startsWith('h3'))
  const future = tasks.find(t => t.taskContent === 'h3未来事件')
  const past = tasks.find(t => t.taskContent === 'h3过去事件')
  assert.ok(future && past)
  assert.equal(future.complete, false, 'a future event must not be imported as already done')
  assert.equal(past.complete, true, 'past events keep the backfill reconstruction behavior')
  const after = db.call('tomatoAll').length
  assert.equal(after - before, 1, 'exactly one focus record (the past event); the future event fabricates none')
})

/* ---- fix 3: enum drift ---- */
test("h3-3: expiredUncompletedTodoRange rejects 'today' (renderer enum parity)", () => {
  assert.throws(() => lib.settingsSet('expiredUncompletedTodoRange', 'today'), e => e.code === 'USAGE')
  const r = lib.settingsSet('expiredUncompletedTodoRange', '30d')
  assert.equal(r.value, '30d')
})

/* ---- fix 4: guessUserId fallback ---- */
test('h3-4: empty-DB userId fallback is 840001 (renderer parity), applied to created tasks', () => {
  // fresh DB in a subprocess: the shared test DB already has rows (userId 1), so the fallback is unreachable here
  const script = `
    const assert = require('assert')
    process.env.TODO_DB_DIR = ${JSON.stringify(fs.mkdtempSync(path.join(os.tmpdir(), 'todo-cli-h3-fresh-')))}
    const lib = require(${JSON.stringify(path.join(ROOT, 'cli/lib.js'))})
    assert.equal(lib.guessUserId(), 840001)
    const t = lib.addTodo({ content: 'h3uid', date: 'today' })
    const row = lib.open().call('getById', t.taskId)
    assert.equal(row.userId, 840001, 'task created on an empty DB must carry the renderer userId, not 0')
    console.log('OK')
  `
  const out = execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    cwd: ROOT,
    env: { ...process.env, NODE_PATH: path.join(ROOT, 'node_modules') },
    // the -e script needs assert + a module resolver anchored at the repo
    stdio: ['ignore', 'pipe', 'pipe']
  })
  assert.ok(out.includes('OK'))
})

/* ---- fix 6: stats date parsing ---- */
test('h3-6: stats accepts keyword dates (--from today) and rejects garbage with a CLI error', () => {
  const rows = lib.stats({ from: 'today', to: 'today' })
  assert.ok(Array.isArray(rows))
  assert.throws(() => lib.stats({ from: 'not-a-date' }), e => /cannot parse date/.test(e.message))
})

/* ---- fix 7: number setting validation ---- */
test('h3-7: settings set rejects non-finite and negative numbers', () => {
  assert.throws(() => lib.settingsSet('dailyTomatoTarget', 'Infinity'), e => e.code === 'USAGE')
  assert.throws(() => lib.settingsSet('autoBackupIntervalMin', '-5'), e => e.code === 'USAGE' && />= 0/.test(e.message))
  assert.throws(() => lib.settingsSet('dailyTomatoTarget', 'abc'), e => e.code === 'USAGE')
  const r = lib.settingsSet('dailyTomatoTarget', '12')
  assert.equal(r.value, 12)
})

/* ---- fix 8: week vs next7d ranges ---- */
test('h3-8: --range week is the ISO week; next7d keeps the rolling 7-day window', () => {
  for (let d = 0; d <= 9; d++) {
    lib.addTodo({ content: 'h3range' + d, date: ymdOf(d) })
  }
  const today0 = +dayjs().startOf('day')
  const weekEnd = +dayjs().endOf('isoWeek')
  const rollEnd = +dayjs().add(7, 'day').endOf('day')
  const inRange = rows => new Set(rows.filter(t => String(t.taskContent).startsWith('h3range')).map(t => Number(t.taskContent.slice(7))))
  const week = inRange(lib.listTodos({ range: 'week', limit: 500 }))
  const next7 = inRange(lib.listTodos({ range: 'next7d', limit: 500 }))
  for (let d = 0; d <= 9; d++) {
    const day0 = +dayjs().add(d, 'day').startOf('day')
    assert.equal(week.has(d), day0 >= today0 && day0 <= weekEnd, `week membership for +${d}d must match the isoWeek window`)
    assert.equal(next7.has(d), day0 >= today0 && day0 <= rollEnd, `next7d membership for +${d}d must match the rolling window`)
  }
  // the two windows genuinely differ (there is always a day inside rolling-7 but outside the iso week on Mon-Sat)
  if (+dayjs().endOf('isoWeek') < rollEnd) assert.ok([...next7].some(d => !week.has(d)), 'next7d must extend beyond the iso week when the week ends first')
})

/* ---- fix 9: restDuration clamp ---- */
test('h3-9: recordFix rest clamp is 600 (db-layer parity), not 120', () => {
  const rec = lib.backfillRecord({ content: 'h3rest', date: ymdOf(-1), at: '20:00', minutes: 25 })
  const fixed = lib.recordFix(rec.tomatoId, { rest: 400 })
  assert.equal(fixed.rec.restDuration, 400, 'a legitimate 400-min rest must not be clamped to 120')
  const clamped = lib.recordFix(rec.tomatoId, { rest: 700 })
  assert.equal(clamped.rec.restDuration, 600, 'over-limit rest clamps to the same 600 the db layer enforces')
})
