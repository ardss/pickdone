/**
 * Pins for the project status contract (v0.2): meta key `projectStatus:<categoryId>`,
 * string 'active' | 'paused' | 'done' | 'cancelled', absent/invalid = 'active'.
 * The CLI implements the same normalization; here we pin the renderer util plus
 * i18n key completeness/parity across the zh-CN and en-US shard files.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROJECT_STATUSES, DEFAULT_STATUS, normalizeStatus, statusI18nKey, STATUS_I18N_KEYS, STATUS_FILTER_I18N_KEYS
} from '../renderer/js/utils/projectStatus.js'
import zhShard from '../renderer/js/i18n/locales/zh-CN-Q.js'
import enShard from '../renderer/js/i18n/locales/en-US-Q.js'

test('normalizeStatus round-trips every defined status', () => {
  assert.deepEqual(PROJECT_STATUSES, ['active', 'paused', 'done', 'cancelled'])
  for (const s of PROJECT_STATUSES) assert.equal(normalizeStatus(s), s)
})

test('normalizeStatus falls back to active for absent/invalid values', () => {
  assert.equal(DEFAULT_STATUS, 'active')
  for (const bad of [undefined, null, '', 'ACTIVE', 'Active', 'archived', 'actives', 0, 1, true, {}, [], () => 'active']) {
    assert.equal(normalizeStatus(bad), 'active', `input ${String(bad)}`)
  }
})

test('statusI18nKey maps invalid input to the active-status key', () => {
  assert.equal(statusI18nKey('nonsense'), STATUS_I18N_KEYS.active)
  assert.equal(statusI18nKey(undefined), STATUS_I18N_KEYS.active)
  assert.equal(statusI18nKey('paused'), 'projQ.statusPaused')
})

test('the status key map covers exactly the four statuses with projQ keys', () => {
  assert.deepEqual(Object.keys(STATUS_I18N_KEYS).sort(), [...PROJECT_STATUSES].sort())
  for (const s of PROJECT_STATUSES) {
    assert.ok(STATUS_I18N_KEYS[s].startsWith('projQ.'), `key for ${s} must live under projQ`)
  }
})

test('both language shards define a string value for every status key', () => {
  for (const s of PROJECT_STATUSES) {
    const key = STATUS_I18N_KEYS[s].slice('projQ.'.length)
    for (const [locale, shard] of [['zh-CN', zhShard], ['en-US', enShard]]) {
      assert.ok(shard && shard.projQ, `${locale} shard must export a projQ namespace`)
      assert.equal(typeof shard.projQ[key], 'string', `${locale} shard missing projQ.${key}`)
      assert.ok(shard.projQ[key].length > 0, `${locale} shard value for projQ.${key} must be non-empty`)
    }
  }
})

test('the filter chip map covers all + the four statuses, and both shards define every key', () => {
  assert.deepEqual(Object.keys(STATUS_FILTER_I18N_KEYS).sort(), ['active', 'all', 'cancelled', 'done', 'paused'].sort())
  for (const f of ['all', ...PROJECT_STATUSES]) {
    const key = STATUS_FILTER_I18N_KEYS[f].slice('projQ.'.length)
    for (const [locale, shard] of [['zh-CN', zhShard], ['en-US', enShard]]) {
      assert.equal(typeof shard.projQ[key], 'string', `${locale} shard missing projQ.${key}`)
    }
  }
})

test('zh-CN and en-US projQ shards have identical key sets (filter chips and tooltips included)', () => {
  assert.ok(Object.keys(zhShard.projQ).length >= 9, 'at least 4 statuses + 5 filter chips expected')
  assert.deepEqual(Object.keys(zhShard.projQ).sort(), Object.keys(enShard.projQ).sort())
})
