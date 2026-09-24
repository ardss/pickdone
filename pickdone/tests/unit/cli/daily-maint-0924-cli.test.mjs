/**
 * Daily maintenance 2026-09-24 — CLI-domain consistency fixes.
 * B2 (P1): CLI sort direction vs App display (moveWithin display-order contract + cross-end
 * assertion) · B8 FilterView taskSort descending · B10 appLocale manifest enum · B11 blob-only
 * manifest family · B12 overview today caliber counts pure-todoTime rows · B14 importEvents
 * estimate clamp surfaced · B15 settingsSet blob write-back whitelist.
 * Run: node --test tests/unit/cli/daily-maint-0924-cli.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'
import { fileURLToPath } from 'node:url'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-daily-0924-cli-'))
const here = path.dirname(fileURLToPath(import.meta.url))
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')
const { SETTINGS_MANIFEST } = require_('../../../shared/settings-manifest.mjs')
const { sortByMode } = await import('../../../renderer/js/utils/sortMode.js')
const { moveWithin } = await import('../../../shared/sort-core.mjs')
db.init(process.env.TODO_DB_DIR)

/** Raw write into the encrypted db (vendor driver) — for row shapes only inbound sync can produce. */
function rawSql (sql) {
  const Database = require_('../../../vendor/better-sqlite3-multiple-ciphers')
  const key = fs.readFileSync(path.join(process.env.TODO_DB_DIR, 'db.key'), 'utf8').trim()
  const d = new Database(path.join(process.env.TODO_DB_DIR, 'todos.db'))
  d.pragma(`key='${key}'`)
  d.prepare('SELECT count(*) FROM sqlite_master').get() // decrypt probe
  d.prepare(sql).run()
  d.close()
}

/* ---------- B2: CLI sort direction matches the App's display order (P1 cross-end inversion) ---------- */

test('B2: sort top puts the task FIRST under the App\'s descending custom-mode read (cross-end)', () => {
  const a = lib.addTodo({ content: 'b2-alpha' })
  const b = lib.addTodo({ content: 'b2-beta' })
  const c = lib.addTodo({ content: 'b2-gamma' })
  // The App renders custom mode by taskSort DESCENDING (sortMode.js sortByMode) — read the CLI's
  // persisted rows through the App's own comparator:
  const appView = () => sortByMode(lib.liveTasks().filter(t => t.dayStart === lib.open().call('getById', c.taskId).dayStart), 'custom').map(t => t.taskContent)
  lib.sortTask(a.taskId, 'top')
  assert.equal(appView()[0], 'b2-alpha', 'CLI `sort top` must land the task first in the APP\'s display order (was min-100 = visually last before B2)')
  lib.sortTask(a.taskId, 'bottom')
  assert.equal(appView()[appView().length - 1], 'b2-alpha', 'CLI `sort bottom` must land the task last in the APP\'s display order')
  // dayOrder report must now BE the App display order (was ascending taskSort = upside-down)
  const dayOrder = lib.sortTask(b.taskId, 'top').dayOrder.map(s => s.replace('★', ''))
  assert.deepEqual(dayOrder, appView(), 'sortTask dayOrder === App display order')
  assert.equal(dayOrder[0], 'b2-beta')
  // up/down/before/after edges still behave in display terms
  assert.throws(() => lib.sortTask(b.taskId, 'up'), /ALREADY_AT_EDGE|top/, 'up from the display top errors')
  const mid = moveWithin([300, 200, 100], 0, 'down')
  assert.equal(mid.sort, Math.fround((200 + 100) / 2), 'midpoint lands between the display neighbors (descending sorts)')
  void a; void b; void c
})

/* ---------- B8: FilterView list reads taskSort descending, same as the whole App ---------- */

test('B8: FilterView.vue sorts its filtered list by taskSort DESCENDING', () => {
  const src = fs.readFileSync(path.join(here, '..', '..', '..', 'renderer', 'js', 'views', 'FilterView.vue'), 'utf8')
  assert.ok(/\.sort\(\(a, b\) => \(b\.taskSort \|\| 0\) - \(a\.taskSort \|\| 0\)\)/.test(src), 'FilterView computed sort must be descending (b - a), matching sortMode.js custom mode')
  assert.ok(!/\.sort\(\(a, b\) => \(a\.taskSort \|\| 0\) - \(b\.taskSort \|\| 0\)\)/.test(src), 'the old ascending comparator must be gone')
})

/* ---------- B10: appLocale is an enum, not a free string ---------- */

