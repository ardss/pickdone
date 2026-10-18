/**
 * Wave-4 reconciliation: direct unit coverage for small exported attachments.js helpers whose
 * function-level coverage regressed below the ratchet baseline when the F3 claimSlot/realpath
 * code landed (funcs 57.89% < 58%). No behavior change — these pin existing contracts:
 *   - alias map: setAlias guards + durable roundtrip, deleteAlias, pruneMissingAliases
 *   - quota helpers: withinStorageQuota boundaries, dirTotalBytes/dirUsage on a real dir
 *   - noise/crash classifiers, claimSlot non-EEXIST propagation
 * Uses the same electron-stub Module._load pattern as f3-attachments-*.test.mjs so attachDir()
 * lands in a temp dir.
 * Run: node --test tests/unit/main/attachments-micro-coverage.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { Module } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'att-micro-'))
const ATT_DIR = path.join(TMP, 'files')
fs.mkdirSync(ATT_DIR, { recursive: true })

const ELECTRON_STUB = {
  app: { getPath: () => TMP, isPackaged: false, getVersion: () => '0.0.0-test' },
  protocol: { handle: () => {} }
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const A = await import('../../../src/main/attachments.js')

test('alias map: setAlias guards + durable roundtrip, deleteAlias, pruneMissingAliases', () => {
  assert.equal(A.setAlias('', 'x'), false, 'empty key refused')
  assert.equal(A.setAlias('k', ''), false, 'empty target refused')
  assert.equal(A.setAlias('same', 'same'), false, 'identity mapping refused')
  assert.equal(A.setAlias('local-key', 'disk-renamed.png'), true)
  assert.deepEqual(A.readAliases(), { 'local-key': 'disk-renamed.png' })
  assert.equal(A.deleteAlias('missing'), false)
  assert.equal(A.deleteAlias('local-key'), true)
  assert.deepEqual(A.readAliases(), {})
  // prune: a live target survives, a dead target's entry is dropped (returns removal count)
  fs.writeFileSync(path.join(ATT_DIR, 'alive.png'), 'x')
  A.setAlias('live', 'alive.png')
  A.setAlias('dead', 'gone.png')
  const removed = A.pruneMissingAliases(p => fs.existsSync(p))
  assert.equal(removed, 1, 'exactly the dead-target alias is pruned')
  const after = A.readAliases()
  assert.ok(!('dead' in after), 'dead-target alias pruned')
  assert.ok('live' in after, 'live-target alias kept')
})

test('quota helpers: withinStorageQuota boundaries + dirTotalBytes/dirUsage', () => {
  assert.equal(A.withinStorageQuota(0, 10, 100), true)
  assert.equal(A.withinStorageQuota(95, 10, 100), false)
  assert.equal(A.withinStorageQuota(90, 10, 100), true, 'exactly at the cap is allowed')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'att-quota-'))
  fs.writeFileSync(path.join(dir, 'x.png'), Buffer.alloc(10))
  fs.writeFileSync(path.join(dir, 'y.png'), Buffer.alloc(5))
  assert.ok(A.dirTotalBytes(dir) >= 15)
  assert.ok(A.dirUsage(dir))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('claimSlot: non-EEXIST errors propagate (not swallowed as bumps)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'att-claim-'))
  const mem = {
    openSync: (p, flags) => {
      if (String(p).endsWith('.png')) { const e = new Error('readonly'); e.code = 'EACCES'; throw e }
      return fs.openSync(p, flags)
    },
    closeSync: fd => fs.closeSync(fd)
  }
  assert.throws(() => A.claimSlot(dir, 'a.png', mem), e => e.code === 'EACCES',
    'a non-EEXIST open error must surface, not loop 1000 bumps')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('classifiers: crash-tmp residue + noise bookkeeping are boolean and shape-stable', () => {
  assert.equal(A.isCrashTmpResidue('focus.att-tmp-42-9'), true)
  assert.equal(A.isCrashTmpResidue('normal.png'), false)
  assert.equal(A.isUnownedNoiseFile('noise-custom.'), true)
  assert.equal(A.isUnownedNoiseFile('normal.png'), false)
})
