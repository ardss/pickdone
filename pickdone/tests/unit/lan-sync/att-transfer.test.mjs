/** Attachment file pull over LAN sync (feature regression tests): request/serve/chunk/
 * verify/atomic-write path with a FAKE transport (no sockets), plus the guards:
 *   - sender refuses files >50MB and unknown ids; per-peer request rate cap
 *   - receiver caps the per-round batch (20 files / 64MB) and verifies the sha256 hash
 *   - writes land ATOMICALLY (tmp+rename) only after hash verification
 *   - a missing-on-both-sides file lands in the per-session failed set (no retry loop)
 *   - collectMissingKeys parses todo.image/todo.files local:// refs
 *   - same-name/different-content conflicts alias to the INCOMING bytes (row key resolves right)
 *   - the LAN receive door enforces the shared storage quota (no bypass of attachments-guards)
 * Run: node --test tests/unit/lan-sync/att-transfer.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'

const require = createRequire(import.meta.url)
const Module = require('module')

// Electron-free harness (d4-c14 pattern): stub 'electron' so attachments.js/attachments-guards.js
// resolve userData into a fresh temp dir — the real %APPDATA% is never touched.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'att-transfer-fix-'))
const stubs = {
  electron: { app: { getPath: k => (k === 'userData' ? TMP : path.join(TMP, k)), isPackaged: false } },
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (stubs[request]) return stubs[request]
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const att = require('../../../src/main/lan-sync/att-transfer.js')
const attachments = require('../../../src/main/attachments.js')

const sha = buf => createHash('sha256').update(buf).digest('hex')

function memDeps (files = {}) {
  const written = []
  const deps = {
    exists: key => key in files || written.some(w => w.key === key),
    size: key => (files[key] ? files[key].length : 0),
    read: (key, start, end) => (files[key] || Buffer.alloc(0)).slice(start, end + 1),
    writeAtomic: (key, buf) => { written.push({ key, buf }); return true },
    hashFn: sha,
  }
  return { deps, written, files }
}

function frameFile (id, buf) {
  const out = [{ type: 'att-meta', id, size: buf.length, hash: sha(buf) }]
  for (let off = 0, i = 0; off < buf.length || i === 0; off += att.ENTRY_CHUNK_BYTES, i++) {
    const chunk = buf.slice(off, Math.min(off + att.ENTRY_CHUNK_BYTES, buf.length))
    out.push({ type: 'att-chunk', id, index: i, data: chunk.toString('base64'), final: off + att.ENTRY_CHUNK_BYTES >= buf.length })
    if (off + att.ENTRY_CHUNK_BYTES >= buf.length) break
  }
  return out
}

test('att: extractLocalKeys parses todo.image/files and collectMissingKeys filters by disk', () => {
  const rows = [
    { taskId: 'a', image: JSON.stringify([{ url: 'local://a.png' }, { url: 'http://x' }]), files: JSON.stringify([{ url: 'local://b.pdf' }]) },
    { taskId: 'b', image: 'not-json' },
    { taskId: 'c', image: JSON.stringify([{ url: 'local://a.png' }]) },
    null,
  ]
  const missing = att.collectMissingKeys(rows, key => key === 'a.png')
  assert.deepEqual(missing, ['b.pdf'])
  assert.deepEqual(att.extractLocalKeys(null), [])
})

test('att: server serves chunks + end; receiver verifies hash and writes atomically (roundtrip over a fake transport)', () => {
  const sender = memDeps({ 'pic.png': Buffer.from('hello attachment data'.repeat(100)) })
  const receiver = memDeps({})
  const server = att.createAttachmentServer(sender.deps)
  const wire = []
  server.serve({ deviceId: 'peer-1' }, { type: 'att-req', ids: ['pic.png'] }, m => wire.push(m))
  assert.equal(wire[0].type, 'att-meta')
  assert.equal(wire[wire.length - 1].type, 'att-end')
  assert.equal(wire[wire.length - 1].sent, 1)
  const puller = att.createAttachmentPuller({
    send: () => {}, deps: receiver.deps, getKeys: () => ['pic.png'], session: { failed: new Set(), requests: new Map() },
  })
  let done = false
  assert.equal(puller.maybeStart(() => { done = true }, () => {}), true)
  for (const m of wire) if (m.type !== 'att-req') puller.onMessage(m)
  assert.equal(done, true, 'att-end settles the pull')
  assert.equal(receiver.written.length, 1)
  assert.equal(receiver.written[0].key, 'pic.png')
  assert.equal(sha(receiver.written[0].buf), sha(sender.files['pic.png']), 'reassembled bytes match the source hash')
})

test('att: guards - unknown id, oversized file, per-peer rate cap, hash mismatch refused', () => {
  const big = att.createAttachmentServer({ ...memDeps({ big: Buffer.alloc(51 * 1024 * 1024) }).deps, maxFileBytes: 50 * 1024 * 1024 })
  const wire = []
  big.serve({ deviceId: 'p' }, { type: 'att-req', ids: ['nope.png', 'big', '../evil'] }, m => wire.push(m))
  const missing = wire.filter(m => m.type === 'att-missing')
  assert.equal(missing.length, 3, 'not-found / too-large / bad-id all answer att-missing (never a hang)')
  assert.deepEqual(missing.map(m => m.reason).sort(), ['bad-id', 'not-found', 'too-large'])
  assert.equal(wire[wire.length - 1].type, 'att-end')

  const receiver = memDeps({})
  const puller = att.createAttachmentPuller({ send: () => {}, deps: receiver.deps, session: { failed: new Set(), requests: new Map() } })
  const frames = frameFile('x.png', Buffer.from('real bytes'))
  frames[0].hash = 'deadbeef'
  for (const m of frames) puller.onMessage(m)
  assert.equal(receiver.written.length, 0, 'hash mismatch: nothing written')
  assert.equal(puller.onMessage({ type: 'att-end' }), false, 'att-end terminates the batch')

  const capped = att.createAttachmentServer({ ...memDeps({}).deps, perPeerCap: 2 })
  const sent = []
  const peer = { deviceId: 'spammy' }
  capped.serve(peer, { type: 'att-req', ids: [] }, m => sent.push(m))
  capped.serve(peer, { type: 'att-req', ids: [] }, m => sent.push(m))
  sent.length = 0
  const r = capped.serve(peer, { type: 'att-req', ids: ['a'] }, m => sent.push(m))
  assert.equal(r.capped, true)
  assert.deepEqual(sent.map(m => m.type), ['att-end'])
})

test('att: puller batch caps, failed-set prevents retry loops, session request budget', () => {
  const session = { failed: new Set(), requests: new Map() }
  const sends = []
  const puller = att.createAttachmentPuller({
    send: m => sends.push(m), deps: memDeps({}).deps, session, peerId: 'peer-1',
    maxFiles: 20, maxBytes: 64 * 1024 * 1024,
    getKeys: () => Array.from({ length: 25 }, (_, i) => 'f' + i + '.png').concat(['f0.png']),
  })
  assert.equal(puller.maybeStart(() => {}, () => {}), true)
  assert.equal(sends[0].ids.length, 20, 'per-round batch cap (20 files)')
  assert.equal(sends[0].ids.filter(k => k === 'f0.png').length, 1, 'keys dedupe')
  assert.equal(puller.maybeStart(() => {}, () => {}), false, 'one batch per round')
  session.failed.add('f5.png')
  const sends2 = []
  const puller2 = att.createAttachmentPuller({
    send: m => sends2.push(m), deps: memDeps({}).deps, session, peerId: 'peer-1',
    getKeys: () => ['f5.png', 'zzz'],
  })
  assert.equal(puller2.maybeStart(() => {}, () => {}), true)
  assert.deepEqual(sends2[0].ids, ['zzz'], 'failed-set entries are skipped (no retry loop)')
  session.requests.set('peer-1', att.MAX_REQUESTS_PER_SESSION)
  const sends3 = []
  const puller3 = att.createAttachmentPuller({
    send: m => sends3.push(m), deps: memDeps({}).deps, session, peerId: 'peer-1',
    getKeys: () => ['never.png'],
  })
  assert.equal(puller3.maybeStart(() => {}, () => {}), false)
  assert.equal(sends3.length, 0)
})

test('att: missing-on-both-sides flows cleanly through the node-level message contract', () => {
  const sender = att.createAttachmentServer(memDeps({}).deps)
  const receiver = memDeps({})
  const session = { failed: new Set(), requests: new Map() }
  const puller = att.createAttachmentPuller({ send: () => {}, deps: receiver.deps, session, getKeys: () => ['gone.png'] })
  let done = false
  puller.maybeStart(() => { done = true }, () => {})
  const frames = []
  sender.serve({ deviceId: 'p' }, { type: 'att-req', ids: ['gone.png'] }, m => frames.push(m))
  for (const m of frames) if (m.type !== 'att-req') puller.onMessage(m)
  assert.equal(done, true)
  assert.equal(receiver.written.length, 0)
  assert.ok(session.failed.has('gone.png'), 'peer-lacks-file lands in the failed set (a later SESSION may retry)')
})

test('att: a throwing send is round-isolated - batch marked failed, maybeStart reports "not started"', () => {
  // Regression 2026-09-19: opts.send used to be allowed to throw out of maybeStart, which the
  // round's message dispatch turned into finish(err) — one broken attachment send then failed
  // EVERY sync round until the file appeared. The puller must swallow the error, mark the batch
  // in the per-session failed set, and let the round finish cleanly.
  const session = { failed: new Set(), requests: new Map() }
  const receiver = memDeps({})
  const puller = att.createAttachmentPuller({
    send: () => { throw new Error('sendVia: socket has no encrypted send path') },
    deps: receiver.deps,
    getKeys: () => ['a.png', 'b.pdf'],
    session,
  })
  let doneCbCalled = false
  assert.equal(puller.maybeStart(() => { doneCbCalled = true }, () => {}), false,
    'maybeStart reports "no request sent" so the caller finishes the round without error')
  assert.equal(doneCbCalled, false)
  assert.deepEqual([...session.failed].sort(), ['a.png', 'b.pdf'], 'the batch landed in the failed set (no retry loop)')
  // A later attempt must not re-request the failed keys (empty batch -> false, round still clean).
  assert.equal(puller.maybeStart(() => {}, () => {}), false)
})

/* ---------- same-name/different-content conflict: the row's key must resolve to the INCOMING bytes ---------- */

