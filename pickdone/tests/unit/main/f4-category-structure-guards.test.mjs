/* F4 fix #1 (2026-10-17) — the CLI's three category structure guards sank to the DB write
 * bottleneck (src/main/db-category-ops.js upsertCategory, shared/category-structure.mjs):
 *   CATEGORY_CYCLE / CATEGORY_NOT_FOLDER / CATEGORY_NESTED_FOLDER / CATEGORY_NOT_FOUND.
 * Previously ONLY the CLI validated structure, so the sync channel / renderer / any other
 * upsertCategory caller could land a nested folder, a parent pointing at a non-folder or a
 * tombstoned row, or a parent/child cycle.
 * Violations refuse the write as a house no-op (return false, no row, no oplog delta) and record
 * the structured error on exports.lastCategoryGuardError; tombstones are exempt.
 * Run: node --test tests/unit/main/f4-category-structure-guards.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'f4-catstruct-')) // log-isolation
process.env.TODO_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'f4-catstruct-ud-'))
const db = require_('../../../src/main/db.js')
const catOps = require_('../../../src/main/db-category-ops.js')
const { validateCategoryStructure } = require_('../../../shared/category-structure.mjs')

db.init(fs.mkdtempSync(path.join(os.tmpdir(), 'f4-catstruct-db-')))

const row = over => Object.assign({
  id: 0, userId: 840001, name: 'Cat', color: '#0f9d8f', createdAt: 1700000000000,
  sort: 1, isFolder: 0, parentId: 0, deleted: 0
}, over)

const nextId = (() => { let n = 700001; return () => ++n })()

function live (over) { const id = nextId(); assert.equal(db.call('upsertCategory', row({ id, ...over })), true); return id }

test('parent = live folder lands (happy path unchanged)', () => {
  const folder = live({ name: 'F4Folder', isFolder: 1 })
  const child = nextId()
  assert.equal(catOps.lastCategoryGuardError, null)
  assert.equal(db.call('upsertCategory', row({ id: child, name: 'Child', parentId: folder })), true)
  assert.equal(catOps.lastCategoryGuardError, null, 'a legal write must not leave a stale guard error')
  assert.ok(db.call('getAllCategories').some(c => c.categoryId === child && c.folderId === folder))
})

test('parent = non-folder → CATEGORY_NOT_FOLDER, write refused', () => {
  const flat = live({ name: 'F4Flat' })
  const before = db.call('syncOplogSince', { sinceSeq: 0 }).length
  const child = nextId()
  assert.equal(db.call('upsertCategory', row({ id: child, name: 'UnderFlat', parentId: flat })), false,
    'red before the fix: the child under a non-folder parent landed verbatim')
  assert.equal(catOps.lastCategoryGuardError && catOps.lastCategoryGuardError.code, 'CATEGORY_NOT_FOLDER')
  assert.equal(db.call('getAllCategories').some(c => c.categoryId === child), false, 'no row written')
  assert.equal(db.call('syncOplogSince', { sinceSeq: 0 }).length, before, 'no oplog delta for the refused write')
})

test('parent = tombstoned row → CATEGORY_NOT_FOUND, write refused', () => {
  const doomed = live({ name: 'F4Doomed' })
  assert.equal(db.call('upsertCategory', row({ id: doomed, name: 'F4Doomed', deleted: 1 })), true)
  const child = nextId()
  assert.equal(db.call('upsertCategory', row({ id: child, name: 'UnderTomb', parentId: doomed })), false,
    'red before the fix: a child under a tombstoned parent landed (dangling reference)')
  assert.equal(catOps.lastCategoryGuardError && catOps.lastCategoryGuardError.code, 'CATEGORY_NOT_FOUND')
  assert.equal(db.call('getAllCategories').some(c => c.categoryId === child), false)
})

test('folder with a parent → CATEGORY_NESTED_FOLDER, write refused', () => {
  const folder = live({ name: 'F4Folder2', isFolder: 1 })
  const nested = nextId()
  assert.equal(db.call('upsertCategory', row({ id: nested, name: 'NestedFolder', isFolder: 1, parentId: folder })), false,
    'red before the fix: a nested folder landed and was silently dropped from the sidebar')
  assert.equal(catOps.lastCategoryGuardError && catOps.lastCategoryGuardError.code, 'CATEGORY_NESTED_FOLDER')
})

test('direct and transitive cycles → CATEGORY_CYCLE, rows unchanged', () => {
  const f = live({ name: 'F4F', isFolder: 1 })
  const a = live({ name: 'F4A', parentId: f }) // a under f (legal)
  const g = live({ name: 'F4G', parentId: f }) // g under f too
  const fBefore = db.call('getAllCategories').find(c => c.categoryId === f)
  // self-parent
  assert.equal(db.call('upsertCategory', row({ id: a, name: 'F4A', parentId: a })), false)
  assert.equal(catOps.lastCategoryGuardError && catOps.lastCategoryGuardError.code, 'CATEGORY_CYCLE')
  // transitive: f under its own descendant a closes f → a → f
  assert.equal(db.call('upsertCategory', row({ id: f, name: 'F4F', isFolder: 1, parentId: a })), false,
    'red before the fix: f was already a descendant of a, so f under a closes a cycle')
  assert.equal(catOps.lastCategoryGuardError && catOps.lastCategoryGuardError.code, 'CATEGORY_CYCLE')
  const fAfter = db.call('getAllCategories').find(c => c.categoryId === f)
  assert.equal(fAfter.folderId, fBefore.folderId, 'the refused move leaves the row unchanged')
  assert.ok(db.call('getAllCategories').some(c => c.categoryId === g), 'sibling row untouched')
})

test('tombstones are exempt from the guards (inbound tombstones must still land)', () => {
  const flat = live({ name: 'F4Flat2' })
  const tombId = nextId()
  assert.equal(db.call('upsertCategory', row({ id: tombId, name: 'Tomb', isFolder: 1, parentId: flat, deleted: 1 })), true,
    'a tombstone carrying stale structure must land (sync parity, F2)')
})

test('missing parent row (no row at all) is allowed — sync snapshot ordering leniency; the orphan row stays invisible', () => {
  const child = nextId()
  assert.equal(db.call('upsertCategory', row({ id: child, name: 'F4Orphan', parentId: 999999999 })), true,
    'a first-sync snapshot may buffer a child before its folder — no row yet is NOT a refusal')
  assert.ok(db.call('getAllCategories').some(c => c.categoryId === child))
  // DESIGN PIN (unchanged by F4): the orphan child (parentId → nothing) is invisible —
  // renderer hierarchical renders only roots (!folderId) and children of live folders.
  // Remounting orphans is a separate design item, out of scope this round.
})

test('shared core contract: validateCategoryStructure returns null or {code,message}', () => {
  const rows = { 1: { id: 1, isFolder: true, deleted: false, parentId: 0 }, 2: { id: 2, isFolder: false, deleted: false, parentId: 1 } }
  const find = id => rows[id] || null
  assert.equal(validateCategoryStructure({ id: 3, isFolder: false, parentId: 1 }, find), null)
  assert.equal(validateCategoryStructure({ id: 3, isFolder: false, parentId: 0 }, find), null)
  assert.equal(validateCategoryStructure({ id: 3, isFolder: false, parentId: 2 }, find).code, 'CATEGORY_NOT_FOLDER')
  assert.equal(validateCategoryStructure({ id: 2, isFolder: true, parentId: 1 }, find).code, 'CATEGORY_NESTED_FOLDER')
  assert.equal(validateCategoryStructure({ id: 1, isFolder: false, parentId: 1 }, find).code, 'CATEGORY_CYCLE')
  assert.equal(validateCategoryStructure({ id: 1, isFolder: false, parentId: 2 }, find).code, 'CATEGORY_CYCLE', 'child-of-own-child closes a cycle')
  assert.equal(validateCategoryStructure({ id: 3, isFolder: false, parentId: 9 }, find), null, 'missing parent = leniency')
})
