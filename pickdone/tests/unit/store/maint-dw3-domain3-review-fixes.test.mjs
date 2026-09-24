/* maint/dw wave3 domain-3 REVIEW fixes (adversarial re-check round):
 * [R1] todo/deleteTodosMany must be in index.js's WRITE_ACTIONS (echo-suppression stamp) while
 *      staying OUT of HISTORY_ACTIONS (no double snapshot push). Full-store behavioral test: after
 *      a batch delete, _lastLocalWriteAt advanced (the action's own broadcast echo is suppressed
 *      → the undo stack survives) AND exactly one undo step exists AND that one undo restores the
 *      whole batch. Membership anchor pins the set split so a future refactor can't re-split them.
 * [R2] settings SETTING_RANGES is the SHARED manifest table (shared/settings-manifest.mjs), not a
 *      second inline copy: identity check + a manifest-only key (dailyLoadWarnThreshold) clamps.
 * Run: node --test tests/unit/store/maint-dw3-domain3-review-fixes.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')
let importSeq = 0
const importSrc = p => import(pathToFileURL(path.join(ROOT, p)).href + '?fresh=' + (++importSeq))

test('R1: deleteTodosMany stamps the echo-suppression window and stays ONE undo step that restores the whole batch', async () => {
  // fresh LS + real vuex, full store with the real subscribeAction hooks
  const mem = new Map()
  globalThis.localStorage = {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: k => mem.delete(k)
  }
  globalThis.window.todoAPI = {
    ...(globalThis.window.todoAPI || {}),
    dbCall: () => Promise.resolve(null), // every write op acks; rows stay in memory
    writeCriticalStateBackup: () => Promise.resolve()
  }
  globalThis.window.Vuex = await import('vuex')
  const { default: store } = await importSrc('renderer/js/store/index.js')

  const mk = id => ({ taskId: id, taskContent: 't-' + id, delete: false, dayStart: 0, todoTime: 0, updateTime: 1, status: 'update', version: 1 })
  store.state.todo.todoList.splice(0, store.state.todo.todoList.length, mk('a'), mk('b'), mk('c'))

  const stampBefore = store.state.todo._lastLocalWriteAt || 0
  const removed = await store.dispatch('todo/deleteTodosMany', [mk('a'), mk('b')])
  assert.deepEqual(removed, ['a', 'b'])

  // echo suppression: the action's DB write is stamped so its own broadcast echo (external-db-write
  // → todo/init without preserveHistory → historyClear) falls inside the 1500ms window
  const stampAfter = store.state.todo._lastLocalWriteAt || 0
  assert.ok(stampAfter > stampBefore && stampAfter > 0,
    'WRITE_ACTIONS after-hook must stamp _lastLocalWriteAt for deleteTodosMany (echo suppression)')

  // ONE undo step, and it restores the whole batch (soft-deleted rows live in recycleList until undo)
  const all = () => [...store.state.todo.todoList, ...store.state.todo.recycleList]
  assert.equal(store.state.todo.undoStack.length, 1, 'exactly one undo step for the batch')
  assert.equal(all().find(t => t.taskId === 'a').delete, true)
  await store.dispatch('todo/undo')
  assert.equal(all().find(t => t.taskId === 'a').delete, false, 'one undo restores row a')
  assert.equal(all().find(t => t.taskId === 'b').delete, false, 'one undo restores row b')
  assert.equal(all().find(t => t.taskId === 'c').delete, false, 'untouched row stays live')
})

test('R1 anchor: deleteTodosMany is in WRITE_ACTIONS but NOT in HISTORY_ACTIONS (no double snapshot)', () => {
  const src = read('renderer/js/store/index.js')
  // slice the array LITERALS only (the comment between the two consts names both sets)
  const hist = src.slice(src.indexOf('const HISTORY_ACTIONS'), src.indexOf('])'))
  const write = src.slice(src.indexOf('const WRITE_ACTIONS'), src.indexOf('])', src.indexOf('const WRITE_ACTIONS')))
  assert.ok(hist.includes("'todo/deleteTodo'"), 'single delete stays in the snapshot-push set')
  assert.ok(!hist.includes('deleteTodosMany'), 'the batch action must NOT be in HISTORY_ACTIONS (in-action push would double)')
  assert.ok(write.includes("'todo/deleteTodosMany'"), 'the batch action MUST be in WRITE_ACTIONS (echo stamp)')
})

test('R2: SETTING_RANGES is the shared manifest table (single source), manifest-only keys clamp too', async () => {
  const { SETTING_RANGES, clampNumericSettings, sanitizeSettingsPatch } = await importSrc('renderer/js/store/settings.js')
  // same URL as the settings.js import (no ?fresh divergence) so identity is meaningful
  const { SETTINGS_MANIFEST } = await import(pathToFileURL(path.join(ROOT, 'shared/settings-manifest.mjs')).href)
  assert.equal(SETTING_RANGES, SETTINGS_MANIFEST.ranges, 'no second inline copy — same object identity')
  // a key only present in the manifest table clamps through the same path
  assert.equal(clampNumericSettings({ dailyLoadWarnThreshold: 99 }).dailyLoadWarnThreshold, 50)
  assert.equal(sanitizeSettingsPatch({ todoDescriptionDisplayLineNumber: 99 }).todoDescriptionDisplayLineNumber, 6)
})

test('R2b: the habits-family field set (shared/settings-families.mjs) can never enter DEFAULT_SETTINGS', async () => {
  // F-C2 review residue: the whitelist is the enforcement; this pins it to the SHARED family
  // contract — if domain2 ever renames/adds family fields, a re-entry into DEFAULT_SETTINGS
  // (which would let initFromDb adopt them again) fails here instead of drifting silently.
  const { DEFAULT_SETTINGS } = await importSrc('renderer/js/store/settings.js')
  const { HABITS_EXCLUSIVE_FIELDS, HABITS_BLOB_FIELDS } = await import(pathToFileURL(path.join(ROOT, 'shared/settings-families.mjs')).href)
  for (const k of HABITS_EXCLUSIVE_FIELDS) {
    assert.ok(!(k in DEFAULT_SETTINGS), `habits-exclusive family field '${k}' must stay out of DEFAULT_SETTINGS`)
  }
  for (const k of HABITS_BLOB_FIELDS) {
    if (k === 'schemaV') continue // legal on BOTH blobs by contract, transported outside the patch loop
    assert.ok(!(k in DEFAULT_SETTINGS), `habits-blob field '${k}' must stay out of DEFAULT_SETTINGS`)
  }
})

test('R3 anchor: the external-echo q watcher cancels the pending debounce (no redundant same-value commit)', () => {
  const src = read('renderer/js/views/SearchView.vue')
  const watch = src.slice(src.indexOf('watch: {'), src.indexOf('computed: {'))
  const qWatch = watch.slice(watch.indexOf('q (v)'), watch.indexOf('qText (v)'))
  assert.ok(qWatch.includes('clearTimeout(this._qTimer)'), 'echoing an external search change must cancel the pending debounce (setSearch has no equality guard)')
})
