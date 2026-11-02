// W29 coverage anchor — the serve-boundary key recovery (resolveAttachmentCase /
// punycodeRecoverBase) is otherwise exercised only through the live journey, which sits in the
// excluded live pool and contributes nothing to the unit coverage ratchet. These probes drive
// the exported pure functions against a real temp dir: literal-first order, punycode recovery,
// the recovered+%20 second-decode variant, ambiguity refusal, and unreadable-dir passthrough.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import punycode from 'node:punycode'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { resolveAttachmentCase, punycodeRecoverBase } = require('../../../src/main/attachments.js')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'w29-att-case-'))
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* sweeper fallback */ } })

test('punycodeRecoverBase: decodes a canonicalized host label back to the on-disk name', () => {
  const restored = punycodeRecoverBase(punycode.toASCII('中文probe.png'))
  assert.ok(restored && restored.includes('probe') && !restored.startsWith('xn--'), 'returns a decoded base for xn-- labels')
  assert.equal(punycodeRecoverBase('plain-name.png'), null, 'no xn-- label → null')
  assert.equal(punycodeRecoverBase('noxn--label.png'), null, 'xn-- not at a label start → null (no speculative decode)')
})

test('resolveAttachmentCase: literal base wins first (a real xn--*.png file is not speculatively decoded)', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'literal-'))
  fs.writeFileSync(path.join(dir, 'xn--literal.png'), 'a')
  const hit = resolveAttachmentCase(path.join(dir, 'xn--literal.png'))
  assert.equal(path.basename(hit), 'xn--literal.png')
})

test('resolveAttachmentCase: recovers a Chinese name from its punycoded request form', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'puny-'))
  const real = '中文probe.png'
  fs.writeFileSync(path.join(dir, real), 'b')
  const hit = resolveAttachmentCase(path.join(dir, punycode.toASCII(real)))
  assert.equal(path.basename(hit), real, 'the punycoded key resolves to the real on-disk file')
})

test('resolveAttachmentCase: recovered name carrying %20 gets one more percent-decode', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'space-'))
  const real = '中文 file.png'
  fs.writeFileSync(path.join(dir, real), 'c')
  // canonicalized host form: the space was escaped to %20 before IDNA, so the recovered
  // base still carries the literal escape — the third candidate decodes it back
  const hit = resolveAttachmentCase(path.join(dir, punycode.toASCII('中文%20file.png')))
  assert.equal(path.basename(hit), real)
})

test('resolveAttachmentCase: ambiguous case-insensitive twins do not serve the wrong twin (W17 intact)', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'twin-'))
  fs.writeFileSync(path.join(dir, 'Photo.PNG'), 'd')
  fs.writeFileSync(path.join(dir, 'photo.png'), 'e')
  // exact base 'photo.png' must win over the case-only twin
  const hit = resolveAttachmentCase(path.join(dir, 'photo.png'))
  assert.equal(path.basename(hit), 'photo.png')
  const upper = resolveAttachmentCase(path.join(dir, 'Photo.PNG'))
  assert.equal(path.basename(upper), 'Photo.PNG')
})

test('resolveAttachmentCase: unreadable dir keeps the raw path (caller 404s)', () => {
  const ghost = path.join(TMP, 'no-such-dir', 'x.png')
  assert.equal(resolveAttachmentCase(ghost), ghost)
})
