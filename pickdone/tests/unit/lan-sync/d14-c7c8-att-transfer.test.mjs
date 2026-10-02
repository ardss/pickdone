/* D14 C7+C8 regressions — attachment transfer:
 *   [C7] the receive-side writeAtomic dedup hashes the existing on-disk file via CHUNKED
 *        positional reads — the dedup path must never readFileSync the whole (up to 50MB) file
 *        on the main process (parity with the serve-side 2026-09-24 C8 fix).
 *   [C8] att serve(): a read failure (file vanished between the exists() precheck and the read)
 *        answers the per-file att-missing error shape and still terminates the batch with
 *        att-end — serve() keeps its never-throws contract and the requester settles fast
 *        instead of burning its full 120s round deadline.
 * Run: node --test tests/unit/lan-sync/d14-c7c8-att-transfer.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const Module = require_('module')

test('C7: writeAtomic dedup never readFileSyncs the existing file — chunked positional reads only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd14-c7-'))
  // Stub the electron-bound modules the disk layer reaches for, so defaultDeps is exercisable
  // from plain node and attachDir lands in a temp dir.
  const stubs = {
    '../attachments': { ALLOWED_EXT: new Set(['png']), attachDir: () => dir, readAliases: () => ({}), setAlias: () => {}, isUnownedNoiseFile: b => /^noise-custom\./.test(b) },
    '../attachments-guards': { assertWriteAllowed: () => {} },
  }
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (stubs[request] && parent && String(parent.filename || '').includes('att-transfer.js')) return stubs[request]
    if (request === 'node:fs') {
      const real = origLoad.call(this, request, parent, isMain)
      // readFileSync is BANNED in the dedup path (the old implementation read the whole file)
      return new Proxy(real, { get (t, p) { return p === 'readFileSync' ? () => { throw new Error('dedup used readFileSync (red before the fix)') } : t[p] } })
    }
    return origLoad.call(this, request, parent, isMain)
  }
  const resolved = require_.resolve(path.join(import.meta.dirname, '../../../src/main/lan-sync/att-transfer.js'))
  delete require_.cache[resolved]
  try {
    // the hook stays active for the WHOLE scenario: defaultDeps() reaches the stubs lazily
    const att = require_(resolved)
    const d = att.defaultDeps()
    const big = Buffer.alloc(att.ENTRY_CHUNK_BYTES + 1024, 9) // > one chunk: forces multi-chunk hashing
    const first = d.writeAtomic('d14c7.png', big)
    assert.equal(first, 'd14c7.png')
    // identical content → dedup no-op via the chunked hash (red before the fix: readFileSync threw)
    assert.equal(d.writeAtomic('d14c7.png', big), 'd14c7.png', 'identical content dedups without a whole-file readFileSync')
    // differing content still renames with a numeric suffix
    const other = Buffer.alloc(att.ENTRY_CHUNK_BYTES + 1024, 8)
    assert.equal(d.writeAtomic('d14c7.png', other), 'd14c7-1.png', 'conflict renamed')
    assert.ok(fs.readdirSync(dir).includes('d14c7-1.png'), 'files landed in the injected attachDir (stubs actually engaged)')
  } finally { Module._load = origLoad }
})

test('C8: a read throw inside serve() answers att-missing(read-error) and still ends the batch', () => {
  const att = require_('../../../src/main/lan-sync/att-transfer.js')
  const frames = []
  const deps = {
    exists: () => true,
    size: () => 10,
    read: () => { throw new Error('file vanished mid-serve') },
    writeAtomic: () => true,
  }
  const server = att.createAttachmentServer(deps)
  let result
  assert.doesNotThrow(() => {
    result = server.serve({ deviceId: 'peer' }, { ids: ['gone.png', 'gone2.png'] }, m => { frames.push(m); return true })
  }, 'serve() honors its never-throws contract (red before the fix: d.read throw escaped)')
  assert.deepEqual(frames.map(f => f.type), ['att-missing', 'att-missing', 'att-end'], 'per-file error shape + terminal att-end (requester settles fast)')
  assert.equal(frames[0].reason, 'read-error')
  assert.deepEqual(result, { sent: 0, missing: 2, budgetSkipped: 0 })
})
