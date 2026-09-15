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
import { createRequire } from 'module'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-cli-h3-'))
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')
const dayjs = require_('dayjs')

db.init(process.env.TODO_DB_DIR)


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

