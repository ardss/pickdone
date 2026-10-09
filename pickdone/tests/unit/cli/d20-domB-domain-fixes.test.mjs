/**
 * D20-DOMB — CLI + shared domain fixes (B2/B3/B5/B6/B14/B7/B8/B9).
 * Harnesses the factory-injected lib modules directly (unit-cli pattern, no real DB needed).
 *   B2  lib-repeat renewRepeatAfterComplete: a UNIQUE(idx_todos_repeat_day) violation racing the
 *       pre-check resolves to the existing twin instead of throwing past the done path.
 *   B3  repeat-core renewalCarryFields: reminderExtra are SHIFTED by the renewal day-diff (never
 *       carried verbatim → past-dated extras accumulated forever and forced needsCatchUp reloads).
 *   B5  lib-reminders setReminderOffsets: |offset| > 43200 min is a USAGE error echoing the limit
 *       (the DB normOffsets silently dropped it before).
 *   B6  lib-restore-backup discovery now matches evt-* snapshots too (App twin accepts both tags).
 *   B14 the same discovery uses the STRICT autoBackup stamp regexes — collision-suffixed copies
 *       ("...json (1)") are excluded instead of sorting in as epoch-0 stamps.
 *   B7  lib-eventbackup writes through durable-fs.writeFileDurable (App twin crash-safety).
 *   B8  lib-categories addCategory re-mints on an id collision instead of silently overwriting
 *       the same-ms row via the category upsert.
 *   B9  lib-projects addMilestone pre-stamps the milestone id and echoes BY ID (the old
 *       title+date match echoed a pre-existing duplicate).
 * Run: node --test tests/unit/cli/d20-domB-domain-fixes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const PKG = path.resolve(process.cwd())
process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-cli-d20-'))

const requireP = rel => require(path.join(PKG, rel))
const CliError = class extends Error {
  constructor (msg, code) { super(msg); this.code = code }
}
const dayjs = requireP('node_modules/dayjs')
const DAY = 86400000

/* ---------------- B2: renewal UNIQUE violation resolves to the existing twin ---------------- */
test('B2: UNIQUE(idx_todos_repeat_day) on the renewal insert resolves to the existing same-day twin', () => {
  const now = Date.now()
  const t = { taskId: 'src1', repeatId: 'r1', dayStart: now, todoTime: now, reminderTime: now + 3600000, userId: 840001, estimate: 0, taskContent: 'x' }
  const twin = { taskId: 'twin1', repeatId: 'r1', dayStart: now + DAY, complete: false }
  let phase = 0
  const db = {
    call: (op, args) => {
      if (op === 'queryTodos') {
        if (args && args.dayStartFrom != null) return ++phase === 1 ? [] : [twin] // pre-check empty, post-violation read finds the concurrent twin
        return [{ taskId: t.taskId, dayStart: t.dayStart }] // repeat group (the completed instance is the last)
      }
      if (op === 'getMeta') return JSON.stringify({ repeatType: 'day', repeatInterval: 1, repeatDayCount: 5 })
      return null
    }
  }
  const commits = []
  const { renewRepeatAfterComplete } = requireP('cli/lib-repeat.cjs')({
    open: () => db,
    commit: (ent, verb, payload) => { commits.push([ent, verb, payload]); throw new Error('UNIQUE constraint failed: todos.recurGroupId, todos.scheduledDay') },
    audit: { record: () => {} }, CliError, dayjs,
    core: requireP('src/main/core/todo-core.js'),
    resolveTask: () => t, liveTasks: () => [t], normKey: k => k, settingsDoc: () => ({}),
    chipsSnapshotForDelete: () => {}, dayStartOf: ts => +dayjs(ts).startOf('day'),
    clampEstimate: v => v, getEstimateOf: () => 0, estimateKey: id => 'tomatoEstimateState:' + id
  })
  const r = renewRepeatAfterComplete(db, t, { ...t, complete: true })
  assert.equal(r, twin, 'red before the fix: the UNIQUE throw propagated past the done path; now it resolves to the twin')
  assert.equal(commits.length, 1, 'exactly one insert attempt was made')
})

