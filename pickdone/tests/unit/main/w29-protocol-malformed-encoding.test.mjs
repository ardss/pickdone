/* W29 (P3) — local:// handler: malformed percent-encoding falls back to the RAW key.
 *
 * decodeURIComponent('a%zz.png') throws URIError; the outer handler catch mapped that to
 * a 404 while attachmentPath()'s raw-key fallback (same file) could still resolve the
 * key — so a malformed-encoding key was counted as present by the reference counters yet
 * never servable, and the file survived as a dead residual when its task was deleted.
 * Fix: the handler falls back to the raw key (attachmentPath parity); containment +
 * realpath still gate what is served.
 *
 * Run: node --test tests/unit/main/w29-protocol-malformed-encoding.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Module from 'node:module'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const ROOT = path.resolve(import.meta.dirname, '../../..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'w29-protocol-'))
fs.mkdirSync(path.join(TMP, 'files'), { recursive: true })

// electron stub: capture protocol.handle callbacks; app.getPath('userData') → TMP
const captured = {}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => TMP, getVersion: () => '0.0.0-test' }, protocol: { handle: (scheme, cb) => { captured[scheme] = cb } } }
  }
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

// copy protocol.js + the src/main top level so the handler's __dirname-derived requires resolve
fs.mkdirSync(path.join(TMP, 'src', 'main'), { recursive: true })
for (const f of fs.readdirSync(path.join(ROOT, 'src', 'main'))) {
  if (f.endsWith('.js')) fs.copyFileSync(path.join(ROOT, 'src', 'main', f), path.join(TMP, 'src', 'main', f))
}
const protocol = require(path.join(TMP, 'src', 'main', 'protocol.js'))
protocol.handleAppProtocol()

test('w29: a local:// key with malformed percent-encoding still serves the raw-named file', async () => {
  // the literal on-disk name is 'a%zz.png' — decodeURIComponent throws on the raw %zz
  fs.writeFileSync(path.join(TMP, 'files', 'a%zz.png'), 'w29-bytes')
  const res = await captured.local({ url: 'local://a%zz.png' })
  assert.equal(res.status, 200, 'handler must NOT 404 on a URIError-shaped key (raw-key fallback)')
  const body = Buffer.from(await res.arrayBuffer()).toString('utf8')
  assert.equal(body, 'w29-bytes')
})

test('w29: well-formed keys keep decoding (path form, no behavior change)', async () => {
  fs.writeFileSync(path.join(TMP, 'files', 'plain.txt'), 'plain-bytes')
  const res = await captured.local({ url: 'local:///plain.txt' })
  assert.equal(res.status, 200)
  const body = Buffer.from(await res.arrayBuffer()).toString('utf8')
  assert.equal(body, 'plain-bytes')
})
