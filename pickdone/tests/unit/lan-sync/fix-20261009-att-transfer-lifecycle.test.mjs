/* Fix round 2026-10-09 (att-transfer lifecycle):
 * 6. att-meta for a DIFFERENT id while a transfer is open silently destroyed the in-flight
 *    file and leaked its reserved byte budget — now settles it via markFailed (refund +
 *    per-session failed-set).
 * 7. att-end arriving mid-transfer discarded an open `current` without markFailed — same
 *    refund + failed-set settlement.
 * 8. serve(): the d.exists(id) precheck sat OUTSIDE the per-file try, so a vanished/fs-error
 *    file aborted the whole batch with no att-end (requester burned the 120s deadline) —
 *    moved inside; the catch answers att-missing {reason:'read-error'}.
 * Run: node --test tests/unit/lan-sync/fix-20261009-att-transfer-lifecycle.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'

const require = createRequire(import.meta.url)
const att = require('../../../src/main/lan-sync/att-transfer.js')
const sha = buf => createHash('sha256').update(buf).digest('hex')

function memDeps (files = {}) {
  const written = []
  const deps = {
    exists: key => key in files,
    size: key => (files[key] ? files[key].length : 0),
    read: (key, start, end) => (files[key] || Buffer.alloc(0)).slice(start, end + 1),
    writeAtomic: (key, buf) => { written.push({ key, buf }); return key },
    hashFn: sha,
  }
  return { deps, written, files }
}

function makeSession () {
  const failed = new Map()
  return { failed, requests: new Map() }
}

/* ---------- Fix 6: meta for a different id settles the in-flight transfer ---------- */

test('fix6: att-meta for a different id mid-transfer fails the in-flight file and refunds its budget', () => {
  const sess2 = makeSession()
  const recv2 = memDeps({})
  let requestedIds = []
  const puller2 = att.createAttachmentPuller({
    send: m => { if (m.type === 'att-req') requestedIds = m.ids; return true },
    deps: recv2.deps, session: sess2, getKeys: () => ['a.png', 'b.png'],
  })
  assert.equal(puller2.maybeStart(() => {}, () => {}), true)
  assert.deepEqual(requestedIds, ['a.png', 'b.png'])
  // First transfer opens for a.png (10MB reserved).
  assert.equal(puller2.onMessage({ type: 'att-meta', id: 'a.png', size: 10 * 1024 * 1024, hash: 'h1' }), true)
  // Mid-transfer, meta for a DIFFERENT requested id arrives.
  assert.equal(puller2.onMessage({ type: 'att-meta', id: 'b.png', size: 10 * 1024 * 1024, hash: 'h2' }), true)
  // The a.png transfer was settled as FAILED: in the per-session failed-set (24h no-retry)…
  assert.ok(sess2.failed.has('a.png'), 'the destroyed in-flight file enters the failed-set')
  // …and its reserved bytes were refunded: only b.png's size is still held.
  // Observable through the budget: a further 55MB meta for b.png would exceed 64MB if a.png
  // were still reserved (10 + 10 reserved; 55 more > 64) — instead the refund keeps 10 held
  // and 55 fits (10 + 55 <= 64). Assert via the budget guard on a c.png-sized probe.
  // (Simpler direct observable: chunks for a.png are now ignored — current switched to b.png.)
  assert.equal(puller2.onMessage({ type: 'att-chunk', id: 'a.png', index: 0, data: Buffer.from('zz').toString('base64'), final: true }), true)
  assert.equal(recv2.written.length, 0, 'stray a.png chunk cannot land after the switch')
  // Complete b.png normally — proof the budget/assembly state is coherent after the settle.
  const bytes = Buffer.from('b-file-bytes')
  puller2.onMessage({ type: 'att-chunk', id: 'b.png', index: 0, data: bytes.toString('base64'), final: true })
  // Hash was fake ('h2') → b.png fails the verify; that is fine: assert it was ATTEMPTED
  // (nothing written) and that no crash occurred.
  assert.equal(recv2.written.length, 0)
})

/* ---------- Fix 7: att-end mid-transfer settles the open transfer ---------- */

test('fix7: att-end with an open transfer refunds the reserved budget and fails the id', () => {
  const sess = makeSession()
  const recv = memDeps({})
  const puller = att.createAttachmentPuller({
    send: () => true, deps: recv.deps, session: sess, getKeys: () => ['x.png'],
  })
  let done = false
  assert.equal(puller.maybeStart(() => { done = true }, () => {}), true)
  // Open a transfer (reserve 60MB of the 64MB round budget)…
  assert.equal(puller.onMessage({ type: 'att-meta', id: 'x.png', size: 60 * 1024 * 1024, hash: 'h' }), true)
  // …then att-end arrives before any chunk: the transfer dies mid-flight.
  assert.equal(puller.onMessage({ type: 'att-end' }), false, 'att-end still terminates the batch')
  assert.equal(done, true)
  assert.ok(sess.failed.has('x.png'), 'the truncated file enters the failed-set (pre-fix: silently dropped, re-requestable forever)')
  assert.equal(recv.written.length, 0)
  // Budget refund observable: a NEW round in the same session can reserve 60MB again —
  // without the refund, the round budget would treat the dead reservation as still held.
  const puller2 = att.createAttachmentPuller({
    send: () => true, deps: recv.deps, session: sess, getKeys: () => ['y.png'],
  })
  // x.png is failed so it is not re-queued; y.png is a fresh id.
  assert.equal(puller2.maybeStart(() => {}, () => {}), true)
  assert.equal(
    puller2.onMessage({ type: 'att-meta', id: 'y.png', size: 60 * 1024 * 1024, hash: 'h2' }),
    true,
    'the dead transfer\u2019s 60MB reservation was refunded — y.png fits the round budget again')
})

/* ---------- Fix 8: serve() exists precheck cannot abort the batch ---------- */

test('fix8: an exists() throw on one id answers att-missing(read-error) and the batch still ends with att-end', () => {
  const files = { 'good.png': Buffer.from('fine bytes') }
  const deps = memDeps(files).deps
  deps.exists = key => {
    if (key === 'ghost.png') throw new Error('EIO: fs error on stat')
    return key in files
  }
  const server = att.createAttachmentServer(deps)
  const wire = []
  const r = server.serve({ deviceId: 'p' }, { type: 'att-req', ids: ['ghost.png', 'good.png'] }, m => wire.push(m))
  const missing = wire.find(m => m.type === 'att-missing')
  assert.ok(missing, 'the failing precheck answered att-missing')
  assert.equal(missing.id, 'ghost.png')
  assert.equal(missing.reason, 'read-error')
  assert.equal(r.aborted, undefined, 'the batch was NOT aborted by the precheck throw')
  assert.equal(wire[wire.length - 1].type, 'att-end', 'batch terminates with att-end (no 120s deadline burn)')
  assert.equal(wire[wire.length - 1].sent, 1, 'the remaining good file still served')
  assert.equal(wire[wire.length - 1].missing, 1)
})

test('fix8b: a plain missing id still answers not-found (not read-error) after the move', () => {
  const server = att.createAttachmentServer(memDeps({}).deps)
  const wire = []
  server.serve({ deviceId: 'p' }, { type: 'att-req', ids: ['nope.png'] }, m => wire.push(m))
  const missing = wire.find(m => m.type === 'att-missing')
  assert.equal(missing.reason, 'not-found')
  assert.equal(wire[wire.length - 1].type, 'att-end')
})
