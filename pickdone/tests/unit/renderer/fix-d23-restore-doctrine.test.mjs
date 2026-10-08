/**
 * maint/d23 FIX-3a — restore-doctrine parity (P2 #1 + P3 #4), source-pinned on
 * SettingsDataTab.vue.
 *
 * #1: the UI backup-restore used to stamp recycle-bin tombstones with updateTime:now —
 *     violating the Sync-14 doctrine implemented by the startup recovery path
 *     (src/main/dbRecovery.cjs restoreTodoRowsFromCriticalBackup): a restored tombstone
 *     keeps its backup deletedAt and gets updateTime:1 so a peer that re-created the task
 *     after the backup wins LWW. Fresh-stamped tombstones made UI restores win LWW and
 *     flip peer-side restorations back to deleted (cross-device data loss).
 * #4: applyEvtPurgeDump now demotes dangling repeatIds on restored live rows (B5 parity
 *     with store/todo.js restoreFromRecycle) and invalidates the memoized tomato estimate
 *     cache when estimate keys were restored (parity with restoreMetaState).
 * Run: node --test tests/unit/renderer/fix-d23-restore-doctrine.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

test('[Sync-14] restoreStampRow maps live rows fresh and tombstones to the dbRecovery shape', () => {
  const src = read('renderer/js/components/settings/SettingsDataTab.vue')
  const i = src.indexOf('function restoreStampRow')
  assert.ok(i > -1, 'restoreStampRow exists')
  const body = src.slice(i, i + 900)
  // live row → status:'update' + fresh updateTime (restore-wins, unchanged doctrine)
  assert.match(body, /status: 'update', updateTime: now \|\| Date\.now\(\)/,
    'live rows keep the fresh-stamp restore-wins semantics')
  // tombstone → the Sync-14 mapping (parity with src/main/dbRecovery.cjs:467-472)
  assert.match(body, /delete: 1, deletedAt: row\.deletedAt \|\| 1, updateTime: 1/,
    'tombstones keep backup deletedAt (epoch-oldest 1 when absent) with updateTime:1')
  assert.match(body, /row\.delete \|\| row\.deleted/,
    'the deleted test covers both legacy tombstone flag spellings')
})

test('[Sync-14] the todoState restore path stamps tombstones through restoreStampRow', () => {
  const src = read('renderer/js/components/settings/SettingsDataTab.vue')
  // both todoList and recycleList rows go through the shared mapper
  assert.match(src, /\(td\.todoList \|\| \[\]\)\.forEach\(r => rows\.push\(restoreStampRow\(r\)\)\)/)
  assert.match(src, /\(td\.recycleList \|\| \[\]\)\.forEach\(r => rows\.push\(restoreStampRow\(r\)\)\)/)
})

test('[Sync-14] evt-purge restore stamps purged rows through the same doctrine', () => {
  const src = read('renderer/js/components/settings/SettingsDataTab.vue')
  assert.match(src, /restoreStampRow\(\{ \.\.\.r, delete: true, deletedAt: r\.deletedAt \|\| Date\.now\(\) \}\)/,
    'purgedRows tombstone through restoreStampRow → updateTime:1, not a fresh stamp')
})

test('[B5 parity] applyEvtPurgeDump demotes dangling repeatIds on restored live rows', () => {
  const src = read('renderer/js/components/settings/SettingsDataTab.vue')
  const i = src.indexOf('async applyEvtPurgeDump (b, failed) {')
  assert.ok(i > -1, 'applyEvtPurgeDump exists')
  const body = src.slice(i, i + 3600)
  assert.match(body, /repeatRule:' \+ rid/,
    'the rule meta is looked up per distinct repeatId')
  assert.match(body, /repeatId: null/,
    'rows with an absent rule meta are demoted to non-repeating (no fabricated rule)')
  assert.match(body, /failed\.push\('repeatIdDemoted x' \+ dangling\.size\)/,
    'the demotion count is folded into the restore report')
})

test('[estimate cache] applyEvtPurgeDump invalidates the memoized estimate cache on restore', () => {
  const src = read('renderer/js/components/settings/SettingsDataTab.vue')
  const i = src.indexOf('async applyEvtPurgeDump (b, failed) {')
  const body = src.slice(i, i + 2200)
  assert.match(body, /tomatoEstimateState:/, 'estimate keys are tracked after the meta re-put')
  assert.match(body, /invalidateEstimateCache\(\)/,
    'invalidateEstimateCache runs after the re-put (parity with restoreMetaState)')
})
