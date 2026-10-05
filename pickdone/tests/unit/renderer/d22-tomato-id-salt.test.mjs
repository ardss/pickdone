/**
 * D22 maintenance round (renderer) — tomatoId device-salt regression guards (fix 5).
 * Run: node --test tests/unit/renderer/d22-tomato-id-salt.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

if (!globalThis.window.location) globalThis.window.location = { hash: '' }

/* ---------- [F5] tomatoId device salt ---------- */

test('[F5] mintTomatoId: legacy format on test hosts, salted + device-stable behind the bridge', async () => {
  const tomato = await import('../../../renderer/js/store/tomato.js')
  assert.equal(typeof tomato.mintTomatoId, 'function', 'mintTomatoId exported for the regression pin')
  // no window.todoAPI in this host -> legacy unsalted format (keeps existing exact-id pins valid)
  const a = tomato.mintTomatoId('tmt_a_', 1700000000000)
  assert.equal(a, 'tmt_a_1700000000000', 'bridge-less hosts keep the legacy id format')
  // with the Electron bridge present the id is salted, format-safe and stable across mints
  const prevApi = globalThis.window.todoAPI
  const prevStore = globalThis.localStorage
  globalThis.window.todoAPI = { __bridge: true, updateSettings: async () => ({}) }
  // deviceSalt reads the BARE localStorage global (same as the store's other LS uses)
  const mem = new Map()
  globalThis.localStorage = {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(String(k), String(v))
  }
  try {
    const salted1 = tomato.mintTomatoId('tmt_a_', 1700000000000)
    const salted2 = tomato.mintTomatoId('tmt_f_', 1700000000000)
    assert.match(salted1, /^tmt_a_1700000000000_[a-z0-9]+$/, 'salted id keeps the prefix+startedAt shape with a suffix')
    const s1 = salted1.slice(salted1.lastIndexOf('_') + 1)
    const s2 = salted2.slice(salted2.lastIndexOf('_') + 1)
    assert.equal(s1, s2, 'the salt is device-stable across mints (dedupe by startedAt still works per device)')
    assert.ok(salted1 !== 'tmt_a_1700000000000', 'a salted id differs from the unsalted legacy id')
    assert.ok(mem.get('tomatoDeviceSalt'), 'the salt is persisted in localStorage')
    // distinct devices (different stored salt) mint distinct ids for the same startedAt
    mem.set('tomatoDeviceSalt', 'zzzzzz')
    const other = tomato.mintTomatoId('tmt_a_', 1700000000000)
    assert.notEqual(salted1, other, 'two devices in the same millisecond no longer collide')
  } finally {
    if (prevApi === undefined) delete globalThis.window.todoAPI
    else globalThis.window.todoAPI = prevApi
    globalThis.localStorage = prevStore
  }
})

test('[F5] both store mint sites route through mintTomatoId (source anchors)', () => {
  const src = read('renderer/js/store/tomato.js')
  assert.ok(!src.includes("'tmt_a_' + s.startedAt") && !src.includes("'tmt_f_' + startedAt"),
    'the raw startedAt-only mint literals are gone')
  assert.ok(src.includes("mintTomatoId('tmt_a_', s.startedAt)") && src.includes("mintTomatoId('tmt_f_', startedAt)"),
    'giveUp and completeFocus both mint via the salted helper')
})

