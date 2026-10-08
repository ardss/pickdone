/**
 * maint/d24 FIX-B round — CLI fixes verified by EXECUTING runs against an isolated temp DB:
 *  - P2 tags: `tag rename`/`tag rm` rewrite RECYCLE rows too (the App's SnManageTagsModal.tagTodos
 *    rewrites tombstones; the CLI missed them, so restore-after-rename resurrected the old tag);
 *  - P3 categories: `category add --color` accepts any valid #rrggbb (non-palette warns, invalid
 *    = USAGE) instead of silently falling back to the palette default;
 *  - P3 categories: resolveCategory never matches an empty normalized keyword and tries exact
 *    name first ('work' no longer becomes ambiguous with 'network');
 *  - P3 audit display: summarizeChanges renders categoryId as `cat <id>`, not a date-formatted token;
 *  - P3 focus: a FAILED `tomato start` (App absent) records an audit entry carrying the failure
 *    outcome instead of a silent optimistic entry that read as executed;
 *  - NEW gate: cli/check-data-hygiene.cjs — read-only linter, exit 1 on a planted empty-name
 *    category, exit 0 on a clean DB;
 *  - NEW verb: `category cleanup-empty` — dry-run lists without changing; --yes --repoint moves
 *    tasks, tombstones junk rows and writes a JSON backup.
 * Run: node --test tests/unit/cli/d24-fixb-cli-hygiene.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'module'
import { isolatedTmpDir } from '../../lib/tmp-dir.mjs'

delete process.env.TODO_BACKUP_DIR
delete process.env.TODO_USER_DATA_DIR
process.env.TODO_DB_DIR = isolatedTmpDir('todo-cli-d24fixb-')
const require_ = createRequire(import.meta.url)
const lib = require_('../../../cli/lib.js')
const { summarizeChanges } = require_('../../../cli/cli-format.cjs')
const hygiene = require_('../../../cli/check-data-hygiene.cjs')
const runTomato = require_('../../../cli/lib-tomato.cjs') // exports the async function directly
const APP_ROOT = path.resolve(import.meta.dirname, '../../..')

/* Empty/whitespace-named categories are LEGACY junk: the db layer (maint/d24 P1 choke point) now
 * refuses empty-name INSERTs, so tests plant them through raw sqlite to simulate pre-guard data. */
const Database = require_(path.join(APP_ROOT, 'vendor', 'better-sqlite3-multiple-ciphers'))
let _seq = 0
function seedRawCategory (name, over = {}) {
  const dir = process.env.TODO_DB_DIR
  const raw = new Database(path.join(dir, 'todos.db'))
  const keyFile = path.join(dir, 'db.key') // same key contract as db.js: 64-hex db.key = encrypted DB
  if (fs.existsSync(keyFile)) {
    const key = fs.readFileSync(keyFile, 'utf8').trim()
    if (/^[0-9a-fA-F]{64}$/.test(key)) raw.pragma(`key='${key}'`)
  }
  const now = Date.now() + (_seq++)
  const id = over.id || (now * 1000 + (_seq++))
  raw.prepare('INSERT INTO categories (id,userId,name,color,createdAt,sort,isFolder,parentId,deleted,deletedAt,updatedAt) VALUES (?,?,?,?,?,?,0,0,0,0,?)')
    .run(id, 840001, name, null, over.createTime != null ? over.createTime : now, over.sort || 0, now)
  raw.close()
  return id
}

