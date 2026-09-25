/* Settings hot-sync patch: machine-local stamp keys must never travel.
 * Root fix for the 2026-09-25 echo loop — a patch containing `_lsAt` made the renderer re-stamp
 * and re-persist the blob on apply (store/settings.js stamps _lsAt at Date.now()), which re-armed
 * the external-write watcher and re-broadcast forever (~4.2s cadence, pool/restart-only crash).
 *
 * Run: node --test tests/unit/main/d8-settings-hotsync-echo.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const { computeSettingsPatch } = require_('../../../src/main/settings-hot-sync.js')

test('echo-loop breaker: a doc that only moved _lsAt yields an EMPTY patch (no broadcast, no re-persist)', () => {
  const prev = { theme: 'dark', _savedAt: 1000, _lsAt: 5000, schemaV: 6 }
  const next = { theme: 'dark', _savedAt: 1000, _lsAt: 99000, schemaV: 6 }
  assert.deepEqual(computeSettingsPatch(next, prev), {})
})

test('real field changes still travel; bookkeeping keys are stripped around them', () => {
  const prev = { theme: 'dark', lang: 'zh-CN', _savedAt: 1000, _lsAt: 5000, schemaV: 6 }
  const next = { theme: 'light', lang: 'zh-CN', _savedAt: 2000, _lsAt: 99000, schemaV: 6 }
  const patch = computeSettingsPatch(next, prev)
  assert.deepEqual(patch, { theme: 'light' })
})

test('secret fields never travel even when changed', () => {
  const prev = { securityLockPassword: 'a', securityLockQuestion: 'q1', theme: 'dark' }
  const next = { securityLockPassword: 'b', securityLockQuestion: 'q2', theme: 'dark' }
  assert.deepEqual(computeSettingsPatch(next, prev), {})
})

test('reference-equal doc vs prev yields empty patch (baseline resync path)', () => {
  const doc = { theme: 'dark', _lsAt: 1 }
  assert.deepEqual(computeSettingsPatch(doc, doc), {})
})

/* B3: deletion tombstones — a key present in prev but gone from doc must travel as an explicit
 * null so other windows reset it (reset-to-default) instead of keeping the stale live value and
 * re-persisting it over the peer's deletion. */
test('B3: a key deleted from doc appears as null in the patch', () => {
  const prev = { themeDark: true, customFlag: 'x', _savedAt: 1 }
  const doc = { themeDark: true, _savedAt: 2 }
  assert.deepEqual(computeSettingsPatch(doc, prev), { customFlag: null })
})

test('B3: deleted secret and machine-local keys never travel as tombstones', () => {
  const prev = { securityLockPassword: 'a', _lsAt: 5, schemaV: 6, keepMe: 1 }
  const doc = {}
  assert.deepEqual(computeSettingsPatch(doc, prev), { keepMe: null })
})

/* B12: raw JSON.stringify is key-order-sensitive, so equal-content nested objects with different
 * key insertion order were reported as changed and broadcast a spurious patch (echo-churn class).
 * Canonical compare (contentFingerprint) must treat them as equal. */
test('B12: equal-content nested objects with different key order yield an EMPTY patch', () => {
  const prev = { shortcutKeySettings: { sync: 'ctrl+s', copy: 'ctrl+c' }, tomatoTime: 25 }
  const doc = { shortcutKeySettings: { copy: 'ctrl+c', sync: 'ctrl+s' }, tomatoTime: 25 }
  assert.deepEqual(computeSettingsPatch(doc, prev), {})
})

test('B12: nested objects with actually different content still travel', () => {
  const prev = { shortcutKeySettings: { sync: 'ctrl+s', copy: 'ctrl+c' } }
  const doc = { shortcutKeySettings: { copy: 'ctrl+c', sync: 'ctrl+shift+s' } }
  assert.deepEqual(computeSettingsPatch(doc, prev), { shortcutKeySettings: { copy: 'ctrl+c', sync: 'ctrl+shift+s' } })
})
