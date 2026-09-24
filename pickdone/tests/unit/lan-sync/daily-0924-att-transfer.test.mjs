/* Daily 2026-09-24 attachment-transfer regressions:
 * [C8] the sender streams: hash pass + chunk pass each read/hold at most ONE ENTRY_CHUNK_BYTES
 *      chunk (positional fs.readSync in the default deps) — the old path readFileSync'd the
 *      WHOLE file (up to 50MB) to hash it and kept it resident while slicing chunks, blocking
 *      the main process per file (<=64MB per batch).
 * [C9] the round byte-budget exhaustion is no longer silent: it warns and reports the skip
 *      count (budgetSkipped) on the serve result — parity with the rate-cap / too-large warns.
 * Run: node --test tests/unit/lan-sync/daily-0924-att-transfer.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'

const require_ = createRequire(import.meta.url)
const Module = require_('module')

// Capture electron-log warns (C9 asserts the warn actually fires).
const warns = []
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron-log') {
    const real = origLoad.call(this, request, parent, isMain)
    return new Proxy(real, { get (t, p) { return p === 'warn' ? (...a) => warns.push(a.join(' ')) : t[p] } })
  }
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const att = require_('../../../src/main/lan-sync/att-transfer.js')
const sha = buf => createHash('sha256').update(buf).digest('hex')

function memDeps (files = {}) {
  const reads = []
  const deps = {
    exists: key => key in files,
    size: key => (files[key] ? files[key].length : 0),
    read: (key, start, end) => { reads.push({ key, start, end, len: end - start + 1 }); return (files[key] || Buffer.alloc(0)).subarray(start, end + 1) },
    writeAtomic: (key, buf) => true,
  }
  return { deps, reads, files }
}

test('C8: sender hashes via chunked reads — no single read may span past ENTRY_CHUNK_BYTES, roundtrip stays byte-exact', () => {
  const big = Buffer.alloc(Math.floor(att.ENTRY_CHUNK_BYTES * 2.5), 7)
  big[0] = 1; big[att.ENTRY_CHUNK_BYTES] = 2; big[big.length - 1] = 3
  const sender = memDeps({ 'big.bin': big })
  const receiver = memDeps({})
  const written = []
  receiver.deps.writeAtomic = (key, buf) => { written.push({ key, buf }); return true }
  const server = att.createAttachmentServer(sender.deps)
  const wire = []
  server.serve({ deviceId: 'peer-x' }, { type: 'att-req', ids: ['big.bin'] }, m => wire.push(m))
  const meta = wire.find(m => m.type === 'att-meta')
  assert.equal(meta.size, big.length, 'declared size is the full file')
  assert.equal(meta.hash, sha(big), 'streamed hash equals the whole-file sha256')
  const chunks = wire.filter(m => m.type === 'att-chunk')
  assert.equal(chunks.length, 3, '2.5 chunks -> three att-chunk frames')
  assert.equal(chunks[chunks.length - 1].final, true)
  // C8 core assertion: every physical read is bounded by one chunk (no whole-file materialization)
  for (const r of sender.reads) assert.ok(r.len <= att.ENTRY_CHUNK_BYTES, `read span ${r.len} must not exceed one chunk`)
  assert.ok(sender.reads.length >= 6, 'hash pass + send pass both stream chunk-by-chunk')
  // receiver-side assembly from the wire is byte-exact
  const assembled = []
  for (let i = 0; ; i++) { const c = chunks.find(m => m.index === i); if (!c) break; assembled.push(Buffer.from(c.data, 'base64')) }
  assert.ok(Buffer.concat(assembled).equals(big))
  assert.equal(written.length, 0, 'sender alone does not write')
})

test('C9: round byte-budget exhaustion warns and reports budgetSkipped on the serve result', () => {
  warns.length = 0
  const files = { a: Buffer.alloc(600), b: Buffer.alloc(600) }
  const server = att.createAttachmentServer({ ...memDeps(files).deps, maxRoundBytes: 1000 })
  const wire = []
  const r = server.serve({ deviceId: 'peer-y' }, { type: 'att-req', ids: ['a', 'b'] }, m => wire.push(m))
  assert.equal(r.sent, 1, 'the first file fits the budget and is served')
  assert.equal(r.budgetSkipped, 1, 'the skipped file is REPORTED (previously silent)')
  assert.equal(r.missing, 1)
  assert.ok(warns.some(w => w.includes('budget')), 'a warn line is emitted (parity with rate-cap/too-large)')
  assert.ok(wire.some(m => m.type === 'att-missing' && m.id === 'b' && m.reason === 'round-budget'))
  assert.ok(wire[wire.length - 1].type === 'att-end')
})
