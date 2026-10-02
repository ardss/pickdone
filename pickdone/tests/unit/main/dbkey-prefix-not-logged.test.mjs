import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// sec-dbkey-prefix-logged (P3): an invalid db.key used to be logged WITH its first 8 chars of
// key material. The warn must carry only non-secret facts (length, hex-ness). The logger stub
// must be require.cache-injected BEFORE requiring db.js (logger is bound at module load).

const require = createRequire(import.meta.url)
const elogPath = require.resolve('electron-log')
const logCalls = { warn: [], error: [] }
require.cache[elogPath] = {
  id: elogPath, filename: elogPath, loaded: true,
  exports: {
    info: () => {}, warn: (...a) => logCalls.warn.push(a.map(String).join(' ')), error: (...a) => logCalls.error.push(a.map(String).join(' ')),
    transports: { file: {}, console: {} },
    scope: () => ({ info () {}, warn () {}, error () {} })
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-dbkey-prefix-'))
const KEY = 'zz4t8q1x' + 'y'.repeat(32) // 40 chars, non-hex; first 8 chars are the leak marker
fs.writeFileSync(path.join(dir, 'db.key'), KEY, 'utf8')

process.env.TODO_DB_DIR = dir
process.env.TODO_USER_DATA_DIR = dir
const db = require('../../../src/main/db')
db.init(dir)

test('invalid db.key warn carries length/hex facts but NO key-material prefix', () => {
  const hit = logCalls.warn.find(w => w.includes('db.key content invalid'))
  assert.ok(hit, 'invalid-key warn still fires, got: ' + JSON.stringify(logCalls.warn))
  assert.ok(hit.includes('got length=40'), 'diagnostic includes key length: ' + hit)
  assert.ok(/hex=false/.test(hit), 'diagnostic includes hex-ness: ' + hit)
  assert.ok(!hit.includes(KEY.slice(0, 8)), 'warn must NOT contain the first 8 chars of key material: ' + hit)
})