test('B2: a NON-unique-violation insert error still propagates', () => {
  const t = { taskId: 'src2', repeatId: 'r2', dayStart: now0(), todoTime: now0(), reminderTime: 0, userId: 840001, estimate: 0 }
  const db = {
    call: (op, args) => {
      if (op === 'queryTodos') return (args && args.dayStartFrom != null) ? [] : [{ taskId: t.taskId, dayStart: t.dayStart }]
      if (op === 'getMeta') return JSON.stringify({ repeatType: 'day', repeatInterval: 1, repeatDayCount: 5 })
      return null
    }
  }
  const { renewRepeatAfterComplete } = requireP('cli/lib-repeat.cjs')({
    open: () => db,
    commit: () => { throw new Error('disk on fire') },
    audit: { record: () => {} }, CliError, dayjs,
    core: requireP('src/main/core/todo-core.js'),
    resolveTask: () => t, liveTasks: () => [t], normKey: k => k, settingsDoc: () => ({}),
    chipsSnapshotForDelete: () => {}, dayStartOf: ts => +dayjs(ts).startOf('day'),
    clampEstimate: v => v, getEstimateOf: () => 0, estimateKey: id => 'k' + id
  })
  assert.throws(() => renewRepeatAfterComplete(db, t, { ...t, complete: true }), /disk on fire/)
})
function now0 () { return +dayjs().startOf('day') }

/* ---------------- B3: renewalCarryFields shifts reminderExtra by the renewal day-diff ---------------- */
test('B3: reminderExtra are shifted by the renewal day-diff, not carried verbatim', async () => {
  const { renewalCarryFields } = await import('file://' + path.join(PKG, 'shared/repeat-core.mjs').replace(/\\/g, '/'))
  const D = +dayjs().startOf('day')
  const extra = D + 9 * 3600000 // 09:00 on the source day
  const out = renewalCarryFields(
    { dayStart: D, reminderExtra: [extra, 'junk', 0, -5], reminderOffsets: [-10], priority: 2, repeatId: 'r1' },
    { todoTime: D + 2 * DAY, reminderTime: 0 }
  )
  assert.deepEqual(out.reminderExtra, [extra + 2 * DAY], 'red before the fix: extras rode onto the renewal verbatim (stuck in the past)')
  assert.deepEqual(out.reminderOffsets, [-10], 'offsets stay relative — carried as-is')
  assert.equal(out.priority, 2)
})

test('B3: no day anchor on the source → extras are dropped, never carried at a wrong day', async () => {
  const { renewalCarryFields } = await import('file://' + path.join(PKG, 'shared/repeat-core.mjs').replace(/\\/g, '/'))
  const out = renewalCarryFields({ reminderExtra: [12345] }, { todoTime: Date.now(), reminderTime: 0 })
  assert.deepEqual(out.reminderExtra, [])
})

/* ---------------- B5: --remind-offset bound ---------------- */
function remindersLib () {
  const patched = []
  const lib = requireP('cli/lib-reminders.cjs')({
    resolveTask: () => ({ taskId: 't1', reminderTime: Date.now() + 3600000 }),
    liveTasks: () => [], patchTodo: (id, patch) => patched.push([id, patch]),
    CliError, dayjs, parseDate: s => +dayjs(s)
  })
  return { lib, patched }
}
test('B5: an offset beyond ±43200 minutes is a USAGE error echoing the limit (DB dropped it silently before)', () => {
  const { lib } = remindersLib()
  try { lib.setReminderOffsets('t1', '50000'); assert.fail('must throw') } catch (e) {
    assert.equal(e.code, 'USAGE')
    assert.match(e.message, /43200/)
  }
  try { lib.setReminderOffsets('t1', '-43201'); assert.fail('must throw') } catch (e) { assert.equal(e.code, 'USAGE') }
})
test('B5: the boundary 43200 itself is accepted', () => {
  const { lib, patched } = remindersLib()
  const r = lib.setReminderOffsets('t1', '43200,10')
  assert.deepEqual(r.reminderOffsets, [-43200, -10])
  assert.equal(patched.length, 1)
})