test('att: LAN pull of a colliding name renames on disk AND aliases the row key to the incoming content', () => {
  const filesDir = path.join(TMP, 'files')
  fs.mkdirSync(filesDir, { recursive: true })
  const localA = Buffer.from('device-A original photo bytes')
  const incomingB = Buffer.from('device-B different photo content')
  fs.writeFileSync(path.join(filesDir, 'clash.png'), localA)

  const d = att.defaultDeps()
  assert.equal(d.exists('clash.png'), true, 'pre-existing file is seen')
  const finalName = d.writeAtomic('clash.png', incomingB)
  assert.equal(finalName, 'clash-1.png', 'writeAtomic returns the FINAL stored basename on conflict rename')
  assert.deepEqual(fs.readFileSync(path.join(filesDir, 'clash.png')), localA, 'the local original is untouched')
  assert.deepEqual(fs.readFileSync(path.join(filesDir, 'clash-1.png')), incomingB, 'the incoming bytes landed under the renamed file')
  assert.equal(attachments.readAliases()['clash.png'], 'clash-1.png', 'the device-local alias map records the conflict rename')

  // THE regression: the synced row still says local://clash.png — every resolution point must
  // now yield the INCOMING content, not the pre-existing different file.
  assert.equal(d.exists('clash.png'), true)
  assert.equal(d.size('clash.png'), incomingB.length, 'missing-detection/size resolution consults the alias map')
  assert.deepEqual(d.read('clash.png', 0, incomingB.length - 1), incomingB, 'serving resolution consults the alias map')
  const resolved = attachments.attachmentPath('clash.png')
  assert.equal(path.basename(resolved), 'clash-1.png', 'local:// open/download resolution consults the alias map')
  assert.deepEqual(fs.readFileSync(resolved), incomingB, 'the row key opens the INCOMING content')

  // End-to-end through the real puller: onArrived carries the final name, the file lands aliased.
  const wire = []
  const session = { failed: new Map(), requests: new Map() }
  const puller = att.createAttachmentPuller({ send: m => wire.push(m), session, getKeys: () => ['clash2.png'], onArrived: (id, finalN) => wire.push({ type: '__arrived', id, finalN }) })
  puller.maybeStart(() => {}, () => {})
  fs.writeFileSync(path.join(filesDir, 'clash2.png'), localA)
  puller.onMessage({ type: 'att-meta', id: 'clash2.png', size: incomingB.length, hash: sha(incomingB) })
  puller.onMessage({ type: 'att-chunk', id: 'clash2.png', index: 0, data: incomingB.toString('base64'), final: true })
  puller.onMessage({ type: 'att-end' })
  const arrived = wire.find(m => m.type === '__arrived')
  assert.equal(arrived.finalN, 'clash2-1.png', 'puller forwards the final stored basename to the host')
  assert.equal(attachments.attachmentPath('clash2.png'), path.join(filesDir, 'clash2-1.png'))

  // Dedup (identical content) is NOT a conflict: no alias, original name returned.
  assert.equal(d.writeAtomic('clash.png', localA), 'clash.png')
  assert.equal(attachments.readAliases()['clash.png'], 'clash-1.png', 'dedup must not overwrite the conflict alias')

  // Deleting the aliased key clears the alias entry.
  fs.unlinkSync(path.join(filesDir, 'clash2-1.png'))
  assert.equal(attachments.deleteAlias('clash2.png'), true)
  assert.equal(attachments.readAliases()['clash2.png'], undefined)
  assert.equal(attachments.attachmentPath('clash2.png'), path.join(filesDir, 'clash2.png'), 'after alias cleanup the key resolves through the plain base name again')
})

