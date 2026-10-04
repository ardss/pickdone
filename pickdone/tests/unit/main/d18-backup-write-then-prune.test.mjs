/**
 * D18 (2026-10-02) — run-auto-backup write-then-prune ordering.
 * The GFS prune UNLINKED old snapshots BEFORE the new snapshot write: a failed write left the
 * tier strictly thinner with nothing added. The prune now executes only AFTER the outcome is
 * known — after a successful write, or after a dedup hit (the D12 invariant that aging
 * continues on dedup is preserved); a failed write skips the prune entirely.
 * Run: node --test tests/unit/main/d18-backup-write-then-prune.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { Module } from 'node:module'

const require = createRequire(import.meta.url)

// durable-fs stub with a failure toggle: atomicWriteJson resolves '../durable-fs' at call time
const realDurable = require('../../../src/main/durable-fs.js')
const durableStub = {
  dtmpPath: realDurable.dtmpPath,
  writeFileDurable: (f, d) => {
    if (durableStub.fail) throw new Error('simulated disk failure (D18)')
    return realDurable.writeFileDurable(f, d)
  },
  fail: false
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => os.tmpdir(), getVersion: () => '0' } }
  if (request === '../durable-fs') return durableStub
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const backupHandlers = require('../../../src/main/handlers/backup.js')
const MAIN_WC = { id: 'main-wc' }
const eMain = { sender: MAIN_WC }
const ctx = {
  isLocked: () => false,
  app: { getPath: () => os.tmpdir() },
  getMainWindow: () => ({ webContents: MAIN_WC, isDestroyed: () => false })
}

function seededDir (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd18-bkp-'))
  process.env.TODO_BACKUP_DIR = dir
  for (const n of ['auto-20260901-100000.json', 'auto-20260902-100000.json', 'auto-20260903-100000.json']) {
    fs.writeFileSync(path.join(dir, n), '{"seed":' + n.length + '}')
  }
  t._dir = dir
  return dir
}

test('D18: a FAILED snapshot write does not prune — the tier is never thinned for nothing', (t) => {
  const dir = seededDir(t)
  const handlers = backupHandlers(ctx)
  durableStub.fail = true
  try {
    const r = handlers['run-auto-backup'](eMain, '{"fresh":true}', { recent: 1, dailyDays: 0, weeklyWeeks: 0 })
    assert.equal(r.ok, false, 'the write fails as injected')
    const left = fs.readdirSync(dir).filter(f => /^(auto|evt)-/.test(f)).sort()
    assert.equal(left.length, 3,
      'red before the fix: the prune ran BEFORE the write, so the failed write left only 1 old snapshot with nothing added')
  } finally { durableStub.fail = false }
})

test('D18: a SUCCESSFUL write still prunes (aging continues, new file excluded from selection)', (t) => {
  const dir = seededDir(t)
  const handlers = backupHandlers(ctx)
  const r = handlers['run-auto-backup'](eMain, '{"fresh":true}', { recent: 1, dailyDays: 0, weeklyWeeks: 0 })
  assert.equal(r.ok, true)
  assert.ok(fs.existsSync(path.join(dir, r.file)), 'the new snapshot landed first')
  const left = fs.readdirSync(dir).filter(f => /^(auto|evt)-/.test(f)).sort()
  assert.deepEqual(left, ['auto-20260903-100000.json', r.file].sort(),
    'prune keeps the newest OLD snapshot (recent=1 over the pre-write list) plus the fresh file')
})
