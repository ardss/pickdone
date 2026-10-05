/**
 * D22 (P2/P3) — lan-sync batch:
 *   1. settings-map-store: the degraded latch clears on a successful read even when the
 *      validate-fail early-return path runs (once degraded via a transient failure the store
 *      used to stay degraded forever through that path).
 *   2. att-transfer: att-chunk index is coerced explicitly; junk indexes (negative/fractional/
 *      garbage) are a fail-closed protocol error instead of silently truncating the assembly.
 *   3. line-reader: the electron-log dispatch-error write applies log-isolation like every
 *      other lan-sync log site (source anchor).
 * Run: node --test tests/unit/lan-sync/d22-p3-hardening.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const createJsonSettingStore = require('../../../src/main/lan-sync/settings-map-store.js')

function makeLog () {
  const warnings = []
  return { warn: (...a) => warnings.push(a.join(' ')), warnings }
}

test('D22: a successful read clears the degraded latch even on the validate-fail early-return', () => {
  const rows = new Map()
  const log = makeLog()
  // Step 1: a transient read failure latches degraded.
  let healthy = false
  const store = createJsonSettingStore({
    settingGet: () => { if (!healthy) throw new Error('transient'); return rows.get('k') },
    settingPut: (k, v) => { rows.set(k, v) },
    log, key: 'k', name: 'security log', defaultValue: '[]', validate: v => Array.isArray(v),
  })
  assert.throws(() => store.load(), /read failed/)
  assert.equal(store.canPersist(), false, 'latched after the failed read')
  // Step 2: fix the backing store to a READABLE value that still FAILS validate — the
  // early-return path that used to keep the latch set forever.
  rows.set('k', '{"not":"an array"}')
  healthy = true
  const v = store.load()
  assert.deepEqual(v, [], 'validate-fail still yields the default (readable-malformed policy)')
  assert.equal(store.canPersist(), true,
    'red before the fix: the validate-fail early-return kept the store degraded forever')
  assert.equal(store.persist(['a']), true, 'writes re-arm after the successful read')
})

test('D22: a plain successful load still clears the latch (unchanged happy path)', () => {
  const rows = new Map()
  rows.set('k', 'not json') // first read: readable, no validate -> default, no degrade
  const log = makeLog()
  const store = createJsonSettingStore({
    settingGet: k => { if (rows.get('k') === 'THROW') throw new Error('boom'); return rows.get(k) },
    settingPut: (k, v) => rows.set(k, v),
    log, key: 'k', name: 'peer watermarks', defaultValue: '{}',
  })
  rows.set('k', 'THROW')
  assert.throws(() => store.load())
  assert.equal(store.canPersist(), false)
  rows.set('k', '{"p1":9}')
  assert.deepEqual(store.load(), { p1: 9 })
  assert.equal(store.canPersist(), true)
})

/* ---------- 2. att-chunk index coercion ---------- */

test('D22: junk att-chunk indexes are a fail-closed protocol error, not a silent assembly hole', () => {
  // Source anchor: the coercion is explicit and rejects non-ordinal indexes.
  const src = fs.readFileSync(new URL('../../../src/main/lan-sync/att-transfer.js', import.meta.url), 'utf8')
  assert.ok(/const idx = Number\(msg\.index\)/.test(src), 'explicit Number coercion')
  assert.ok(/!Number\.isInteger\(idx\) \|\| idx < 0 \|\| idx >= 65536/.test(src), 'ordinal validity gate')
  assert.ok(!src.includes('current.chunks.set(Number(msg.index) || 0)'), 'red before the fix: fold-to-zero coercion gone')
})

/* ---------- 3. line-reader log isolation ---------- */

test('D22: line-reader applies log-isolation at its electron-log write site', () => {
  const src = fs.readFileSync(new URL('../../../src/main/lan-sync/line-reader.js', import.meta.url), 'utf8')
  const site = src.indexOf('#logDispatchError')
  const seg = src.slice(site, site + 800)
  assert.ok(seg.includes("require('../log-isolation')"),
    'red before the fix: dispatch errors bypassed the test-isolation log redirect')
})
