/* Empty-category choke point (2026-10-08) — executing regression over the REAL db:
 *   1. upsertCategory refuses an INSERT whose trimmed name is empty (no row written, false).
 *   2. An UPDATE carrying an empty/whitespace name never blanks an existing non-empty name.
 *   3. A patch with color=''/createdAt=0 preserves the existing row's values.
 *   4. Inbound sync TOMBSTONES with stripped fields still land (name guard gated on !deleted).
 *   5. restoreCategoriesFromCriticalBackup skips nameless backup rows (P2 pollution root cause).
 *   6. import resolveCat rejects a whitespace/zero-width-only list name LOUDLY.
 *   7. Source pin: audit writer skips category.upsert lines for no-op (result === false) ops
 *      (appendEntry is not exported and the resolver drops entries outside Electron — a
 *      functional test would need an app shell, so the guard itself is pinned).
 * Run: node --test tests/unit/main/cat-chokepoint.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'module'
import { isolatedTmpDir } from '../../lib/tmp-dir.mjs'

process.env.TODO_DB_DIR = isolatedTmpDir('todo-cat-chokepoint-')
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const dbRecovery = require_('../../../src/main/dbRecovery.cjs')
const { importItems } = require_('../../../src/main/import/index.js')

db.init(process.env.TODO_DB_DIR)

// categoriesAllRows returns RAW table rows (id/name/color/...), not the rowToCategory mapper shape
const catRow = id => db.call('categoriesAllRows').find(c => String(c.id) === String(id))

test('upsertCategory: empty-name INSERT is refused (no row, returns false)', () => {
  const ok = db.call('upsertCategory', { id: 900001, userId: 840001, name: '   ', color: '#123456', createdAt: 123, sort: 1, isFolder: 0, parentId: 0, deleted: 0 })
  assert.equal(ok, false, 'no-op convention: refused insert returns false')
  assert.equal(catRow(900001), undefined, 'no row was written')
})

test('upsertCategory: empty-name UPDATE keeps the existing name', () => {
  db.call('upsertCategory', { id: 900002, userId: 840001, name: 'Work', color: '#0f9d8f', createdAt: 500, sort: 1, isFolder: 0, parentId: 0, deleted: 0 })
  db.call('upsertCategory', { id: 900002, userId: 840001, name: '   ', color: '#0f9d8f', createdAt: 500, sort: 1, isFolder: 0, parentId: 0, deleted: 0, updatedAt: 999 })
  const r = catRow(900002)
  assert.equal(r.name, 'Work', 'degraded writer cannot blank a live name')
  assert.equal(r.createdAt, 500, 'existing createdAt also preserved (upsert semantics)')
})

test('upsertCategory: patch with empty color / zero createdAt preserves existing values', () => {
  db.call('upsertCategory', { id: 900003, userId: 840001, name: 'Home', color: '#7E57C2', createdAt: 777, sort: 1, isFolder: 0, parentId: 0, deleted: 0 })
  db.call('upsertCategory', { id: 900003, userId: 840001, name: 'Home', color: '', createdAt: 0, sort: 2, isFolder: 0, parentId: 0, deleted: 0, updatedAt: 1000 })
  const r = catRow(900003)
  assert.equal(r.color, '#7E57C2', 'color preserved')
  assert.equal(r.createdAt, 777, 'createdAt preserved')
  assert.equal(r.sort, 2, 'unrelated fields still update')
})

test('upsertCategory: tombstone row with stripped name still lands', () => {
  const ok = db.call('upsertCategory', { id: 900004, userId: 840001, name: '', color: '', createdAt: 0, sort: 0, isFolder: 0, parentId: 0, deleted: 1, deletedAt: 42 })
  assert.equal(ok, true, 'tombstone insert accepted despite empty name')
  const r = catRow(900004)
  assert.ok(r && r.deleted === 1 && r.deletedAt === 42, 'tombstone landed with its stamp')
})

test('restoreCategoriesFromCriticalBackup: nameless backup rows are dropped, counted, and not written', () => {
  const raw = { backup: { categoryState: JSON.stringify({ schemaV: 1, list: [
    { categoryId: 900101, categoryName: null, userId: 840001, deleted: 0 },
    { categoryId: 900102, categoryName: '   ', userId: 840001, deleted: 0 },
    { categoryId: 900103, categoryName: 'Valid Cat', userId: 840001, deleted: 0 },
    { categoryId: 900104, categoryName: 'Tomb', userId: 840001, deleted: 1 }
  ] }) } }
  const written = []
  const n = dbRecovery.restoreCategoriesFromCriticalBackup(raw, c => { written.push(c); return true })
  assert.equal(n, 2, 'only the two named rows restored')
  assert.ok(written.every(c => String(c.name).trim() !== ''), 'no nameless row reached upsertCategory')
  assert.equal(catRow(900101), undefined)
})

test('import resolveCat: whitespace/zero-width-only list name throws a coded ImportError', () => {
  // NOTE: importItems lazy-requires cli/lib as its write facade; when the parallel cli/** work
  // tree is mid-refactor this suite can fail to load the facade — the choke-point assertions
  // above are independent. The executing import tests live at the bottom of this file.
  const src = readFileSync(new URL('../../../src/main/import/index.js', import.meta.url), 'utf8')
  assert.match(src, /IMPORT_CAT_NAME_EMPTY/)
  assert.match(src, /u200B/)
})

test('source pin: audit writer skips category.upsert no-op lines (result === false)', () => {
  const src = readFileSync(new URL('../../../src/main/audit.js', import.meta.url), 'utf8')
  assert.match(src, /if \(op === 'upsertCategory' && result === false\) return/)
})

/* ==== P2 2026-10-08 import resolveCat guard (defense in depth behind the choke point):
 * importItems' resolveCat must reject a list name empty after trim (whitespace/zero-width
 * stripped) with a coded ImportError — the choke point would only silently no-op it, and the
 * import would still report success. Executing against the real importItems. ==== */


test('resolveCat: whitespace/zero-width-only list name throws IMPORT_CAT_NAME_EMPTY', () => {
  const items = [{ title: 'task under junk list', list: ' \u200B\u200D ' }]
  assert.throws(
    () => importItems(items, { format: 'todoist', dryRun: false }),
    e => e.code === 'IMPORT_CAT_NAME_EMPTY'
  )
})

test('resolveCat: a padded-but-real list name still creates its category (trimmed)', () => {
  const items = [{ title: 'task under padded list', list: '  Errands  ' }]
  const report = importItems(items, { format: 'todoist', dryRun: false })
  assert.equal(report.imported, 1)
  assert.deepEqual(report.categoriesCreated, ['Errands'])
  const cat = db.call('getAllCategories').find(c => c.categoryName === 'Errands')
  assert.ok(cat, 'category landed with the trimmed name')
})
