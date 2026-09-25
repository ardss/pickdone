/* C14-cross (2026-09-25 adversarial-review follow-up): the quota-exempt noise slot name shape
 * must be unclaimable over LAN sync. Since C14, attachments.js exempts `noise-custom.*` from
 * the 64MB/200-file quota — but the LAN pull gate only checked ALLOWED_EXT, so a malicious
 * peer could park a quota-exempt file under EVERY whitelisted extension (noise-custom.png,
 * noise-custom.pdf, …) that the white-noise pick (mp3/wav/ogg only) never overwrites: a
 * persistent quota escape. Both ingress layers now refuse the name shape:
 *   - puller protocol gate (att-transfer.js, next to the F-A2 extAllowed check): lands in the
 *     per-session failed-set, nothing touches the disk;
 *   - disk layer writeAtomic (defense in depth): throws before any write.
 * Run: node --test tests/unit/lan-sync/d4-c14-noise-slot-ingress-20260925.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const Module = require_('module')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'd4-c14-ingress-'))
const stubs = {
  electron: { app: { getPath: (k) => (k === 'userData' ? TMP : path.join(TMP, k)), isPackaged: false } },
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (stubs[request]) return stubs[request]
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const att = require_('../../../src/main/lan-sync/att-transfer.js')
const attachments = require_('../../../src/main/attachments.js')
const { createHash } = await import('node:crypto')
const sha = buf => createHash('sha256').update(buf).digest('hex')

/* ---------------- puller protocol gate ---------------- */

test('C14-cross: an att-meta/att-chunk stream for noise-custom.* is refused at the puller gate, writeAtomic never reached', () => {
  const written = []
  const deps = {
    exists: () => false, size: () => 0, read: () => Buffer.alloc(0),
    writeAtomic: (key, buf) => { written.push(key); return true },
    hashFn: sha,
  }
  const session = { failed: new Map(), requests: new Map() }
  const puller = att.createAttachmentPuller({ send: () => {}, deps, getKeys: () => ['noise-custom.png', 'noise-custom.mp3'], session })
  assert.equal(puller.maybeStart(() => {}, () => {}), true)
  const evil = Buffer.from('payload')
  for (const id of ['noise-custom.png', 'noise-custom.mp3']) {
    puller.onMessage({ type: 'att-meta', id, size: evil.length, hash: sha(evil) })
    puller.onMessage({ type: 'att-chunk', id, index: 0, data: evil.toString('base64'), final: true })
  }
  puller.onMessage({ type: 'att-end' })
  assert.deepEqual(written, [], 'the reserved slot name shape never reaches the disk layer')
  assert.equal(session.failed.has('noise-custom.png'), true, 'protocol-level refusal lands in the per-session failed-set')
  assert.equal(session.failed.has('noise-custom.mp3'), true)
})

/* ---------------- disk layer (real defaultDeps, real dir) ---------------- */

test('C14-cross: the real disk layer throws for noise-custom.png and lands nothing on disk', () => {
  const d = att.defaultDeps()
  assert.throws(() => d.writeAtomic('noise-custom.png', Buffer.from('evil')), /reserved white-noise slot/, 'disk-layer twin of the gate fires before any write')
  const filesDir = path.join(TMP, 'files')
  const landed = fs.existsSync(filesDir) ? fs.readdirSync(filesDir) : []
  assert.equal(landed.filter(f => f.startsWith('noise-custom.')).length, 0, 'no quota-exempt noise file ever hit the disk')
  assert.throws(() => d.writeAtomic('sub/dir/noise-custom.pdf', Buffer.from('evil')), /reserved/, 'basename is checked, not the raw key (path-shaped keys included)')
})

test('C14-cross: honest inbound files still land — the guard must not over-block (C14 exemption intact)', () => {
  const session = { failed: new Map(), requests: new Map() }
  const puller = att.createAttachmentPuller({ send: () => {}, getKeys: () => ['honest-c14.png'], session })
  puller.maybeStart(() => {}, () => {})
  const good = Buffer.from('honest bytes')
  puller.onMessage({ type: 'att-meta', id: 'honest-c14.png', size: good.length, hash: sha(good) })
  puller.onMessage({ type: 'att-chunk', id: 'honest-c14.png', index: 0, data: good.toString('base64'), final: true })
  puller.onMessage({ type: 'att-end' })
  assert.ok(fs.existsSync(path.join(TMP, 'files', 'honest-c14.png')), 'a normal attachment still arrives over LAN')
  assert.equal(session.failed.has('honest-c14.png'), false)
  // and the C14 quota exemption itself still classifies exactly the noise slot (unchanged)
  assert.equal(attachments.isUnownedNoiseFile('noise-custom.mp3'), true)
  assert.equal(attachments.isUnownedNoiseFile('honest-c14.png'), false)
})