/* ---------- P2: rewriteTag covers recycle-bin rows ---------- */
test('d24 P2: tag rename rewrites recycled rows; tag rm strips them; the list stays live-only', () => {
  const live = lib.addTodo({ content: 'live task #urgent plan' })
  const doomed = lib.addTodo({ content: 'doomed task #urgent notes' })
  lib.deleteTodo(doomed.taskId) // → recycle bin, keeps #urgent
  const recycled = lib.open().call('queryTodos', { deleted: 1 }).find(t => t.taskId === doomed.taskId)
  assert.ok(recycled && recycled.taskContent.includes('#urgent'), 'setup: recycled row carries the tag')

  const touched = lib.rewriteTag('urgent', 'critical')
  assert.equal(touched, 2, 'red before the fix: only the live row was rewritten')
  const liveAfter = lib.open().call('getById', live.taskId)
  const recAfter = lib.open().call('queryTodos', { deleted: 1 }).find(t => t.taskId === doomed.taskId)
  assert.ok(liveAfter.taskContent.includes('#critical'))
  assert.ok(recAfter.taskContent.includes('#critical'), 'red before the fix: tombstone kept #urgent (restore would resurrect the old tag)')

  // tag rm strips the tag from recycled rows too
  const removed = lib.rewriteTag('critical', null, { remove: true })
  assert.equal(removed, 2)
  const recAfterRm = lib.open().call('queryTodos', { deleted: 1 }).find(t => t.taskId === doomed.taskId)
  assert.ok(!/#critical/.test(recAfterRm.taskContent), 'tag rm strips recycled rows')

  // the tag LIST derivation stays live-only (the deleted task must not add a count)
  const tags = lib.listTags()
  const urgent = tags.find(t => t.name === 'urgent')
  assert.ok(!urgent || urgent.tasks === 1, 'list counts live rows only')
})

/* ---------- P3: --color accepts free hex ---------- */
test('d24 P3: category add --color accepts non-palette hex, warns; invalid hex = USAGE', () => {
  const c1 = lib.addCategory('HexCat', { color: '#aa00aa' })
  assert.equal(c1.categoryColor, '#aa00aa', 'red before the fix: non-palette hex silently fell back to the palette default')
  const c2 = lib.addCategory('PaletteCat', { color: '#0F9D8F' })
  assert.equal(c2.categoryColor, '#0f9d8f', 'palette colors keep working (case-normalized)')
  assert.throws(() => lib.addCategory('BadCat', { color: 'nope' }), e => e.code === 'USAGE', 'red before the fix: invalid value silently became a palette default')
})

/* ---------- P3: resolveCategory empty-key guard + exact-first ---------- */
test('d24 P3: resolveCategory empty keyword = CATEGORY_NOT_FOUND; exact name beats substring', () => {
  lib.addCategory('Work')
  lib.addCategory('Network')
  seedRawCategory('   ') // junk empty-named category (the wild row from the bug report; pre-guard legacy shape)
  assert.throws(() => lib.resolveCategory('　'), e => e.code === 'CATEGORY_NOT_FOUND', 'red before the fix: a whitespace keyword substring-matched the empty-named junk row')
  // ('' itself means "unfiled" by contract — resolveCategory('') === null, not an error)
  const work = lib.open().call('getAllCategories').find(c => c.categoryName === 'Work')
  assert.equal(lib.resolveCategory('Work'), work.categoryId, 'red before the fix: exact "Work" was AMBIGUOUS_MATCH with "Network"')
  assert.throws(() => lib.resolveCategory('wor'), e => e.code === 'AMBIGUOUS_MATCH', 'substring fallback still detects ambiguity')
})

/* ---------- P3: audit display renders categoryId as cat <id> ---------- */
test('d24 P3: summarizeChanges renders categoryId as `cat <id>`, not a date', () => {
  const from = 1759000000000123
  const to = 1759000000999999
  const out = summarizeChanges([{ before: { categoryId: from }, after: { categoryId: to } }])
  assert.match(out, /category: cat 1759000000000123 → cat 1759000000999999/)
  assert.doesNotMatch(out, /\d{2}-\d{2} \d{2}:\d{2}/, 'red before the fix: the big id was date-formatted like a timestamp')
  // other timestamp fields keep the date formatting
  const t = 1759000000000
  const outTs = summarizeChanges([{ before: { todoTime: t }, after: { todoTime: t + 3600000 } }])
  assert.match(outTs, /\d{2}-\d{2} \d{2}:\d{2}/, 'real timestamps still render as dates')
})

/* ---------- P3: failed tomato start carries the outcome in audit ---------- */
function tomatoLib (extra = {}) {
  const recs = []
  const stub = {
    CliError: lib.CliError,
    writeTomatoCmd: (cmd, opt) => (recs.cmds = recs.cmds || []).push({ cmd, opt }) || 42,
    waitForTomatoAck: async () => (extra.ack !== undefined ? extra.ack : null),
    audit: { record: o => recs.push(o) },
    ...(extra.lib || {})
  }
  return { stub, recs }
}
test('d24 P3: tomato start with no App records a FAILED audit outcome and throws APP_NOT_RUNNING', async () => {
  const { stub, recs } = tomatoLib({ ack: null })
  await assert.rejects(() => runTomato({ opts: { _: ['start'], minutes: '25' }, lib: stub }), e => e.code === 'APP_NOT_RUNNING')
  assert.equal(recs.cmds[0].opt && recs.cmds[0].opt.silent, true, 'writeTomatoCmd must defer the audit to the caller (silent)')
  const entry = recs.find(r => r.action === 'tomato.start')
  assert.ok(entry, 'audit entry still recorded')
  assert.match(entry.note, /FAILED/, 'red before the fix: the entry carried no outcome and read as executed')
})
test('d24 P3: tomato start with an expired receipt also records the failure outcome', async () => {
  const { stub, recs } = tomatoLib({ ack: { status: 'expired', error: 'stale command' } })
  await assert.rejects(() => runTomato({ opts: { _: ['start'] }, lib: stub }), e => e.code === 'CMD_EXPIRED')
  const entry = recs.find(r => r.action === 'tomato.start')
  assert.match(entry.note, /FAILED.*(CMD_EXPIRED|expired)/)
})
test('d24 P3: successful tomato start records an acknowledged audit outcome', async () => {
  const { stub, recs } = tomatoLib({ ack: { ok: true, seq: 42 } })
  await runTomato({ opts: { _: ['start'], json: true }, lib: stub, emitNext: () => {}, emit: () => {} })
  const entry = recs.find(r => r.action === 'tomato.start')
  assert.match(entry.note, /acknowledged/)
})

/* ---------- NEW gate: check-data-hygiene ---------- */
test('d24 hygiene: pure finding pass pins the >5 same-millisecond id-cluster threshold', () => {
  const ms = 1759000000000
  const cats = Array.from({ length: 6 }, (_, i) => ({ categoryId: ms * 1000 + i, categoryName: 'c' + i, createTime: Date.now() }))
  const findings = hygiene.collectFindings(cats, [])
  assert.ok(findings.some(f => f.check === 'category-id-cluster' && /6 category ids/.test(f.detail)))
  const five = cats.slice(0, 5)
  assert.ok(!hygiene.collectFindings(five, []).some(f => f.check === 'category-id-cluster'), '5 in one ms is allowed, >5 flags')
})
test('d24 hygiene: gate exits 1 with the planted empty-name category flagged, 0 on a clean DB', () => {
  seedRawCategory('\t\t', { createTime: 0 }) // (a) empty/whitespace name + (c) createTime=0 — planted junk (distinct from the '   ' row the resolveCategory test seeded; ids must stay unique)
  lib.addCategory('Doomed') // tombstoned below → the live task now dangles (e)
  lib.addTodo({ content: 'orphan task', category: 'Doomed' })
  lib.deleteCategory('Doomed') // tombstoned → the live task now dangles (e)
  const run = env => {
    try {
      return { code: 0, out: execFileSync(process.execPath, ['cli/check-data-hygiene.cjs'], { cwd: APP_ROOT, env: { ...process.env, TODO_DB_DIR: env }, encoding: 'utf8' }) }
    } catch (e) {
      return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') }
    }
  }
  const dirty = run(process.env.TODO_DB_DIR)
  assert.equal(dirty.code, 1, 'red before the gate existed: no exit signal')
  assert.match(dirty.out, /empty-category-name/)
  assert.match(dirty.out, /dangling-task-category/)
  const clean = run(isolatedTmpDir('todo-cli-d24fixb-clean-'))
  assert.equal(clean.code, 0, 'a fresh empty DB must scan clean')
  assert.match(clean.out, /OK: data hygiene clean/)
})

/* ---------- NEW verb: category cleanup-empty ---------- */
function runCli (args, dbDir, backupDir) {
  try {
    return { code: 0, out: execFileSync(process.execPath, ['cli/pickdone.js', ...args], { cwd: APP_ROOT, env: { ...process.env, TODO_DB_DIR: dbDir, TODO_BACKUP_DIR: backupDir || '' }, encoding: 'utf8' }) }
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') }
  }
}
test('d24 cleanup-empty: dry-run lists without changing anything', () => {
  const backupDir = isolatedTmpDir('todo-cli-d24fixb-cleanup-bak-')
  const junkId = seedRawCategory('  ') // same configured DB in-process: seed via lib/raw, then run the child against it
  lib.addCategory('KeepCat')
  const t1 = lib.addTodo({ content: 'junk-filed task' })
  lib.commit('todo', 'put', { ...lib.getTask(t1.taskId), categoryId: junkId })
  const r = runCli(['category', 'cleanup-empty'], process.env.TODO_DB_DIR, backupDir)
  assert.equal(r.code, 0)
  assert.match(r.out, new RegExp(String(junkId)))
  assert.match(r.out, /dry run/)
  assert.equal(lib.open().call('getAllCategories').filter(c => c.categoryId === junkId).length, 1, 'dry run must not tombstone')
  assert.equal(lib.open().call('getById', t1.taskId).categoryId, junkId, 'dry run must not re-point')
  assert.equal(fs.existsSync(backupDir) ? fs.readdirSync(backupDir).length : 0, 0, 'dry run writes no backup')
})
test('d24 cleanup-empty: --yes --repoint moves tasks, tombstones junk rows, writes a JSON backup', () => {
  const dir = process.env.TODO_DB_DIR
  const backupDir = isolatedTmpDir('todo-cli-d24fixb-cleanup2-bak-')
  const liveTasks0 = lib.open().call('queryTodos', { deleted: 0 })
  const junk = lib.open().call('getAllCategories').find(c => !String(c.categoryName || '').trim() && liveTasks0.some(t => t.categoryId === c.categoryId))
  const keep = lib.open().call('getAllCategories').find(c => c.categoryName === 'KeepCat')
  const t1 = liveTasks0.find(t => t.categoryId === junk.categoryId)
  const r = runCli(['category', 'cleanup-empty', '--yes', '--repoint', 'KeepCat'], dir, backupDir)
  assert.equal(r.code, 0, r.out)
  assert.equal(lib.open().call('getById', t1.taskId).categoryId, keep.categoryId, 'red before the verb existed: task still filed under the junk row')
  const liveJunk = lib.open().call('getAllCategories').filter(c => c.categoryId === junk.categoryId)
  assert.equal(liveJunk.length, 0, 'junk row tombstoned')
  const backups = fs.readdirSync(backupDir).filter(f => f.startsWith('cat-cleanup-empty-'))
  assert.equal(backups.length, 1, 'pre-run JSON backup written next to the DB (standard backup-dir resolution)')
  const blob = JSON.parse(fs.readFileSync(path.join(backupDir, backups[0]), 'utf8'))
  assert.ok(blob.victims.some(v => String(v.categoryId) === String(junk.categoryId)))
  assert.ok(blob.tasks.some(x => x.taskId === t1.taskId))
})
