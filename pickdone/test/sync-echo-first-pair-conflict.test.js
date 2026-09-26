/* first-pair echo conflict repro (2026-09-26 live incident, machine A "Du" vs B "lubancat"):
 * After pairing, B (fresh profile) pulls A's ops, applies them (each applied write is re-captured
 * into B's oplog), and pushes A's own rows BACK to A. On A, applyRowInner compares the echo
 * against the identical local row: updatedAt ties, and the tiebreak goes to seq — but the LOCAL
 * side never carries a seq (sync-apply.js todo localRow = { updatedAt, deleted, deletedAt, data }),
 * so localRow.seq reads as 0 and the echo's ptr.seq always wins the tie. Whether that tie-win is
 * harmless depends ENTIRELY on the echo's content being byte-identical to A's row:
 *   - identical  -> the identical-content no-op (sync-apply.js) returns false, nothing happens;
 *   - any roundtrip instability -> contentDiffers fires, and A's OWN task is materialized to the
 *     recycle bin as `<taskId>-conflict-...` while the echo overwrites the live row.
 * Known instability: todoToRow recomputes scheduledDay from todoTime in the WRITING device's
 * local timezone instead of honoring the payload's carried dayStart — B's stored copy differs
 * from A's whenever the devices' timezones differ, and B's echo then content-differs forever.
 * Real DB in fresh temp dirs (TODO_DB_DIR / TODO_USER_DATA_DIR) — never the real %APPDATA%.
 * Run: node --test test/sync-echo-first-pair-conflict.test.js */
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-pair-'))
process.env.TODO_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-pair-ud-'))

const db = require('../src/main/db.js')
const apply = require('../src/main/sync-apply.js')
db.init(fs.mkdtempSync(path.join(os.tmpdir(), 'echo-pair-db-')))

const T0 = 1767000000000 // fixed stamp: nobody is "newer", everything below ties on time

function freshState () {
  return {
    db,
    deviceId: 'device-a-uuid',
    applied: null,
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] }
  }
}

/** Seed machine A's own task exactly like the app does (todoToRow derives scheduledDay locally). */
function seedLocalTodo (taskId) {
  db.call('upsert', {
    taskId, userId: 840001, taskContent: 'A real task', createTime: T0, updateTime: T0,
    todoTime: T0 + 2 * 3600 * 1000 // scheduled 02:00 local — a UTC writer recomputes the previous day
  })
  return db.call('getAll', { deleted: null }).find(t => t.taskId === taskId)
}

/** Build the inbound row exactly as the transport boundary hands it to applyRowSafe:
 *  hydrated on B from B's stored copy (hydrateRow shape) + the sender deviceId stamp. */
function echoRow (localAppRow, dataOverrides) {
  return {
    seq: 4242, // B's oplog seq for its re-captured write — the ONLY tiebreak the echo needs
    entity: 'todo',
    id: localAppRow.taskId,
    ts: T0,
    updatedAt: localAppRow.updateTime,
    deleted: false,
    deletedAt: 0,
    deviceId: 'device-b-uuid',
    data: { ...localAppRow, userId: 840001, ...(dataOverrides || {}) }
  }
}

const conflictCopies = () => (db.call('getAll', { deleted: null }) || [])
  .filter(t => String(t.taskId || '').includes('-conflict-'))

test('echo with byte-identical content is the designed no-op (no conflict, no write)', () => {
  const t = seedLocalTodo('tid_echo_clean')
  const before = conflictCopies().length
  const r = apply.applyRowSafe(freshState(), echoRow(t))
  assert.equal(r, false, 'identical echo is refused as a no-op')
  assert.equal(conflictCopies().length, before, 'no recycle-bin copy minted')
})

test('REPRO: echo whose scheduledDay was recomputed in the peer timezone bins A\'s own task', () => {
  const t = seedLocalTodo('tid_echo_tz')
  // B applied A's row via todoToRow, which IGNORED the carried dayStart and recomputed
  // scheduledDay from todoTime in B's local timezone (e.g. UTC vs UTC+8 -> previous day).
  const peerDay = t.dayStart - 24 * 3600 * 1000
  const before = conflictCopies().length
  const r = apply.applyRowSafe(freshState(), echoRow(t, { dayStart: peerDay }))
  // What the incident shows: true + a recycle-bin copy of A's OWN row.
  assert.equal(r, false, 'THE BUG: a same-stamp echo must never replace the local row (failed pre-fix: returned true)')
  assert.equal(conflictCopies().length, before, 'THE BUG: no conflict copy for a row that is not provably newer')
  const live = db.call('getAll', { deleted: null }).find(x => x.taskId === 'tid_echo_tz')
  assert.equal(live.delete, false, 'A\'s live row survives')
  assert.equal(live.dayStart, t.dayStart, 'A\'s own dayStart survives')
})

test('FIX (source): todoToRow honors the carried dayStart instead of re-deriving it in the writer tz', () => {
  const { todoToRow, rowToTodo } = require('../src/main/db-rows.js')
  const todoTime = T0 + 2 * 3600 * 1000
  // The origin computed a scheduled day that THIS device's tz would never derive (peer tz wrote it).
  const originDay = +new Date(T0).setUTCHours(0, 0, 0, 0) + 86400000
  const appShape = rowToTodo(todoToRow({ taskId: 'x', taskContent: 'x', createTime: T0, updateTime: T0, todoTime, dayStart: originDay }))
  assert.equal(todoToRow(appShape).scheduledDay, originDay, 'B\'s write of A\'s row preserves A\'s scheduledDay (echo stays content-identical)')
  // Callers that omit dayStart still get the derived value (renderer/CLI back-compat).
  const noDay = { taskId: 'y', taskContent: 'y', createTime: T0, updateTime: T0, todoTime }
  assert.ok(todoToRow(noDay).scheduledDay > 0, 'derived fallback intact')
})
