/* maint/d25 W1+W2 — executing regression for zero-width-name bypass and empty tag rename:
 *   W1: String.trim() does not strip zero-width chars (U+200B/200C/200D/FEFF), so a category
 *       named '\u200B' sailed through every empty-name defense. All four layers now share
 *       src/main/blankish-name.cjs isBlankishName:
 *       1. upsertCategory choke point refuses a zero-width-only INSERT;
 *       2. restoreCategoriesFromCriticalBackup drops zero-width-named backup rows;
 *       3. check-data-hygiene flags zero-width-named rows already in the DB;
 *       4. category cleanup-empty (dry-run) lists them as junk.
 *   W2: `tag rename <old> ""` used to rewrite '#old' → '# ' fragments into task text;
 *       an empty/whitespace new name now strips the tag cleanly (same as tag rm).
 * ZWSP rows are planted via raw sqlite (the choke point itself now refuses them).
 * Run: node --test tests/unit/main/d25-blankish-name.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'module'
import { isolatedTmpDir } from '../../lib/tmp-dir.mjs'

delete process.env.TODO_BACKUP_DIR
delete process.env.TODO_USER_DATA_DIR
process.env.TODO_DB_DIR = isolatedTmpDir('todo-d25-blankish-')
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const dbRecovery = require_('../../../src/main/dbRecovery.cjs')
const lib = require_('../../../cli/lib.js')
const { isBlankishName } = require_('../../../src/main/blankish-name.cjs')
const hygiene = require_('../../../cli/check-data-hygiene.cjs')
const APP_ROOT = path.resolve(import.meta.dirname, '../../..')

db.init(process.env.TODO_DB_DIR)

const Database = require_(path.join(APP_ROOT, 'vendor', 'better-sqlite3-multiple-ciphers'))
function seedRawCategory (name, over = {}) {
  const dir = process.env.TODO_DB_DIR
  const raw = new Database(path.join(dir, 'todos.db'))
  const keyFile = path.join(dir, 'db.key')
  if (fs.existsSync(keyFile)) {
    const key = fs.readFileSync(keyFile, 'utf8').trim()
    if (/^[0-9a-fA-F]{64}$/.test(key)) raw.pragma(`key='${key}'`)
  }
  const now = Date.now() + (over.seq || 0)
  const id = over.id || (now * 1000 + 7)
  raw.prepare('INSERT INTO categories (id,userId,name,color,createdAt,sort,isFolder,parentId,deleted,deletedAt,updatedAt) VALUES (?,?,?,?,?,?,0,0,0,0,?)')
    .run(id, 840001, name, null, now, 0, now)
  raw.close()
  return id
}

const catRow = id => db.call('categoriesAllRows').find(c => String(c.id) === String(id))

/* ---------- isBlankishName itself ---------- */
test('isBlankishName: zero-width chars and BOM count as blank; real names do not', () => {
  assert.equal(isBlankishName(''), true)
  assert.equal(isBlankishName('   '), true)
  assert.equal(isBlankishName('\u200B'), true, 'ZWSP')
  assert.equal(isBlankishName('\u200C\u200D'), true, 'ZWNJ+ZWJ')
  assert.equal(isBlankishName('\uFEFF'), true, 'BOM')
  assert.equal(isBlankishName(' \u200B\t'), true, 'mixed whitespace+ZWSP')
  assert.equal(isBlankishName('\u200Bwork\u200B'), false, 'name with embedded ZWSP is a real name')
  assert.equal(isBlankishName(null), true)
  assert.equal(isBlankishName(undefined), true)
  assert.equal(isBlankishName(0), false, 'String(0)="0" is a (weird but non-blank) name')
})

/* ---------- layer 1: choke point ---------- */
test('W1 layer 1: upsertCategory refuses a zero-width-only INSERT', () => {
  const ok = db.call('upsertCategory', { id: 900101, userId: 840001, name: '\u200B', color: '#123456', createdAt: 1, sort: 1, isFolder: 0, parentId: 0, deleted: 0 })
  assert.equal(ok, false)
  assert.equal(catRow(900101), undefined, 'no row written')
})

