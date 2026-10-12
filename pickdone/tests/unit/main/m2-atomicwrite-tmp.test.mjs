/* M2 fix 3 (2026-10-09): atomicWriteJson's failure-cleanup used to pre-mint a tmp path with a
 * SECOND dtmpPath() call — its seq differs from the one writeFileDurable minted internally, so
 * the cleanup checked a path that NEVER existed (dead code) while the real tmp residue survived.
 * Fix contract: writeFileDurable RETURNS the actual tmp path and attaches it to a thrown error as
 * err.dtmpPath; the handler cleans up THAT path.
 * Red before the fix: with a fake fs lacking rmSync, the fake tmp entry survives the failure.
 * Run: node --test tests/unit/main/m2-atomicwrite-tmp.test.mjs */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Module = require('module')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-dtmp-'))
// electron stub before backup.js loads (electron-log / log-isolation chain)
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => TMP }, BrowserWindow: class {}, ipcMain: { on: () => {} } }
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const { writeFileDurable } = require('../../../src/main/durable-fs.js')
const backupHandlers = require('../../../src/main/handlers/backup.js')

test('M2 fix3: writeFileDurable returns the actual tmp path it used (success contract)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-dtmp-ok-'))
  const file = path.join(dir, 'critical.json')
  const tmp = writeFileDurable(file, '{"ok":1}')
  assert.equal(typeof tmp, 'string', 'the real tmp path is returned')
  assert.ok(tmp.endsWith('.dtmp'), 'tmp name keeps the .dtmp residue-sweep suffix')
  assert.notEqual(tmp, file)
  assert.equal(fs.existsSync(tmp), false, 'tmp was renamed away (published as the target)')
  assert.equal(fs.readFileSync(file, 'utf8'), '{"ok":1}')
})

test('M2 fix3: mid-write failure cleans the REAL tmp file, target unchanged, ok:false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-dtmp-fail-'))
  const name = 'auto-x.json'
  const target = path.join(dir, name)
  const fake = new Map() // fake fs filesystem
  fake.set(target, 'OLD') // a pre-existing snapshot must survive the failed write untouched
  // NO rmSync on the fake: the durable layer's internal cleanup falls back to the REAL fs
  // (path not on disk → no-op), so ONLY the handler's err.dtmpPath-based cleanup can clear
  // the fake tmp — exactly the dead-code path this fix revives.
  const fsMod = {
    writeFileSync (p, d) { fake.set(p, d) },
    existsSync: p => fake.has(p),
    unlinkSync (p) { if (!fake.has(p)) throw new Error('ENOENT ' + p); fake.delete(p) },
    renameSync () { throw new Error('EFAKE: rename interrupted (simulated mid-write failure)') },
  }
  const r = backupHandlers.atomicWriteJson(fsMod, dir, name, '{"new":1}')
  assert.equal(r.ok, false, 'failure is reported honestly')
  assert.match(r.error, /EFAKE/)
  assert.equal(fake.get(target), 'OLD', 'the target snapshot is byte-identical after the failure')
  const tmpLeft = [...fake.keys()].filter(p => p !== target)
  assert.deepEqual(tmpLeft, [],
    'RED before the fix: the real tmp residue survived — cleanup targeted a never-existing re-minted path')
})
