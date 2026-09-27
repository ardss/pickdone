/** D11 CLI round fixes, each with its regression test:
 *  1. waitForTomatoAck matches the receipt seq EXACTLY (was >=): cliTomatoState is a single slot,
 *     so a second command's higher-seq receipt used to satisfy the first waiter and report
 *     "✓ focus started" for a command the App never ran (same contract as waitForSyncAck).
 *  2. open() is read-only: the tomato ledger migration moved to the write path (commit). Read
 *     commands (list/search/doctor → open()) no longer write to the real user DB.
 *  3. importEvents compares parsed timestamps for the future check: a loose date ('2026-9-28')
 *     sorted BEFORE '2026-09-28' lexicographically, so a future event was misjudged as past and
 *     got backfilled completion + a fabricated focus ledger row.
 *  Isolated temp DB via TODO_DB_DIR (cli-r5-fixes pattern). Order matters: the read-only test
 *  must run before any write in this process.
 *  Run: node --test tests/unit/cli/d11-cli-round-fixes.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'
import { isolatedTmpDir } from '../../lib/tmp-dir.mjs'

process.env.TODO_DB_DIR = isolatedTmpDir('todo-cli-d11-')
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')
const channels = require_('../../../cli/lib-channels.cjs')({
  open: () => ({ call: (op, key) => {
    if (op === 'nextCliTomatoSeq') return ++fakeState.seq
    if (key === 'cliTomatoState' || key === 'cliSyncState') return fakeState.read() // readTomatoState JSON.parses the raw value
    return null
  } }),
  commit: (_e, _v, p) => { fakeState.written = p },
  audit: { record () {} }
})
// in-memory single-slot receipt store standing in for the meta channel
const fakeState = {
  seq: 0,
  slot: null,
  written: null,
  read () { return this.slot == null ? null : JSON.stringify(this.slot) },
  write (st) { this.slot = st }
}
db.init(process.env.TODO_DB_DIR)

/* ---------- 1: waitForTomatoAck exact-seq ---------- */
test('d11: waitForTomatoAck is NOT satisfied by a later command\'s higher seq landing in the single slot', async () => {
  const first = channels.writeTomatoCmd({ action: 'startTomatoTime', taskId: 'd11-x', tomatoTime: 25 })
  fakeState.write({ seq: first + 1, status: 'startTomatoTime', at: Date.now() }) // second command overwrote the slot
  const ack = await channels.waitForTomatoAck(first, 250) // short timeout: must NOT match
  assert.equal(ack, null, 'higher seq in the slot must not satisfy the earlier waiter (was >= before the fix)')
})

test('d11: waitForTomatoAck still returns the receipt for the exact seq', async () => {
  const seq = channels.writeTomatoCmd({ action: 'startTomatoTime', taskId: 'd11-y', tomatoTime: 25 })
  fakeState.write({ seq, status: 'startTomatoTime', at: Date.now(), startedAt: Date.now(), tomatoTime: 25 })
  const ack = await channels.waitForTomatoAck(seq, 2000)
  assert.ok(ack, 'exact-seq receipt resolves the waiter')
  assert.equal(ack.seq, seq)
})

/* ---------- 2: open() read-only — migration moved to the write path ---------- */
test('d11: a read via open() does NOT run tomatoMigrateFromMeta (meta blob survives, no ledger rows)', () => {
  // seed the OLD meta blob ledger (pre-row-table shape) directly
  const blob = JSON.stringify({ tomatoRecordList: [{ tomatoId: 'd11_legacy_1', endTime: Date.now() - 86400000, succeed: true }] })
  db.call('setMeta', ['db.tomatoState', blob])
  lib.listReady() // read command path: open() only
  assert.equal(db.call('getMeta', 'db.tomatoState'), blob, 'read command left the meta blob untouched (open() used to delete it via the migration)')
  assert.equal(db.call('tomatoAll').length, 0, 'read command did not insert ledger rows')
})

test('d11: the FIRST WRITE still migrates the legacy blob before the write lands', () => {
  lib.addTodo({ content: 'd11 write after open' })
  assert.equal(db.call('getMeta', 'db.tomatoState'), null, 'blob consumed by the migration on the write path')
  const rows = db.call('tomatoAll')
  assert.equal(rows.length, 1, 'legacy ledger row landed in tomato_records')
  assert.equal(rows[0].tomatoId, 'd11_legacy_1')
})

/* ---------- 3: importEvents future check via parsed timestamps ---------- */
test('d11: importEvents treats a LOOSE future date as future (no fabricated completion/ledger)', async () => {
  const d = require_('dayjs')().add(3, 'day')
  const loose = `${d.year()}-${d.month() + 1}-${d.date()}` // '2026-10-1' shape — sorts BEFORE the padded ISO form
  const out = await lib.importEvents([{ date: loose, start: '09:00', end: '10:00', title: 'd11 loose future' }])
  assert.equal(out.created, 1)
  const t = db.call('queryTodos', { deleted: 0, keyword: 'd11 loose future' })[0]
  assert.ok(t, 'task was created')
  assert.equal(t.complete, false, 'future event NOT marked complete (was backfilled before the fix)')
  assert.equal(db.call('tomatoAll').filter(r => r.focusTaskId === t.taskId).length, 0, 'no fabricated focus ledger row')
  assert.equal(out.failed.length, 0)
})

test('d11: importEvents still completes + backfills a PAST event (loose date)', async () => {
  const d = require_('dayjs')().subtract(3, 'day')
  const loose = `${d.year()}-${d.month() + 1}-${d.date()}`
  const out = await lib.importEvents([{ date: loose, start: '09:00', end: '10:00', title: 'd11 loose past' }])
  assert.equal(out.created, 1)
  const t = db.call('queryTodos', { deleted: 0, keyword: 'd11 loose past' })[0]
  assert.equal(t.complete, true, 'past event still imported as done')
  assert.equal(db.call('tomatoAll').filter(r => r.focusTaskId === t.taskId).length, 1, 'past event still gets its ledger row')
})
