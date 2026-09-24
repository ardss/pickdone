/**
 * CLI deleteCategory → saved-filters cascade tests (originating from fix wave E / review R5; renamed
 *  2026-09-24 from wave-e-fixes.test.mjs to a domain name and grouped under cli/):
 *  P1-3 — CLI deleteCategory cascades saved filters (parity with renderer
 *     category.js purgeFiltersForVictims): filters whose conds.catId references a cascade
 *     victim are tombstoned, backed up in catFiltersBak.<id>, and counted in the result.
 * Isolated temp DB via TODO_DB_DIR, never touches real data (tests/unit/cli/cli-r5 pattern).
 *  (The wave-e release-script half lives in tests/unit/release-version-gate.test.mjs.)
 * Run: node --test tests/unit/cli/deletecategory-filter-cascade.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-catfilter-cascade-'))
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')

db.init(process.env.TODO_DB_DIR)

// ---------- P1-3: deleteCategory cascades saved filters ----------
test('deleteCategory tombstones victim filters, backs them up, reports the count', () => {
  const folder = lib.addCategory('catfilter-folder', { folder: true })
  const child = lib.addCategory('catfilter-child', { parent: folder.categoryId })
  const live = lib.addCategory('catfilter-live')
  // Two doomed filters (one per cascade victim) + one survivor with a different catId
  db.call('filterUpsert', { name: 'doomed-folder', conds: { catId: folder.categoryId }, sort: 1 })
  db.call('filterUpsert', { name: 'doomed-child', conds: { catId: child.categoryId }, sort: 2 })
  db.call('filterUpsert', { name: 'survivor', conds: { catId: live.categoryId }, sort: 3 })

  const r = lib.deleteCategory(String(folder.categoryId))
  assert.equal(r.removedFilters, 2, 'both cascade-referencing filters removed')
  assert.deepEqual(r.deleted.map(v => v.name).sort(), ['catfilter-child', 'catfilter-folder'])

  const liveFilters = db.call('filterList').map(f => f.name)
  assert.ok(liveFilters.includes('survivor'), 'unrelated filter survives')
  assert.ok(!liveFilters.includes('doomed-folder') && !liveFilters.includes('doomed-child'), 'doomed filters are tombstoned')

  const bak = JSON.parse(db.call('getMeta', 'catFiltersBak.' + folder.categoryId) || '[]')
  assert.equal(bak.length, 2, 'recover backup holds both doomed filters')
  assert.deepEqual(bak.map(f => f.name).sort(), ['doomed-child', 'doomed-folder'])
  for (const f of bak) assert.ok(f.id && f.name && f.conds, 'backup entries keep id/name/conds')
})

test('deleting a category with no filters reports removedFilters = 0 and writes no backup', () => {
  const c = lib.addCategory('catfilter-nofilters')
  const r = lib.deleteCategory(String(c.categoryId))
  assert.equal(r.removedFilters, 0)
  assert.equal(db.call('getMeta', 'catFiltersBak.' + c.categoryId) || '', '', 'no backup blob when nothing was cascaded')
})
