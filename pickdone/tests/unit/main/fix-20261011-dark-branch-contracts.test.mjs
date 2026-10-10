/* Coverage round 2026-10-11: behavior tests for branches left dark by the daily sweep's new
 * code paths. Real behavior contracts, not line-chasing:
 *  1. att-transfer failed-set TTL: an entry older than FAILED_TTL_MS becomes pullable again;
 *     the legacy Set shape stays failed forever (adapted path).
 *  2. att-transfer serve(): a send failure at att-meta or mid-chunk aborts the batch
 *     (aborted:true) instead of pretending success; a mid-serve read error answers
 *     att-missing and lets the batch continue.
 *  3. tomato-announce writeAnnounce failure returns false; announceFromRenderer composes
 *     from the injected identity.
 *  4. tomatoMigrateFromMeta steady state: a partial-migration marker + a blob whose every
 *     row already lives in the table clears the marker AND the blob, returning 0.
 * Run: node --test tests/unit/main/fix-20261011-dark-branch-contracts.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'

const require = createRequire(import.meta.url)
const att = require('../../../src/main/lan-sync/att-transfer.js')
const ta = require('../../../src/main/tomato-announce.js')
const db = require('../../../src/main/db.js')
const sha = buf => createHash('sha256').update(buf).digest('hex')

function memDeps (files = {}) {
  return {
    exists: key => key in files,
    size: key => (files[key] ? files[key].length : 0),
    read: (key, start, end) => (files[key] || Buffer.alloc(0)).slice(start, end + 1),
    writeAtomic: (key, buf) => key,
    hashFn: sha,
  }
}

/* ---------- 1. failed-set TTL expiry ---------- */

test('att failed-set: an entry older than FAILED_TTL_MS is pullable again (Map shape)', () => {
  const stale = new Map([['old.png', Date.now() - att.FAILED_TTL_MS - 60000]])
  const requested = []
  const puller = att.createAttachmentPuller({
    send: m => { if (m.type === 'att-req') requested.push(...m.ids); return true },
    deps: memDeps({}).deps,
    session: { failed: stale, requests: new Map() },
    getKeys: () => ['old.png'],
  })
  assert.equal(puller.maybeStart(() => {}, () => {}), true)
  assert.deepEqual(requested, ['old.png'], 'a 25h-old failure no longer blocks the pull')
  assert.equal(stale.has('old.png'), false, 'the expired entry is evicted from the set')
})

test('att failed-set: the legacy Set shape (no timestamps) keeps the entry failed', () => {
  const legacy = new Set(['x.png'])
  const requested = []
  const puller = att.createAttachmentPuller({
    send: m => { if (m.type === 'att-req') requested.push(...m.ids); return true },
    deps: memDeps({}).deps,
    session: { failed: legacy, requests: new Map() },
    getKeys: () => ['x.png', 'y.png'],
  })
  assert.equal(puller.maybeStart(() => {}, () => {}), true)
  assert.deepEqual(requested, ['y.png'], 'Set-shape entry stays failed (no age to prove expiry)')
})

/* ---------- 2. serve() abort + read-error paths ---------- */

test('att serve: a send failure at att-meta aborts the batch (aborted:true)', () => {
  const deps = memDeps({ 'a.png': Buffer.from('hello') })
  const res = att.createAttachmentServer(deps).serve({ deviceId: 'p' }, { type: 'att-req', ids: ['a.png'] }, () => false)
  assert.equal(res.aborted, true, 'meta send failure aborts instead of streaming chunks into a dead transport')
  assert.equal(res.sent, 0)
})

test('att serve: a send failure mid-chunk aborts with the partial count', () => {
  // Two chunks: the first send (meta) passes, the first chunk fails.
  const deps = memDeps({ 'b.png': Buffer.from('z'.repeat(3 * att.ENTRY_CHUNK_BYTES)) })
  let calls = 0
  const res = att.createAttachmentServer(deps).serve({ deviceId: 'p' }, { type: 'att-req', ids: ['b.png'] }, () => (calls++ === 0))
  assert.equal(res.aborted, true)
  assert.equal(res.sent, 0, 'the file was not counted as sent')
})

test('att serve: a mid-serve read error answers att-missing and the batch continues', () => {
  const files = { 'good.png': Buffer.from('fine'), 'bad.png': Buffer.from('will throw') }
  const deps = memDeps(files)
  deps.read = (key, start, end) => { if (key === 'bad.png') throw new Error('EIO: disk gone'); return files[key].slice(start, end + 1) }
  const wire = []
  const res = att.createAttachmentServer(deps).serve({ deviceId: 'p' }, { type: 'att-req', ids: ['bad.png', 'good.png'] }, m => wire.push(m))
  const missing = wire.filter(m => m.type === 'att-missing' && m.id === 'bad.png')
  assert.equal(missing.length, 1, 'the failed read is answered att-missing (never a silent drop)')
  assert.equal(res.sent, 1, 'good.png still served after the bad one')
  assert.equal(wire[wire.length - 1].type, 'att-end')
})

/* ---------- 3. tomato-announce write/renderer entries ---------- */

test('announce: writeAnnounce returns false when the DB write throws (warn-only)', () => {
  ta.__reset()
  ta.init({ dbCall: () => { throw new Error('db closed') } })
  assert.equal(ta.writeAnnounce({ deviceId: 'd1', deviceName: 'D', status: 'running', startedAt: Date.now(), plannedSec: 100, at: Date.now() }), false)
  ta.__reset()
})

test('announce: announceFromRenderer composes the value from the injected identity', () => {
  ta.__reset()
  const writes = []
  ta.init({
    dbCall: (op, p) => { writes.push(p); return true },
    getIdentity: () => ({ deviceId: 'dev-9', deviceName: 'Laptop' }),
  })
  assert.equal(ta.announceFromRenderer({ status: 'running', startedAt: 123, plannedSec: 1500 }), true)
  const v = JSON.parse(writes[0][1])
  assert.equal(v.deviceId, 'dev-9')
  assert.equal(v.deviceName, 'Laptop')
  assert.equal(v.status, 'running')
  assert.equal(v.plannedSec, 1500)
  ta.__reset()
})

/* ---------- 4. tomatoMigrateFromMeta steady state ---------- */

test('ledger migrate: marker + fully-present blob clears marker and blob, returns 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tomato-migrate-steady-'))
  db.init(dir)
  const a = { tomatoId: 'tmt_steady_a', endTime: Date.now(), focus: 'x', focusDuration: 1, succeed: true }
  const b = { tomatoId: 'tmt_steady_b', endTime: Date.now(), focus: 'y', focusDuration: 2, succeed: true }
  db.call('tomatoAppendMany', [a, b])
  // Simulate the partial-migration state: marker set, blob still carrying exactly those rows.
  db.call('setMeta', ['sync.tomatoBlobPartialMigration', '1'])
  db.call('setMeta', ['db.tomatoState', JSON.stringify({ todoList: [], tomatoList: [a, b] })])
  const n = db.call('tomatoMigrateFromMeta')
  assert.equal(n, 0, 'nothing left to replay')
  assert.equal(db.call('getMeta', 'sync.tomatoBlobPartialMigration'), null, 'marker cleared (steady state restored)')
  assert.equal(db.call('getMeta', 'db.tomatoState'), null, 'blob deleted (no unique copy left)')
  db.close()
})
