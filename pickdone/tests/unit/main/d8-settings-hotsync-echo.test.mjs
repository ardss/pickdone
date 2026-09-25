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
