/**
 * Fix wave E (review R5) tests:
 *  1. P1-1 — release version gate accepts prerelease (0.4.0-beta.15) in BOTH release scripts:
 *     shared pure validator (scripts/release-version.mjs) unit-covered, plus a source anchor
 *     asserting release.mjs / release-finalize.mjs actually route their argv gate through it
 *     (the scripts execute top-level side effects, so we do not import them here).
 *  2. P1-3 — CLI deleteCategory cascades saved filters (parity with renderer
 *     category.js purgeFiltersForVictims): filters whose conds.catId references a cascade
 *     victim are tombstoned, backed up in catFiltersBak.<id>, and counted in the result.
 * Isolated temp DB via TODO_DB_DIR, never touches real data (tests/unit/cli/cli-r5 pattern).
 * Run: node --test tests/unit/wave-e-fixes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'
import { fileURLToPath } from 'node:url'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-wave-e-'))
const require_ = createRequire(import.meta.url)
const db = require_('../../src/main/db.js')
const lib = require_('../../cli/lib.js')

db.init(process.env.TODO_DB_DIR)

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')

// ---------- P1-1: prerelease version acceptance ----------
test('wave-e P1-1: isReleaseVersion accepts X.Y.Z and X.Y.Z-prerelease', async () => {
  const { isReleaseVersion, RELEASE_VERSION_RE } = await import('../../scripts/release-version.mjs')
  for (const good of ['0.4.0', '0.4.0-beta.15', '1.2.3-rc.1', '10.20.30-alpha-beta.0']) {
    assert.ok(isReleaseVersion(good), `should accept ${good}`)
    assert.match(good, RELEASE_VERSION_RE)
  }
  for (const bad of ['', '0.4', '0.4.0-', 'v0.4.0', '0.4.0-beta.15+build.7', '0.4.0-beta.15 ', null, undefined, 0.4]) {
    assert.ok(!isReleaseVersion(bad), `should reject ${String(bad)}`)
  }
})

test('wave-e P1-1: both release scripts gate argv through the shared validator', async () => {
  for (const f of ['scripts/release.mjs', 'scripts/release-finalize.mjs']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
    assert.match(src, /release-version\.mjs/, `${f} imports the shared validator`)
    assert.doesNotMatch(src, /\^\\d\+\\\./, `${f} no longer inlines the strict X.Y.Z-only regex`)
    assert.match(src, /isReleaseVersion\(version\)/, `${f} validates argv with isReleaseVersion`)
  }
})

// ---------- P1-3: deleteCategory cascades saved filters ----------
test('wave-e P1-3: deleteCategory tombstones victim filters, backs them up, reports the count', () => {
  const folder = lib.addCategory('wave-e-folder', { folder: true })
  const child = lib.addCategory('wave-e-child', { parent: folder.categoryId })
  const live = lib.addCategory('wave-e-live')
  // Two doomed filters (one per cascade victim) + one survivor with a different catId
  db.call('filterUpsert', { name: 'doomed-folder', conds: { catId: folder.categoryId }, sort: 1 })
  db.call('filterUpsert', { name: 'doomed-child', conds: { catId: child.categoryId }, sort: 2 })
  db.call('filterUpsert', { name: 'survivor', conds: { catId: live.categoryId }, sort: 3 })

  const r = lib.deleteCategory(String(folder.categoryId))
  assert.equal(r.removedFilters, 2, 'both cascade-referencing filters removed')
  assert.deepEqual(r.deleted.map(v => v.name).sort(), ['wave-e-child', 'wave-e-folder'])

  const liveFilters = db.call('filterList').map(f => f.name)
  assert.ok(liveFilters.includes('survivor'), 'unrelated filter survives')
  assert.ok(!liveFilters.includes('doomed-folder') && !liveFilters.includes('doomed-child'), 'doomed filters are tombstoned')

  const bak = JSON.parse(db.call('getMeta', 'catFiltersBak.' + folder.categoryId) || '[]')
  assert.equal(bak.length, 2, 'recover backup holds both doomed filters')
  assert.deepEqual(bak.map(f => f.name).sort(), ['doomed-child', 'doomed-folder'])
  for (const f of bak) assert.ok(f.id && f.name && f.conds, 'backup entries keep id/name/conds')
})

test('wave-e P1-3: deleting a category with no filters reports removedFilters = 0 and writes no backup', () => {
  const c = lib.addCategory('wave-e-nofilters')
  const r = lib.deleteCategory(String(c.categoryId))
  assert.equal(r.removedFilters, 0)
  assert.equal(db.call('getMeta', 'catFiltersBak.' + c.categoryId) || '', '', 'no backup blob when nothing was cascaded')
})
