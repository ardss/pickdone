/** Regression guards (originating from the round-4-review 2026-09-11 pre-release audit; renamed
 *  2026-09-24 from r4-review-guards.test.mjs to a domain name and grouped under main/): two main-process
 *  P1 fixes that previously had NO test — reverting either used to leave the suite green.
 *  Coverage:
 *   1. External-write watcher baseline resync (index.js resyncDbWatch, pure core in watch-baseline.js,
 *      gate = db.isWriteOp) — revert to "no resync on own writes" and the baseline test red-flags the
 *      write-op set the wiring depends on.
 *   2. Quit-flush ack handshake (quit-ack.js tracker, wired in index.js will-quit / app-quitting-flush-ack)
 *      — stale-token rejection, sender dedup, zero-window fast path, per-round reset.
 *  (The third r4 guard, the CLI tomato stale-receipt pair, lives in tests/unit/cli/tomato-stale-receipt-guards.test.mjs.)
 * Run: node --test tests/unit/main/watch-resync-quitack-guards.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readAnchor } from '../../lib/source-anchors.mjs'

const require_ = createRequire(import.meta.url)

test('watch baseline: a failed mtime read (null) never clobbers the current baseline', () => {
  const { nextWatchBaseline } = require_('../../../src/main/watch-baseline.js')
  assert.equal(nextWatchBaseline(1111, () => null), 1111, 'null read keeps the old baseline')
  assert.equal(nextWatchBaseline(1111, () => 2222), 2222, 'a fresh read wins')
})

test('watch baseline gate: the resync fires on write ops and only on write ops (the wiring condition)', () => {
  const dbm = require_('../../../src/main/db.js')
  // These are the ops the renderer actually writes through todo-db:call — if any of them stops being
  // a write op, our own writes go un-resynced and the "own write read back as external" bug returns.
  for (const op of ['upsert', 'upsertMany', 'setMeta', 'hardDelete', 'purgeRecycleBin']) {
    assert.equal(dbm.isWriteOp(op), true, `isWriteOp('${op}') must be true — resync depends on it`)
  }
  for (const op of ['getAll', 'getById', 'getMeta', 'getViews']) {
    assert.equal(dbm.isWriteOp(op), false, `isWriteOp('${op}') must be false — reads must not resync`)
  }
})

test('watch baseline wiring: the todo-db:call handler re-baselines after dbm.call', () => {
  // Static guard for the wiring itself (index.js is not requireable outside Electron): the resync call
  // must sit in the db:call handler AFTER dbm.call, gated by isWriteOp, and resync must use the pure core.
  // R4 split moved the handler into handlers/todo.js; watcher setup (and the pure core) stay in index.js.
  let src = readAnchor('mainIndex')
  try { src += readAnchor('handlersTodo') } catch {}
  const callIdx = src.indexOf("r = dbm.call(op, params)")
  assert.ok(callIdx > 0, 'db:call handler found')
  const after = src.slice(callIdx, callIdx + 1200)
  assert.match(after, /isWriteOp\(op\)[\s\S]{0,700}resyncDbWatch\(\)/, 'resync must be gated by isWriteOp after the write')
  assert.match(src, /lastMtime = nextWatchBaseline\(lastMtime, readWatchMtime\)/, 'resync must go through the tested pure core')
})

test('quit ack tracker: fresh acks count; stale tokens, dup senders and missing senders do not', () => {
  const { createQuitAckTracker } = require_('../../../src/main/quit-ack.js')
  const t = createQuitAckTracker()
  t.beginRound(2, 1000)
  assert.equal(t.allAcked(), false, 'two live windows: not done yet')
  assert.equal(t.ack(999, 1), false, 'a token from an aborted previous round must not count')
  assert.equal(t.ack(1000, 1), true, 'current-round ack accepted')
  assert.equal(t.ack(1000, 1), false, 'duplicate ack from the same window is a no-op')
  assert.equal(t.allAcked(), false, 'one of two acked')
  assert.equal(t.ack(1000, 2), true)
  assert.equal(t.allAcked(), true, 'all live windows acked')
  assert.equal(t.ack(1000, 3), true, 'an unexpected third window still records (harmless)')
})

test('quit ack tracker: zero live windows takes the fast path; a new round resets everything', () => {
  const { createQuitAckTracker } = require_('../../../src/main/quit-ack.js')
  const t = createQuitAckTracker()
  t.beginRound(0, 100)
  assert.equal(t.allAcked(), true, 'no window online: skip waiting entirely')
  // New quit attempt: the previous round's acks must not leak into it
  t.beginRound(2, 200)
  assert.equal(t.allAcked(), false, 'new round starts un-acked')
  assert.equal(t.ack(100, 1), false, 'old-round token rejected in the new round')
  assert.equal(t.ack(200, 1), true)
  assert.equal(t.progress(), '1/2')
})

test('quit ack wiring: index.js broadcast/ack/allAcked all route through the tracker', () => {
  const src = readAnchor('mainIndex')
  assert.match(src, /quitAck\.beginRound\(liveWindows, roundToken\)/, 'before-quit opens a tracker round')
  assert.match(src, /quitAck\.ack\(payload\.token, e\.sender\.id\)/, 'ack IPC handler feeds the tracker')
  assert.match(src, /allAcked = \(\) => quitAck\.allAcked\(\)/, 'will-quit polls the tracker')
  assert.doesNotMatch(src, /flushAckedSenders|flushExpectAcks/, 'the old inline sets are fully replaced')
})
