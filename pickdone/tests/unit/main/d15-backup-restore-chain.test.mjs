/**
 * D15 domain-4 (backup/restore chain) regression — B3, B4, B5, B6.
 *
 * B3: the placeholder-tag registry `userTags` (ui.js setUserTags) was absent from the metaState
 *     collector and both restore whitelists — a disaster restore lost every sidebar tag.
 * B4: project documents `projectDocs:<catId>` (ProjectDocs.vue) were absent from the collector,
 *     both restore whitelists and the catProjectMetaBak roundtrip — restore lost all docs.
 * B5: `projectDocs:<id>` had no computeMetaGc branch — purged categories leaked their rows forever.
 * B6: `catFiltersBak.<id>` was immortal — the renderer now stamps the deletion time into the key
 *     (`catFiltersBak.<deletedAt>.<id>`) so the GC can bound retention to the recover window.
 *
 * Also pins the meta-surface trio (collector / SettingsDataTab whitelist / dbRecovery whitelist)
 * in lockstep: the class root cause is that meta keys get added to some lists and not others.
 *
 * Run: node --test tests/unit/main/d15-backup-restore-chain.test.mjs
 * Isolation: pure node --test; window.todoAPI stubbed, no Electron; temp dirs via
 * TODO_USER_DATA_DIR/TODO_DB_DIR only (never %APPDATA%).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

process.env.TODO_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pickdone-d15-brc-'))
process.env.TODO_DB_DIR = path.join(process.env.TODO_USER_DATA_DIR, 'db')

const require = createRequire(import.meta.url)
const todoBackup = await import('../../../renderer/js/store/helpers/todoBackup.js')
const dbRecovery = require('../../../src/main/dbRecovery.cjs')
const { computeMetaGc } = require('../../../src/main/handlers/shared.js')

const STATE = {
  todoList: [],
  recycleList: [],
  category: { list: [{ categoryId: 'c1' }] }
}

test('B3/B4 collector: metaStateKeys gathers userTags and projectDocs:<id>', () => {
  const keys = todoBackup.metaStateKeys(STATE, STATE)
  assert.ok(keys.includes('userTags'), 'placeholder-tag registry must be backed up')
  assert.ok(keys.includes('projectDocs:c1'), 'project documents must be backed up')
  assert.ok(keys.includes('projectCategoryIds'), 'existing surface still present')
})

test('B4 collector: deleted categories do not resurrect their projectDocs key', () => {
  const emptyCats = { ...STATE, category: { list: [] } }
  const keys = todoBackup.metaStateKeys(emptyCats, emptyCats)
  assert.ok(!keys.includes('projectDocs:c1'), 'derive-from-live still holds for the docs family')
})

test('B3/B4 main restore path: restoreMetaEntriesFromCriticalBackup accepts userTags + projectDocs entries', () => {
  const puts = []
  const n = dbRecovery.restoreMetaEntriesFromCriticalBackup({
    backup: { metaState: JSON.stringify({ schemaV: 1, entries: [
      { key: 'userTags', value: '["urgent"]' },
      { key: 'projectDocs:c1', value: '[{"id":"d1"}]' }
    ] }) }
  }, pair => puts.push(pair))
  assert.equal(n, 2, 'both entries restored through the meta door')
  assert.deepEqual(puts.map(p => p[0]).sort(), ['projectDocs:c1', 'userTags'])
})

test('dbRecovery exports META_RESTORE_PREFIXES and it covers the collector output', () => {
  const wl = dbRecovery.META_RESTORE_PREFIXES
  assert.ok(Array.isArray(wl))
  for (const k of todoBackup.metaStateKeys(STATE, STATE)) {
    assert.ok(wl.some(p => k.startsWith(p)), `collector key ${k} must be restorable on the startup path`)
  }
})

test('drift guard: the SettingsDataTab whitelist carries the same families as dbRecovery', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const src = fs.readFileSync(path.join(here, '..', '..', '..', 'renderer', 'js', 'components', 'settings', 'SettingsDataTab.vue'), 'utf8')
  for (const p of dbRecovery.META_RESTORE_PREFIXES) {
    assert.ok(src.includes("'" + p + "'"), `UI restore whitelist is missing '${p}' — the three meta-surface lists must move in lockstep`)
  }
})

test('B5 GC: projectDocs:<deadId> is collected, the live id is kept', () => {
  const dead = computeMetaGc(['projectDocs:900', 'projectDocs:c1'], [{ id: 'c1' }], [])
  assert.ok(dead.includes('projectDocs:900'), 'purged category documents leak no more')
  assert.ok(!dead.includes('projectDocs:c1'))
})

test('B6 GC: stamped catFiltersBak keys expire past the recover window; fresh keys and live-id leftovers follow the window', () => {
  const now = Date.now()
  const fresh = 'catFiltersBak.' + (now - 2 * 86400000) + '.77'
  const stale = 'catFiltersBak.' + (now - 40 * 86400000) + '.88'
  const dead = computeMetaGc([fresh, stale, 'catFiltersBak.77', 'catFiltersBak.88'], [{ id: '77' }], [], { now })
  assert.ok(dead.includes(stale), '40-day-old backup is beyond the 30-day recover window')
  assert.ok(!dead.includes(fresh), 'fresh backup must stay recoverable')
  assert.ok(dead.includes('catFiltersBak.77'), 'unstamped leftover for a LIVE (recovered/re-created) id is a stale orphan')
  assert.ok(!dead.includes('catFiltersBak.88'), 'unstamped legacy key with unknown age is conservatively kept (mirrors the no-stamp tombstone rule)')
})

test('B6 GC: default invocation (no opts) bounds stamped keys at the same 30-day fallback', () => {
  const stale = 'catFiltersBak.' + (Date.now() - 40 * 86400000) + '.99'
  const dead = computeMetaGc([stale], [], [])
  assert.ok(dead.includes(stale), 'index.js calls computeMetaGc without opts — the default must still bound retention')
})