/* ---------- layer 2: recovery restore drop ---------- */
test('W1 layer 2: restoreCategoriesFromCriticalBackup drops zero-width-named rows', () => {
  const kept = []
  const n = dbRecovery.restoreCategoriesFromCriticalBackup(
    { backup: { categoryState: { schemaV: 1, list: [
      { categoryId: 900201, categoryName: '\u200B', categoryColor: '#123456', createTime: 1, listSort: 1 },
      { categoryId: 900202, categoryName: 'Real', categoryColor: '#0f9d8f', createTime: 2, listSort: 2 }
    ] } } },
    (row) => { kept.push(row) }
  )
  assert.equal(n, 1, 'only the real-named row is written')
  assert.equal(kept.length, 1)
  assert.equal(kept[0].name, 'Real')
})

/* ---------- layer 3: hygiene scanner ---------- */
test('W1 layer 3: check-data-hygiene flags a zero-width-named row planted in the DB', () => {
  const zwId = seedRawCategory('\u200B', { id: 900301 })
  const cats = db.call('categoriesAllRows').map(r => ({ categoryId: r.id, categoryName: r.name, createTime: r.createdAt }))
  const liveTasks = [] // dangling-ref scan needs live rows; none relevant here — pass [] like d24 pins do
  const findings = hygiene.collectFindings(cats, liveTasks)
  const hit = findings.find(f => f.check === 'empty-category-name' && f.detail.includes(String(zwId)))
  assert.ok(hit, 'ZWSP row id ' + zwId + ' flagged as empty-category-name, got: ' + JSON.stringify(findings))
})

/* ---------- layer 4: cleanup-empty dry-run ---------- */
test('W1 layer 4: category cleanup-empty dry-run lists a zero-width-named row as junk', () => {
  const backupDir = isolatedTmpDir('todo-d25-blankish-bak-')
  const zwId = seedRawCategory('\u200B\uFEFF', { id: 900401 })
  lib.addCategory('Keeper')
  const r = runCli(['category', 'cleanup-empty'], process.env.TODO_DB_DIR, backupDir)
  assert.equal(r.code, 0)
  assert.match(r.out, new RegExp(String(zwId)), 'dry-run output names the ZWSP junk id')
})

function runCli (args, dbDir, backupDir) {
  try {
    return { code: 0, out: execFileSync(process.execPath, ['cli/pickdone.js', ...args], { cwd: APP_ROOT, env: { ...process.env, TODO_DB_DIR: dbDir, TODO_BACKUP_DIR: backupDir || '' }, encoding: 'utf8' }) }
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') }
  }
}

/* ---------- W2: empty tag rename strips cleanly ---------- */
test('W2: tag rename <old> " " (whitespace new name) strips the tag instead of leaking a bare "# " fragment', () => {
  const t = lib.addTodo({ content: 'ship the thing #urgent today' })
  const backupDir = isolatedTmpDir('todo-d25-blankish-tags-bak-')
  const r = runCli(['tag', 'rename', 'urgent', ' '], process.env.TODO_DB_DIR, backupDir)
  assert.equal(r.code, 0, r.out)
  const after = lib.getTask(t.taskId)
  assert.equal(after.taskContent.includes('#'), false, 'no # fragment left: ' + JSON.stringify(after.taskContent))
  assert.equal(after.taskContent, 'ship the thing today', 'text collapses cleanly')
  assert.equal(lib.listTags().some(x => x.name === 'urgent'), false, 'tag gone from the list')
})

test('W2: tag rename with a real new name still works after the guard change', () => {
  const t = lib.addTodo({ content: 'review #pr notes' })
  const r = runCli(['tag', 'rename', 'pr', 'review-passed'], process.env.TODO_DB_DIR, '')
  assert.equal(r.code, 0)
  assert.equal(lib.getTask(t.taskId).taskContent, 'review #review-passed notes')
})

/* ---------- W2 guard: whitespace-only old name is a usage error ---------- */
test('W2: tag rename "  " x is refused as USAGE, not a silent no-op', () => {
  const r = runCli(['tag', 'rename', '  ', 'x'], process.env.TODO_DB_DIR, '')
  assert.notEqual(r.code, 0)
})
