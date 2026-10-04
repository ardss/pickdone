/**
 * D18 (2026-10-02) — attachments alias map durable writes.
 * aliases.json (the device-local LAN conflict alias map) was written with a bare
 * writeFileSync — a torn write silently WIPED the whole map and readAliases' catch→{} lost
 * every entry. All three write sites (setAlias/deleteAlias/pruneMissingAliases) now route
 * through durable-fs.writeFileDurable (tmp + fsync + atomic rename, no residue on failure).
 * Run: node --test tests/unit/main/d18-attachments-alias-durable.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Module } from 'node:module'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'd18-att-'))
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => TMP, isPackaged: false } }
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const require = createRequire(import.meta.url)
const attachments = require('../../../src/main/attachments.js')

test('D18: setAlias/deleteAlias/pruneMissingAliases write atomically and leave no tmp residue', () => {
  assert.equal(attachments.setAlias('local://pic.png', 'pic-1.png'), true)
  const raw = fs.readFileSync(attachments.aliasesPath(), 'utf8')
  assert.deepEqual(JSON.parse(raw), { 'pic.png': 'pic-1.png' })
  assert.deepEqual(fs.readdirSync(TMP).filter(f => f.endsWith('.dtmp')), [],
    'red before the fix: bare writeFileSync left the file half-written on a crash; durable writes own the tmp lifecycle')
  assert.equal(attachments.deleteAlias('pic.png'), true)
  assert.deepEqual(attachments.readAliases(), {})
})

test('D18: pruneMissingAliases persists its remaining map durably too', () => {
  attachments.setAlias('a.png', 'a-1.png')
  attachments.setAlias('b.png', 'b-1.png')
  const removed = attachments.pruneMissingAliases(p => String(p).endsWith('a-1.png')) // a-1 exists, b-1 gone
  assert.equal(removed, 1)
  assert.deepEqual(JSON.parse(fs.readFileSync(attachments.aliasesPath(), 'utf8')), { 'a.png': 'a-1.png' })
  assert.deepEqual(fs.readdirSync(TMP).filter(f => f.endsWith('.dtmp')), [])
})

test('D18: a torn (truncated) aliases.json still reads as empty instead of crashing', () => {
  fs.writeFileSync(attachments.aliasesPath(), '{"a.png":"a-') // torn mid-write
  assert.deepEqual(attachments.readAliases(), {})
  // and the next write rebuilds the map from scratch (atomic rename, no residue)
  attachments.setAlias('c.png', 'c-1.png')
  assert.deepEqual(JSON.parse(fs.readFileSync(attachments.aliasesPath(), 'utf8')), { 'c.png': 'c-1.png' })
})

test('D18: source anchor — alias writes go through durable-fs, not bare writeFileSync', () => {
  const src = fs.readFileSync(new URL('../../../src/main/attachments.js', import.meta.url), 'utf8')
  assert.ok(src.includes("require('./durable-fs').writeFileDurable(aliasesPath()"), 'durable write helper present')
  assert.ok(!src.includes('fs.writeFileSync(aliasesPath()'), 'red before the fix: bare writeFileSync on aliases.json')
})
