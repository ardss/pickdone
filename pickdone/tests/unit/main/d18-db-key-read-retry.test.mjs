/**
 * D18 (2026-10-02) — db.key transient-lock init failure.
 * The bare fs.readFileSync(keyFile) in db.js init threw on a transient Windows lock (EPERM/EBUSY
 * from AV/indexer); recovery saw an intact header, answered 'transient' with NO backoff, and the
 * immediate re-init failure surfaced the reset-data dialog for a HEALTHY database.
 * Fix: db-key-read.readDbKeyWithRetry — bounded backoff retries inside init; on exhaustion a
 * DISTINCT coded error (DB_KEY_TRANSIENT_UNREADABLE) that index.js classifies as transient
 * (retry once, then a dedicated dialog WITHOUT the reset-data button).
 * Run: node --test tests/unit/main/d18-db-key-read-retry.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { readDbKeyWithRetry, DB_KEY_TRANSIENT_UNREADABLE } = require('../../../src/main/db-key-read.js')

test('D18: existing readable key file returns the trimmed key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd18-key-'))
  const f = path.join(dir, 'db.key')
  fs.writeFileSync(f, '  ' + 'a'.repeat(64) + '\n')
  assert.equal(readDbKeyWithRetry(f), 'a'.repeat(64))
})

test('D18: missing key file returns null (fresh install / plaintext db)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd18-key-'))
  assert.equal(readDbKeyWithRetry(path.join(dir, 'nope.key')), null)
})

test('D18: a transient read failure retries with backoff and succeeds', () => {
  const f = path.join('Z:', os.tmpdir(), 'd18-nonexistent', 'db.key') // path shape only — read is faked
  let calls = 0
  const sleeps = []
  const key = readDbKeyWithRetry(f, {
    exists: () => true,
    read: () => { calls++; if (calls < 3) { const e = new Error('locked'); e.code = 'EBUSY'; throw e } return ' '.repeat(10) + 'b'.repeat(64) + '\n' },
    attempts: 3,
    backoffMs: 500,
    sleep: ms => sleeps.push(ms)
  })
  assert.equal(calls, 3, 'two locked reads then a good one')
  assert.equal(key, 'b'.repeat(64))
  assert.deepEqual(sleeps, [500, 500], 'backoff between attempts, not before the first')
})

test('D18: exhaustion throws the DISTINCT transient-coded error (recovery stays conservative)', () => {
  const f = path.join('Z:', os.tmpdir(), 'd18-nonexistent', 'db.key')
  let calls = 0
  try {
    readDbKeyWithRetry(f, {
      exists: () => true,
      read: () => { calls++; const e = new Error('EBUSY: resource busy'); e.code = 'EBUSY'; throw e },
      attempts: 3,
      backoffMs: 1,
      sleep: () => {}
    })
    assert.fail('expected throw')
  } catch (e) {
    assert.equal(e.code, DB_KEY_TRANSIENT_UNREADABLE)
    assert.equal(calls, 3, 'every attempt in the budget is used')
    assert.ok(/stayed unreadable/.test(e.message))
  }
})

test('D18: db.js init routes its key read through the retry helper (source anchor)', () => {
  const src = fs.readFileSync(new URL('../../../src/main/db.js', import.meta.url), 'utf8')
  assert.ok(src.includes("require('./db-key-read').readDbKeyWithRetry(keyFile)"),
    'db.js must read db.key through the bounded-backoff helper')
  const idx = fs.readFileSync(new URL('../../../src/main/index.js', import.meta.url), 'utf8')
  assert.ok(idx.includes('DB_KEY_TRANSIENT_UNREADABLE'), 'index.js must classify the coded transient error')
})
