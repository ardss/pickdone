import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { allowWithinRate } = require('../src/main/security-lock.js')
const { selectStaleTmp } = require('../src/main/autoBackup.js')

/* ---- allowWithinRate (P1-6: notification channel rate limit) ---- */
test('allowWithinRate: allows up to the limit inside the window, then blocks', () => {
  const t = []
  const base = 1_000_000
  for (let i = 0; i < 10; i++) assert.equal(allowWithinRate(t, base + i), true, 'send ' + i + ' allowed')
  assert.equal(allowWithinRate(t, base + 11), false, '11th within 10s blocked')
})
test('allowWithinRate: window slides — old timestamps free up budget', () => {
  const t = []
  const base = 2_000_000
  for (let i = 0; i < 10; i++) allowWithinRate(t, base + i)
  assert.equal(allowWithinRate(t, base + 5000), false)
  assert.equal(allowWithinRate(t, base + 10001), true, 'first send older than 10s expired → allowed again')
})
test('allowWithinRate: empty/non-array history starts clean', () => {
  const t = []
  assert.equal(allowWithinRate(t, 0), true)
})

/* ---- selectStaleTmp (P2-10: interrupted .tmp-* backup residue sweep) ---- */
test('selectStaleTmp: only .tmp- prefixed files older than maxAge are picked', () => {
  const now = 10_000_000
  const entries = [
    { name: '.tmp-auto-20260911-010101.json', mtimeMs: now - 2 * 3600_000 }, // stale
    { name: '.tmp-auto-20260911-090000.json', mtimeMs: now - 60_000 }, // fresh (in-flight write)
    { name: 'auto-20260910-010101.json', mtimeMs: now - 90 * 24 * 3600_000 }, // real backup, never swept
    { name: 'evt-r-20260909-010101.json', mtimeMs: now - 90 * 24 * 3600_000 },
    { name: '.tmp-x.json' }, // no mtime → skipped
    null
  ]
  assert.deepEqual(selectStaleTmp(entries, { now }), ['.tmp-auto-20260911-010101.json'])
})
test('selectStaleTmp: custom maxAge respected, empty input safe', () => {
  const now = 1_000_000
  assert.deepEqual(selectStaleTmp([{ name: '.tmp-a', mtimeMs: now - 500 }], { now, maxAgeMs: 1000 }), [])
  assert.deepEqual(selectStaleTmp([{ name: '.tmp-a', mtimeMs: now - 1500 }], { now, maxAgeMs: 1000 }), ['.tmp-a'])
  assert.deepEqual(selectStaleTmp(null), [])
})

/* ---- db.js close/null + init re-init policy (P2-9) ---- */
test('db: isOpen is false after close; re-init while open rebuilds cleanly; failed init cleans up', { skip: !fs.existsSync(path.resolve(import.meta.dirname, '../vendor/better-sqlite3-multiple-ciphers')) && 'vendor driver missing' }, () => {
  const dbm = require('../src/main/db.js')
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'pickdone-r5-db-'))
  try {
    dbm.init(ud)
    assert.equal(dbm.isOpen(), true)
    dbm.call('setMeta', ['k', 'v'])
    dbm.close()
    assert.equal(dbm.isOpen(), false, 'isOpen() must be false after close (was stuck true)')
    // re-init after close is legal (tests/CLI switch directories this way)
    dbm.init(ud)
    assert.equal(dbm.isOpen(), true)
    // re-init while open closes the old handle first and rebuilds (same-process restart idiom;
    // an abrupt throw here broke 16 unit tests that simulate restart via init-without-close)
    dbm.init(ud)
    assert.equal(dbm.isOpen(), true, 're-init while open rebuilds a live handle')
    assert.equal(dbm.call('getMeta', 'k'), 'v', 'data intact after re-init rebuild')
  } finally {
    dbm.close()
    fs.rmSync(ud, { recursive: true, force: true })
  }
})

/* ---- attachmentPath malformed percent-encoding fallback (P2-12) ---- */
test('attachmentPath: malformed % sequences fall back to the raw key instead of throwing URIError', () => {
  // Stub electron.app (require('electron') is a plain string under plain node); bust cache + patch
  // BEFORE requiring, otherwise the module binds the electron stub-string at load time
  const Module = require('module')
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickdone-r5-att-'))
  const resolved = require.resolve('../src/main/attachments.js')
  delete require.cache[resolved]
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => tmpRoot } }
    return origLoad.call(this, request, parent, isMain)
  }
  const attachments = require('../src/main/attachments.js')
  try {
    const out = attachments.attachmentPath('a%zz.png') // used to throw URIError
    assert.ok(out.endsWith('a%zz.png'), 'falls back to raw key: ' + out)
    const ok = attachments.attachmentPath(encodeURIComponent('t1_123_pic name.png'))
    assert.ok(ok.includes('pic name.png'), 'valid encoding still decodes')
  } finally {
    Module._load = origLoad
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})