/* ---------------- B6 + B14: restore-backup discovery tags + strict stamps ---------------- */
test('B6+B14: discovery lists evt-* snapshots and excludes collision-suffixed copies', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-baks-'))
  process.env.TODO_BACKUP_DIR = dir // backup-roots honors the explicit env first (single candidate)
  for (const f of ['auto-20260101-010101.json', 'evt-purge-20260101-020202.json', 'auto-20260101-010101 (1).json', 'note.txt']) {
    fs.writeFileSync(path.join(dir, f), '{}')
  }
  let emitted = null
  requireP('cli/lib-restore-backup.cjs')({
    opts: { _: [], json: true },
    lib: { userDataDir: () => path.join(os.tmpdir(), 'todo-no-db-here'), settingsDoc: () => ({}) },
    emit: o => { emitted = o }
  })
  const names = emitted.snapshots.map(s => s.file).sort()
  assert.ok(names.includes('auto-20260101-010101.json'))
  assert.ok(names.includes('evt-purge-20260101-020202.json'), 'red before the fix: evt-* snapshots were invisible to the CLI')
  assert.ok(!names.includes('auto-20260101-010101 (1).json'), 'red before B14: suffixed copies listed with an epoch-0 stamp')
  assert.ok(!names.includes('note.txt'))
})

/* ---------------- B7: event snapshot write goes through durable-fs ---------------- */
test('B7: writePurgeEventSnapshot publishes the snapshot with no tmp residue (durable write)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-evt-'))
  const r = requireP('cli/lib-eventbackup.cjs').writePurgeEventSnapshot({
    dir, rows: [{ taskId: 't1' }], liveRows: [], metaEntries: [], reason: 'purge'
  })
  assert.equal(r.ok, true)
  const text = fs.readFileSync(path.join(dir, r.file), 'utf8')
  assert.equal(JSON.parse(text).backup.purgedRows[0].taskId, 't1')
  const residue = fs.readdirSync(dir).filter(f => f.endsWith('.tmp') || f.endsWith('.dtmp'))
  assert.deepEqual(residue, [], 'no temp residue after a successful durable write')
})

/* ---------------- B8: category id mint collision re-mints instead of overwriting ---------------- */
test('B8: a same-ms id collision re-mints into a free space (no silent upsert overwrite)', () => {
  const T = 1700000000000
  const origNow = Date.now
  const origRandom = Math.random
  Date.now = () => T
  Math.random = () => 0.5
  try {
    const commits = []
    const existing = [{ categoryId: T * 1000 + 500, categoryName: 'Taken' }]
    const catsLib = requireP('cli/lib-categories.cjs')({
      open: () => ({ call: op => op === 'getAllCategories' ? existing : null }),
      commit: (ent, verb, row) => commits.push(row), audit: { record: () => {} }, CliError,
      resolveCategory: () => { throw new Error('not used') }, projectFlagKey: k => 'f' + k,
      projectStatusKey: k => 's' + k, MS_KEY: k => 'ms' + k, PROJECT_IDS_KEY: 'projectCategoryIds'
    })
    const cat = catsLib.addCategory('New')
    assert.equal(cat.categoryId, T * 1000 + 500000, 'red before the fix: the mint stayed T*1000+500 and the upsert overwrote the existing row')
    assert.equal(commits.length, 1)
  } finally {
    Date.now = origNow
    Math.random = origRandom
  }
})

/* ---------------- B9: addMilestone echoes the appended row by id ---------------- */
test('B9: addMilestone with a duplicate title+date echoes the NEW row (id-stamped), not the pre-existing one', () => {
  const D = +dayjs('2026-05-01')
  const preExisting = { id: 'ms_old', title: 'Same', date: D, taskIds: [] }
  const blobs = { 'projectMilestones:1': JSON.stringify([preExisting]) }
  const writes = []
  const projLib = requireP('cli/lib-projects.cjs')({
    open: () => ({ call: (op, k) => op === 'getMeta' ? blobs[k] : (op === 'getAllCategories' ? [{ categoryId: 1, categoryName: 'C' }] : null) }),
    CliError, dayjs, commit: (ent, verb, payload) => writes.push([ent, verb, payload]),
    audit: { record: () => {} }, resolveCategory: () => 1, resolveTask: () => { throw new Error('not used') },
    liveTasks: () => [], tomatoRecords: () => [], parseDate: s => +dayjs(s), dayStartOf: ts => ts,
    parseMilestoneDateCore: requireP('shared/parse-date.mjs').parseMilestoneDateCore
  })
  const r = projLib.addMilestone('1', 'Same', '2026-05-01')
  assert.ok(r.added.id && r.added.id !== 'ms_old', 'red before the fix: the title+date echo returned the PRE-EXISTING duplicate')
  assert.equal(r.milestones.filter(m => m.title === 'Same').length, 2, 'both milestones persist')
  assert.ok(r.milestones.some(m => m.id === r.added.id), 'the echoed id is the one stored')
  assert.equal(writes.length, 1, 'one meta put for the milestone blob')
})

