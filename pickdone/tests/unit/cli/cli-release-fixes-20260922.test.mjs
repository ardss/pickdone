/** cli-release domain fixes (2026-09-22, fix/dw-cli-release) — regression pins:
 *  1. Release tooling version gate accepts prerelease (X.Y.Z-beta.N) via the shared
 *     scripts/version-format.mjs — the strict X.Y.Z regex in release.mjs/release-finalize.mjs
 *     had the beta channel fully blocked (package.json was 0.4.0-beta.15 and no input passed).
 *  2. site-jsonld patchJsonLd emits a QUOTED dateModified string — the old inline replace wrote
 *     the raw JS expression text into the page, making the JSON-LD block unparseable.
 *  3. CSV import on an empty DB uses lib.guessUserId() (840001), not the divergent local
 *     fallback 0 — same bug shape guessUserId already fixed on the addTodo path.
 *  4. lib.compareVersions orders prereleases per semver: 0.4.0 > 0.4.0-beta.15 (the update
 *     command's old NaN comparator kept beta users permanently "up to date").
 *  5. Non-todo command results (settings set / plan set) print their own fields instead of the
 *     todo template's "✓ [ ]  undefined" + "taskId: undefined".
 *  Isolated temp DB via TODO_DB_DIR, never touches real data (unit-cli pattern).
 *  Run: node --test tests/unit/cli/cli-release-fixes-20260922.test.mjs */
import { test } from 'node:test'
import path from 'node:path'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'module'
import { fileURLToPath } from 'node:url'
import { isolatedTmpDir } from '../../lib/tmp-dir.mjs'

process.env.TODO_DB_DIR = isolatedTmpDir('todo-cli-release-')
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')
const importer = require_('../../../cli/import.js')
const core = require_('../../../src/main/core/todo-core.js')
const { VERSION_RE } = await import('../../../scripts/version-format.mjs')
const { patchJsonLd } = await import('../../../scripts/site-jsonld.mjs')

db.init(process.env.TODO_DB_DIR)

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const cliPath = path.join(ROOT, 'cli', 'pickdone.js')
const runCliRaw = args => execFileSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' })

let _seq = 0
function seed (over = {}) {
  const now = Date.now() + (_seq++)
  const t = {
    complete: false, createTime: now, delete: false,
    reminderTime: 0, reminderOffsets: [], reminderExtra: [], estimate: 0, difficulty: 0,
    repeatId: null, subtasks: null, image: null, files: null,
    categoryId: 0, updateTime: now, syncTime: 0,
    taskContent: '任务', taskDescribe: '',
    taskSort: 0, todoTime: 0, userId: 1, status: 'add', version: 0, ...over
  }
  if (!t.taskId) t.taskId = core.genTaskId(t.userId, now)
  db.call('upsert', t)
  return db.call('getById', t.taskId)
}

test('release-1: VERSION_RE accepts prerelease and still rejects malformed versions', () => {
  assert.equal(VERSION_RE.test('0.4.0'), true)
  assert.equal(VERSION_RE.test('0.4.0-beta.15'), true)
  assert.equal(VERSION_RE.test('0.4.0-rc.1'), true)
  assert.equal(VERSION_RE.test('1.0.0-beta.1'), true)
  assert.equal(VERSION_RE.test('v0.4.0'), false, 'tag prefix must be rejected — the scripts add it themselves')
  assert.equal(VERSION_RE.test(''), false)
  assert.equal(VERSION_RE.test('0.4'), false)
  assert.equal(VERSION_RE.test('0.4.0-'), false)
  assert.equal(VERSION_RE.test('beta'), false)
})

test('release-2: patchJsonLd produces parseable JSON-LD with quoted dateModified', () => {
  const html = '<script type="application/ld+json">{"@context":"https://schema.org","softwareVersion": "0.4.0-beta.15","dateModified": "2026-08-01"}</script>'
  const out = patchJsonLd(html, '0.4.0-beta.16', '2026-09-22')
  const jsonText = out.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]
  const parsed = JSON.parse(jsonText) // must not throw — the old output had a bare JS expression here
  assert.equal(parsed.softwareVersion, '0.4.0-beta.16')
  assert.equal(parsed.dateModified, '2026-09-22')
  assert.ok(!jsonText.includes('new Date'), 'no unevaluated JS expression may leak into the document')
})