/* ---------- LAN receive door enforces the shared storage quota ---------- */

test('att: a LAN-received file past the storage quota is refused and lands in the failed-set', () => {
  const d = att.defaultDeps()
  attachments.__setTotalQuota(8) // shrink the 64MB quota: any non-trivial write must be refused
  try {
    assert.throws(() => d.writeAtomic('overquota.png', Buffer.from('these bytes exceed the tiny quota')), /storage quota exceeded/,
      'the LAN disk layer must call attachments-guards.assertWriteAllowed (same contract as the upload door)')
    // Through the puller: the refusal must mark the id failed (24h failed-set, no retry loop)
    // instead of surfacing as a round failure or silently landing the file.
    const filesDir = path.join(TMP, 'files')
    fs.mkdirSync(filesDir, { recursive: true })
    const session = { failed: new Map(), requests: new Map() }
    const puller = att.createAttachmentPuller({ send: () => {}, session, getKeys: () => ['overquota2.png'] })
    puller.maybeStart(() => {}, () => {})
    const payload = Buffer.from('payload past the shrunk quota')
    puller.onMessage({ type: 'att-meta', id: 'overquota2.png', size: payload.length, hash: sha(payload) })
    puller.onMessage({ type: 'att-chunk', id: 'overquota2.png', index: 0, data: payload.toString('base64'), final: true })
    puller.onMessage({ type: 'att-end' })
    assert.equal(session.failed.has('overquota2.png'), true, 'quota refusal lands in the per-session failed-set')
    assert.equal(fs.readdirSync(filesDir).filter(f => f.startsWith('overquota2')).length, 0, 'nothing landed on disk')
  } finally {
    attachments.__setTotalQuota(null) // restore the real 64MB quota for the other tests
  }
})