/* ---------------- [P1 2026-10-09] timed-renewal propagation miss: CLI idempotency pre-check ----------------
 * The 2026-10-08 change re-anchored the renewal base at the completed instance's TIMED todoTime
 * (14:30), but renewRepeatAfterComplete still queried dayStartFrom/To = next.todoTime — comparing
 * midnight scheduledDay against a timed instant, so the idempotency pre-check was dead for timed
 * repeats: done twice minted once via the UNIQUE violation path and RETHREW past the done path
 * (the completion had already persisted). Fix: normalize to local midnight before both queries. */
test('B2b: timed repeat done twice — midnight-normalized idempotency pre-check, no throw, no double-mint', () => {
  const D = +dayjs().startOf('day')
  const AT1430 = 14 * 3600000 + 30 * 60000
  const t = { taskId: 'src3', repeatId: 'r3', dayStart: D, todoTime: D + AT1430, reminderTime: 0, userId: 840001, estimate: 0, taskContent: 'x' }
  const nextDay = D + DAY
  const twin = { taskId: 'twin3', repeatId: 'r3', dayStart: nextDay, complete: false }
  const seenQueries = []
  let inserts = 0
  const db = {
    call: (op, args) => {
      if (op === 'queryTodos') {
        if (args && args.dayStartFrom != null) {
          seenQueries.push(args.dayStartFrom)
          // the pre-check MUST be queried with the local midnight, not the timed todoTime
          assert.equal(args.dayStartFrom, nextDay, 'idempotency query uses the midnight-normalized day')
          return seenQueries.length === 1 ? [] : [twin] // first run: pre-check empty; twin read after the UNIQUE violation
        }
        return [{ taskId: t.taskId, dayStart: t.dayStart }] // the completed instance is the group's last
      }
      if (op === 'getMeta') return JSON.stringify({ repeatType: 'day', repeatInterval: 1, repeatDayCount: 5 })
      return null
    }
  }
  const { renewRepeatAfterComplete } = requireP('cli/lib-repeat.cjs')({
    open: () => db,
    commit: (ent, verb, payload) => { inserts++; throw new Error('UNIQUE constraint failed: todos.recurGroupId, todos.scheduledDay') },
    audit: { record: () => {} }, CliError, dayjs,
    core: requireP('src/main/core/todo-core.js'),
    resolveTask: () => t, liveTasks: () => [t], normKey: k => k, settingsDoc: () => ({}),
    chipsSnapshotForDelete: () => {}, dayStartOf: ts => +dayjs(ts).startOf('day'),
    clampEstimate: v => v, getEstimateOf: () => 0, estimateKey: id => 'tomatoEstimateState:' + id
  })
  // First done: pre-check empty -> insert hits UNIQUE -> twin read resolves instead of throwing
  const r1 = renewRepeatAfterComplete(db, t, { ...t, complete: true })
  assert.equal(r1, twin, 'UNIQUE violation resolves to the existing timed-repeat twin')
  assert.equal(inserts, 1, 'one insert attempt on the first done')
  // Second done: the pre-check now FINDS the twin -> idempotent early return, no second insert
  const r2 = renewRepeatAfterComplete(db, t, { ...t, complete: true })
  assert.equal(r2, twin, 'done twice is idempotent — the twin is returned without re-minting')
  assert.equal(inserts, 1, 'no double-mint on the second done')
})
