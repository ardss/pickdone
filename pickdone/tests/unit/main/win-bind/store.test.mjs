/** T7 slice-2 RED tests — win-bind persistence store (src/main/win-bind/store.js).
 *  Contract: userData/task-window-bindings.json, {version:1,bindings:[{taskId,ref}]}, durable
 *  atomic write, corrupt-file .bad quarantine, 500-entry cap, test-only dir relocation. */
import { test } from '../../../pilot/runner-shim.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const createWinBindStore = require('../../../../src/main/win-bind/store.js')

function tmpDir () { return fs.mkdtempSync(path.join(os.tmpdir(), 'winbind-store-')) }
const REF = i => ({ processName: 'notepad', execPath: 'C:\\w\\notepad.exe', title: 't' + i, pidHint: 1000 + i, hwnd: 2000 + i, boundAt: 1234567890 + i })

test('empty dir: list [] and get null; lazily creates nothing until first put', () => {
  const dir = tmpDir()
  const s = createWinBindStore({ log: { warn: () => {} } })
  s.__setDirForTests(dir)
  assert.deepEqual(s.list(), [])
  assert.equal(s.get('nope'), null)
  assert.equal(fs.existsSync(path.join(dir, 'task-window-bindings.json')), false)
})

test('put/get/list round-trip and on-disk shape {version:1,bindings}', () => {
  const dir = tmpDir()
  const s = createWinBindStore({ log: { warn: () => {} } })
  s.__setDirForTests(dir)
  assert.equal(s.put({ taskId: 'task-1', ref: REF(1) }), true)
  assert.deepEqual(s.get('task-1'), { taskId: 'task-1', ref: REF(1) })
  assert.deepEqual(s.list(), [{ taskId: 'task-1', ref: REF(1) }])
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'task-window-bindings.json'), 'utf8'))
  assert.deepEqual(raw, { version: 1, bindings: [{ taskId: 'task-1', ref: REF(1) }] })
})

test('re-open store on the same file sees persisted bindings (true durability)', () => {
  const dir = tmpDir()
  const a = createWinBindStore({ log: { warn: () => {} } })
  a.__setDirForTests(dir)
  a.put({ taskId: 't1', ref: REF(1) })
  const b = createWinBindStore({ log: { warn: () => {} } })
  b.__setDirForTests(dir)
  assert.equal(b.list().length, 1)
  assert.deepEqual(b.get('t1'), { taskId: 't1', ref: REF(1) })
})

test('re-put same taskId overwrites (one task at most one window), no count growth', () => {
  const dir = tmpDir()
  const s = createWinBindStore({ log: { warn: () => {} } })
  s.__setDirForTests(dir)
  s.put({ taskId: 't1', ref: REF(1) })
  s.put({ taskId: 't1', ref: REF(2) })
  assert.equal(s.list().length, 1)
  assert.deepEqual(s.get('t1').ref, REF(2))
})

test('cap 500: 500 distinct taskIds ok, 501st rejected, overwrite of an existing id still ok', () => {
  const dir = tmpDir()
  const s = createWinBindStore({ log: { warn: () => {} } })
  s.__setDirForTests(dir)
  for (let i = 0; i < 500; i++) assert.equal(s.put({ taskId: 't' + i, ref: REF(i) }), true)
  assert.equal(s.put({ taskId: 't500', ref: REF(500) }), false)
  assert.equal(s.list().length, 500)
  assert.equal(s.put({ taskId: 't0', ref: REF(999) }), true) // overwrite path unaffected by cap
})

test('corrupt file: quarantined to .bad, list falls back to [] without overwriting the original', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'task-window-bindings.json')
  fs.writeFileSync(file, '{ this is not json', 'utf8')
  const s = createWinBindStore({ log: { warn: () => {} } })
  s.__setDirForTests(dir)
  assert.deepEqual(s.list(), [])
  assert.equal(fs.existsSync(file), false)
  assert.equal(fs.existsSync(file + '.bad'), true)
  assert.equal(fs.readFileSync(file + '.bad', 'utf8'), '{ this is not json')
})

test('remove: existing → true and persisted; missing → false (idempotent, no throw)', () => {
  const dir = tmpDir()
  const s = createWinBindStore({ log: { warn: () => {} } })
  s.__setDirForTests(dir)
  s.put({ taskId: 't1', ref: REF(1) })
  assert.equal(s.remove('t1'), true)
  assert.deepEqual(s.list(), [])
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'task-window-bindings.json'), 'utf8'))
  assert.deepEqual(raw.bindings, [])
  assert.equal(s.remove('t1'), false)
  assert.equal(s.remove('never-existed'), false)
})

test('write failure injected through fsMod: put returns false and the cache stays consistent', () => {
  const dir = tmpDir()
  let failNext = false
  const fsMod = {
    writeFileSync: (f, d) => { if (failNext) { const e = new Error('disk on fire'); e.code = 'EIO'; throw e } return fs.writeFileSync(f, d) },
    renameSync: (a, b) => fs.renameSync(a, b),
    rmSync: (f, o) => fs.rmSync(f, o)
  }
  const s = createWinBindStore({ fsMod, log: { warn: () => {} } })
  s.__setDirForTests(dir)
  s.put({ taskId: 't1', ref: REF(1) })
  failNext = true
  assert.equal(s.put({ taskId: 't2', ref: REF(2) }), false)
  failNext = false
  assert.deepEqual(s.list().map(b => b.taskId), ['t1']) // rolled back, not half-applied
})

test('deps.file wins as the full file path (no dir resolution)', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'custom-name.json')
  const s = createWinBindStore({ file, log: { warn: () => {} } })
  s.put({ taskId: 't1', ref: REF(1) })
  assert.equal(fs.existsSync(file), true)
})