test('release-3a: importItems on an EMPTY DB creates rows under userId 840001 (not 0)', () => {
  const items = [{ list: 'Inbox', title: '空库导入甲', notes: '', tags: [], due: 0, reminder: 0, priority: 0, done: false, completedAt: 0, subs: [] }]
  const r = importer.importItems(items, { format: 'ticktick' })
  assert.equal(r.imported, 1)
  const row = db.call('queryTodos', { deleted: 0 }).find(t => t.taskContent.includes('空库导入甲'))
  assert.ok(row, 'task row exists')
  assert.equal(row.userId, 840001)
})

test('release-3b: importItems on a POPULATED DB inherits an existing row\'s userId (never 0)', () => {
  seed({ taskContent: '导入属主锚点', userId: 777 })
  const items = [{ list: 'Inbox', title: '有库导入乙', notes: '', tags: [], due: 0, reminder: 0, priority: 0, done: false, completedAt: 0, subs: [] }]
  importer.importItems(items, { format: 'ticktick' })
  const known = new Set(db.call('queryTodos', { deleted: 0 }).map(t => t.userId))
  const row = db.call('queryTodos', { deleted: 0 }).find(t => t.taskContent.includes('有库导入乙'))
  assert.ok(known.has(row.userId), `imported userId ${row.userId} must come from an existing row`)
  assert.notEqual(row.userId, 0)
})

test('release-4: compareVersions implements semver ordering incl. prereleases', () => {
  const { compareVersions: cmp } = lib
  assert.equal(cmp('v0.4.0', '0.4.0-beta.15'), 1, 'release outranks its own prerelease — the update check showed "up to date" here')
  assert.equal(cmp('0.4.0-beta.15', 'v0.4.0'), -1)
  assert.equal(cmp('0.4.0-beta.15', '0.4.0-beta.16'), -1)
  assert.equal(cmp('0.4.0-beta.2', '0.4.0-beta.10'), -1, 'numeric identifiers compare as numbers')
  assert.equal(cmp('0.4.0-beta.15', '0.4.0-beta.15'), 0)
  assert.equal(cmp('0.10.0', '0.2.0'), 1, 'numeric core segments, not lexicographic')
  assert.equal(cmp('0.4.1', '0.4.0-beta.99'), 1)
  assert.equal(cmp('0.4.0-beta', '0.4.0-beta.1'), -1, 'fewer identifiers loses')
  assert.equal(cmp('0.4.0-alpha', '0.4.0-beta'), -1, 'lexicographic when both alphanumeric')
  assert.equal(cmp('0.4.0-1', '0.4.0-alpha'), -1, 'numeric < alphanumeric')
})

test('release-5: settings set / plan set print real fields, never "undefined"', () => {
  const t = seed({ taskContent: '输出形态锚点' })
  const outSettings = runCliRaw(['settings', 'set', 'colorMode', 'dark'])
  assert.ok(!outSettings.includes('undefined'), 'settings set output: ' + outSettings)
  assert.ok(outSettings.includes('colorMode') && outSettings.includes('dark'))

  const outPlan = runCliRaw(['plan', 'set', t.taskId, '09:30'])
  assert.ok(!outPlan.includes('undefined'), 'plan set output: ' + outPlan)
  assert.ok(outPlan.includes('09:30') && outPlan.includes('输出形态锚点'))

  const outPlanShortcut = runCliRaw(['plan', t.taskId, '11:00'])
  assert.ok(!outPlanShortcut.includes('undefined'), 'plan shortcut output: ' + outPlanShortcut)

  // JSON mode keeps the raw result shape (unchanged contract)
  const jsonPlan = JSON.parse(runCliRaw(['plan', 'set', t.taskId, '12:00', '--replace', '--json']))
  assert.deepEqual(jsonPlan.data.chips, ['12:00'])
})
