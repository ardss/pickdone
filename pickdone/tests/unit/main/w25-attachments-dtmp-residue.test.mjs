import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

// W25: the third crash-residue shape. attachments' own spool tmp is `x.att-tmp-<ts>-<rand>`, but
// saveAttachment writes it THROUGH durable-fs, whose atomic tmp spelling is
// `<name>.<pid>.<ms>.<seq>.dtmp` — a crash between spool-open and rename leaves
// `x.att-tmp-<ts>-<rand>.<pid>.<ms>.<seq>.dtmp`, which matched neither the D19 `.att-tmp-\d+-\d+$`
// residue regex (ends in .dtmp) nor the W16 0-byte phantom class (non-zero size): never swept,
// permanently quota-counted — every crash shrank the 64MB/200-file budget by one residue.

test('w25: durable-fs composite dtmp residue is swept after 24h and excluded from quota', () => {
  const att = require('../../../src/main/attachments.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w25-dtmp-'))
  const now = Date.now()
  const old = new Date(now - 25 * 60 * 60 * 1000)
  const mk = (name, content, mtime) => {
    const p = path.join(dir, name)
    fs.writeFileSync(p, content)
    if (mtime) fs.utimesSync(p, mtime, mtime)
    return p
  }
  // the crash shape: attachments tmp spool + durable-fs composite suffix, non-zero bytes, old
  const residue = mk('t1_100_x.att-tmp-1698739200000-123456.4242.1698739200123.7.dtmp', 'partial-payload', old)
  // young composite dtmp may be a concurrent durable write: never touched
  const young = mk('t1_101_y.att-tmp-1698739200000-234567.4242.1698739200456.8.dtmp', 'in-flight', new Date(now - 60 * 1000))
  // real attachment survives
  const real = mk('t1_102_real.png', 'bytes', old)

  const removed = att.sweepTmpResidue(dir, { now, fsMod: fs })
  assert.equal(removed, 1, 'old composite dtmp residue swept, young one untouched')
  assert.equal(fs.existsSync(residue), false)
  assert.equal(fs.existsSync(young), true, 'young in-flight durable spool must survive')
  assert.equal(fs.existsSync(real), true)

  // even before sweeping, the residue class must not count toward the 64MB/200-file budget
  const usage = att.dirUsage(dir)
  assert.equal(usage.count, 1, 'only the real attachment counts (residue + young spool excluded)')
  assert.equal(usage.bytes, 'bytes'.length)
})

test('w25: a legal attachment name never collides with the durable dtmp shape', () => {
  const att = require('../../../src/main/attachments.js')
  // minted keys are <prefix>_<ts>_<suffix>.<allowed-ext>; `dtmp` is not an allowed extension, so
  // the classifier can never eat a real attachment. Spot-check the predicate directly:
  assert.equal(att.isCrashTmpResidue('t1_100_real.png'), false)
  assert.equal(att.isCrashTmpResidue('aliases.json'), false)
  assert.equal(att.isCrashTmpResidue('t1_100_x.att-tmp-1698739200000-123456.4242.1698739200123.7.dtmp'), true)
})