test('B10: appLocale manifest entry is the zh-CN|en-US enum and the CLI rejects other locales', () => {
  assert.deepEqual(SETTINGS_MANIFEST.enum.appLocale, ['zh-CN', 'en-US'])
  assert.ok(!SETTINGS_MANIFEST.string.includes('appLocale'), 'appLocale must not remain in the string family (a key lives in exactly one family)')
  assert.throws(() => lib.settingsSet('appLocale', 'fr-FR'), /expects one of/, 'a locale the main process would silently normalize away must be rejected at the CLI')
  lib.settingsSet('appLocale', 'en-US') // legal value still writes
})

/* ---------- B11: blob-only synced maps are registered, not silently missing ---------- */

test('B11: repeatDefaultSettings/onboardingToursSeen are declared blobOnly in the manifest', () => {
  assert.deepEqual(SETTINGS_MANIFEST.blobOnly, ['repeatDefaultSettings', 'onboardingToursSeen'])
  // and they must NOT be CLI-settable primitives
  assert.equal(lib.settingsKnown('repeatDefaultSettings'), null)
  assert.equal(lib.settingsKnown('onboardingToursSeen'), null)
})

/* ---------- B12: overview today counts pure-todoTime (dayStart=0) rows like metrics.js ---------- */

test('B12: overview today.total/done include dayStart=0 tasks whose todoTime is today', () => {
  const dayjs = require_('dayjs')
  const today15 = +dayjs().hour(15).minute(0).second(0).millisecond(0)
  const t = lib.addTodo({ content: 'b12-pure-todotime', date: dayjs(today15).format('YYYY-MM-DD HH:mm') })
  // Simulate the peer-sync row shape: scheduledAt (todoTime) set, scheduledDay (dayStart) 0 — the
  // write path always derives one from the other, only inbound sync can produce this combination.
  rawSql(`UPDATE todos SET scheduledDay = 0 WHERE id = '${t.taskId}'`)
  const ov = lib.overview()
  assert.equal(ov.today.total, 1, 'the pure-todoTime row must count toward today.total (metrics.js: ds = dayStart || startOfDay(todoTime))')
  assert.equal(ov.today.done, 0)
  lib.toggleComplete(t.taskId, true)
  assert.equal(lib.overview().today.done, 1)
})

/* ---------- B14: importEvents surfaces the estimate clamp instead of swallowing it ---------- */

test('B14: estimate>20 events import with a clamped count and progress note, not silence', async () => {
  const dayjs = require_('dayjs')
  const future = dayjs().add(3, 'day').format('YYYY-MM-DD')
  const notes = []
  const r = await lib.importEvents([
    { date: future, start: '09:00', end: '10:00', title: 'b14-over', estimate: 35 },
    { date: future, start: '11:00', end: '12:00', title: 'b14-ok', estimate: 3 }
  ], { onProgress: n => notes.push(n) })
  assert.equal(r.clamped, 1, 'return value carries the clamped count')
  assert.equal(r.created, 2)
  const clampedNote = notes.find(n => n.status === 'estimate-clamped')
  assert.ok(clampedNote && clampedNote.wanted === 35 && clampedNote.stored === 20, 'the clamp is reported with wanted/stored values')
  void r
})

/* ---------- B15: settingsSet blob write-back is a whitelist rebuild ---------- */

test('B15: dirty blob keys are stripped on the next settingsSet write-back; legit keys survive', () => {
  // a renamed-away setting and a foreign key ride in the blob (historical/sync pollution)
  db.call('setMeta', ['db.settingsState', JSON.stringify({
    schemaV: 1, weatherCity: 'x', oldRenamedKey: 1, foreignJunk: { a: 1 },
    repeatDefaultSettings: { r1: { mode: 'work' } }, onboardingToursSeen: { tour1: 1 },
    shortcutKeySettings: { capture: 'F9' }, foldedTodoList: true
  })])
  lib.settingsSet('weatherCity', 'Shanghai')
  const blob = JSON.parse(db.call('getMeta', 'db.settingsState'))
  assert.equal(blob.weatherCity, 'Shanghai')
  assert.ok(!('oldRenamedKey' in blob) && !('foreignJunk' in blob), 'dirty keys must not survive the write-back (the blob can finally slim down)')
  assert.equal(blob.schemaV, 1, 'schemaV kept')
  assert.ok(typeof blob._savedAt === 'number', '_savedAt kept')
  assert.deepEqual(blob.repeatDefaultSettings, { r1: { mode: 'work' } }, 'B11 blob-only map survives the whitelist')
  assert.deepEqual(blob.onboardingToursSeen, { tour1: 1 })
  assert.deepEqual(blob.shortcutKeySettings, { capture: 'F9' }, 'local-only DEFAULT_SETTINGS keys survive')
  assert.equal(blob.foldedTodoList, true)
})
