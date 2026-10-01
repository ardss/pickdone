/**
 * D13 domain-2 (renderer stores / views / side-nav) regression batch — one test per finding,
 * all red on the pre-fix code:
 *   A1/A2  completed-today tasks appear in exactly one expiry group (builder catTodayDone
 *          bucket + per-view projDone fallbacks excluding today)
 *   A3     category/setProjectStatus awaited action: failure rolls the status back and rethrows
 *   A4     sideNav createTag: a failed userTags meta put reverts the in-memory list + surfaces
 *   A12    saveCatEdit empty-name warning refocuses the zombie inline editor
 *   A13    SnManageTagsModal rename: Esc cancels (blur no longer commits) — source contract
 *   A15    ProjectOverviewView createProject lookup miss surfaces a failure toast — source contract
 *   #7     category.init LS→DB migration commits tombstones with restore:true (updatedAt=1)
 *   #10    unique partial index (recurGroupId, scheduledDay): DB rejects a second live renewal;
 *          migration collapses pre-existing duplicates; renderer addTodo adopts the winner
 *   #11    quit-flush ack waits (bounded) for the critical backup write to settle
 *   #12    dbMirror give-up parks the blob durably; restore consumes the marker and re-mirrors LS
 * Run: node --test tests/unit/renderer/d13-domain2-fixes.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')
const require_ = createRequire(import.meta.url)
const dayjs = require_('dayjs')
const today = +dayjs().startOf('day')
const DAY_MS = 86400000

const mk = (id, over = {}) => ({ taskId: 't' + id, taskSort: 100 - id, createTime: 1000 - id, dayStart: 0, complete: false, ...over })
const settings = { expiredCompletedTodoRange: 7, expiredUncompletedTodoRange: 30 }
const t = (k, p) => k

/* ==================== A1/A2: exactly-one-group for completed-today ==================== */

test('A2 buildExpiryGroups: a task completed TODAY lands in exactly one group (catTodayDone)', async () => {
  const { buildExpiryGroups } = await import('../../../renderer/js/utils/expiryGroups.js')
  const list = [
    mk(1, { dayStart: today, complete: true }),      // the hole: done today
    mk(2, { dayStart: today - 3 * DAY_MS, complete: true }), // expDone (past within R1)
    mk(3, { dayStart: today - 90 * DAY_MS, complete: true }) // beyond R1
  ]
  // CategoryView shape: NO extraGroups — the builder alone must carry today's completion
  const g = buildExpiryGroups({ list, settings, today, t, keys: { expDone: 'k1', expUndo: 'k2', upcoming: 'k3', noDate: 'k4' } })
  const hits = g.filter(gr => gr.todos.some(x => x.taskId === 't1'))
  assert.equal(hits.length, 1, `completed-today appears in exactly one group (got ${hits.length}: ${hits.map(h => h.key)})`)
  assert.equal(hits[0].key, 'catTodayDone')
  // invariant holds across the whole list: every non-future task in exactly one group
  for (const row of list) {
    const n = g.filter(gr => gr.todos.some(x => x.taskId === row.taskId)).length
    assert.ok(n <= 1, `task ${row.taskId} in at most one group (got ${n})`)
  }
})

test('A1/A2 projDone fallbacks exclude today so the fallback never double-counts the today bucket', async () => {
  // CategoryView + ProjectView pass a today-excluding fallback filter; assert the source keeps it
  const catSrc = read('renderer/js/views/CategoryView.vue')
  const projSrc = read('renderer/js/views/ProjectView.vue')
  for (const [name, src] of [['CategoryView', catSrc], ['ProjectView', projSrc]]) {
    assert.match(src, /filter: t => t\.complete && t\.dayStart !== this\.todayTs/,
      `${name}'s projDone fallback must exclude today's completions (they own the catTodayDone bucket)`)
  }
  const { buildExpiryGroups } = await import('../../../renderer/js/utils/expiryGroups.js')
  const list = [mk(1, { dayStart: today, complete: true }), mk(9, { dayStart: today - 90 * DAY_MS, complete: true })]
  const g = buildExpiryGroups({
    list, settings, today, t,
    keys: { expDone: 'k1', expUndo: 'k2', upcoming: 'k3', noDate: 'k4' },
    extraGroups: [{ key: 'projDone', titleKey: 'done', filter: x => x.complete && x.dayStart !== today, props: { showDate: true } }]
  })
  const hits = g.filter(gr => gr.todos.some(x => x.taskId === 't1'))
  assert.equal(hits.length, 1)
  assert.equal(hits[0].key, 'catTodayDone')
  assert.ok(g.some(gr => gr.key === 'projDone' && gr.todos.some(x => x.taskId === 't9')), 'beyond-window completion still lands in the fallback')
})

test('A1 TagView carries the tagTodayDone bucket (source contract: bucket + collapse default)', () => {
  const src = read('renderer/js/views/TagView.vue')
  assert.match(src, /tagTodayDone/, 'TagView groups() must include the completed-today bucket')
  assert.match(src, /t => t\.complete && t\.dayStart === today/, 'bucket filter matches completed-today')
  assert.match(src, /tagTodayDone: true/, 'collapsed by default like the other done buckets')
})

/* ==================== A3: awaited setProjectStatus action ==================== */

test('A3 setProjectStatus action awaits the meta put; a failure rolls the status back and rethrows', async () => {
  const cat = (await import('../../../renderer/js/store/category.js')).default
  let failPut = true
  const puts = []
  globalThis.window.todoAPI = {
    dbCall (op, params) {
      if (op === 'setMeta') { puts.push(params); return failPut ? Promise.reject(new Error('disk full')) : Promise.resolve('ok') }
      return Promise.resolve(null)
    }
  }
  const state = { list: [], projectIds: [7], projectMeta: { 7: { status: 'active' } } }
  const ctx = {
    state,
    commit (m, p) { cat.mutations[m](state, p) }
  }
  await assert.rejects(
    cat.actions.setProjectStatus.call(ctx, ctx, { id: 7, status: 'done' }),
    /disk full/,
    'the rejection propagates so the caller can toast an error instead of success'
  )
  assert.equal(cat.getters.projectStatus(state)(7), 'active', 'in-memory status rolled back to the previous value')
  // success path: put lands, memory keeps the new status
  failPut = false
  await cat.actions.setProjectStatus.call(ctx, ctx, { id: 7, status: 'paused' })
  assert.equal(cat.getters.projectStatus(state)(7), 'paused')
  assert.equal(puts.length, 2)
})

test('A3 views no longer commit the removed mutation (they dispatch the awaited action)', () => {
  for (const f of ['renderer/js/views/ProjectOverviewView.vue', 'renderer/js/views/ProjectView.vue']) {
    const src = read(f)
    assert.doesNotMatch(src, /commit\('category\/setProjectStatus'/, `${f} must not use the memory-only mutation directly`)
    assert.match(src, /dispatch\('category\/setProjectStatus'/, `${f} goes through the awaited action`)
  }
  assert.match(read('renderer/js/views/ProjectOverviewView.vue'), /statusChangeFailed/, 'failure path toasts an error, not success')
})

/* ==================== A4: createTag persist failure ==================== */

test('A4 createTag: a rejected userTags put reverts the in-memory list and surfaces the failure', async () => {
  const handlers = await import('../../../renderer/js/components/side-nav/sideNavHandlers.js')
  const commits = []
  const errors = []
  const state = { ui: { userTags: ['keep'] } }
  const vm = {
    $prompt: async () => ({ value: ' #newtag ' }),
    $t: k => k,
    tags: [],
    $message: { error: m => errors.push(m), warning: m => errors.push(m) },
    $store: {
      state,
      commit (m, p) { commits.push(m); if (m === 'ui/setUserTags') state.ui.userTags = p }
    }
  }
  globalThis.window.todoAPI = { dbCall: () => Promise.reject(new Error('db locked')) }
  await handlers.createTag(vm)
  assert.deepEqual(state.ui.userTags, ['keep'], 'in-memory userTags rolled back on the failed put (pre-fix: kept, silently lost on restart)')
  assert.equal(commits.filter(m => m === 'ui/setUserTags').length, 2, 'revert commit issued')
  assert.ok(errors.some(m => String(m).includes('statsG.SideNav.syncFailMsg')), 'failure surfaced, not swallowed')
})

/* ==================== A12: zombie rename editor refocus ==================== */

test('A12 saveCatEdit: empty-name warning re-focuses the inline editor', async () => {
  const handlers = await import('../../../renderer/js/components/side-nav/sideNavHandlers.js')
  let focused = 0
  const state = { list: [{ categoryId: 5, categoryName: 'Old' }] }
  const vm = {
    catEditing: 5,
    newCatName: '   ',
    $t: k => k,
    $message: { warning: () => {} },
    $el: { querySelector: sel => sel === '.sn-cat-edit' ? { focus: () => { focused++ } } : null },
    $nextTick: fn => { fn(); return Promise.resolve() },
    $store: {
      state,
      commit (m, p) {
        if (m === 'category/updateCategory') { const i = state.list.find(c => c.categoryId === p.categoryId); if (i) Object.assign(i, p) }
      }
    }
  }
  handlers.saveCatEdit(vm, state.list[0])
  assert.equal(focused, 1, 'the editor input is re-focused after the warning (pre-fix: zombie unfocused input)')
  assert.equal(vm.catEditing, 5, 'still editing so the user can retype')
  // valid name still commits and closes
  vm.newCatName = 'Renamed'
  handlers.saveCatEdit(vm, state.list[0])
  assert.equal(vm.catEditing, null)
  assert.equal(state.list[0].categoryName, 'Renamed')
})

/* ==================== A13: Esc cancels the tag rename (blur must not commit) ==================== */

test('A13 SnManageTagsModal: Esc-cancel handler + editing guard keep blur from committing a cancelled rename', () => {
  const src = read('renderer/js/components/side-nav/SnManageTagsModal.vue')
  assert.match(src, /@keydown\.esc\.prevent="cancelTagEdit\(t\)"/, 'Esc-cancel channel on the rename input')
  assert.match(src, /cancelTagEdit \(t\) \{/, 'cancel handler restores the original name and closes the editor')
  assert.match(src, /if \(this\.tagMgrEditing !== t\.name\) return/, 'renameTag refuses to run once the editor is closed (blur after Esc/Enter)')
})

/* ==================== A15: createProject lookup miss surfaces a toast ==================== */

test('A15 createProject: the created-lookup miss path shows a failure message instead of silent return', () => {
  const src = read('renderer/js/views/ProjectOverviewView.vue')
  assert.doesNotMatch(src, /if \(!created\) return\s*\n\s*\}/, 'bare silent return is gone')
  assert.match(src, /createFailed/, 'the miss path toasts a failure')
})

/* ==================== #7: LS→DB migration carries restore:true for tombstones ==================== */

test('#7 category.init migration: LS-cached tombstones commit with the epoch-oldest stamp (updatedAt=1)', async () => {
  const cat = (await import('../../../renderer/js/store/category.js')).default
  const ops = []
  globalThis.window.todoAPI = {
    dbCall (op, params) {
      ops.push([op, params])
      if (op === 'getAllCategories') return Promise.resolve([])
      return Promise.resolve(null) // getMeta: nothing migrated yet, no project flags
    }
  }
  const state = { list: [], projectIds: [], projectMeta: {} }
  const ctx = {
    state,
    rootState: { settings: { recycleBinAutoDeleteDays: 30 } },
    commit (m, p) { if (cat.mutations[m]) cat.mutations[m](state, p) },
    dispatch () { return Promise.resolve() }
  }
  const oldTombstone = { categoryId: 777, userId: 840001, categoryName: 'Gone', categoryColor: '#000', createTime: 1, listSort: 1, folderIs: false, folderId: 0, delete: true, deletedAt: today - 10 * DAY_MS }
  globalThis.localStorage.setItem('categoryState', JSON.stringify({ list: [oldTombstone] }))
  await cat.actions.init.call({ state, dispatch: ctx.dispatch }, ctx)
  const put = ops.find(o => o[0] === 'upsertCategory' && o[1] && o[1].id === 777)
  assert.ok(put, 'the migration committed the LS tombstone')
  assert.equal(put[1].updatedAt, 1, `restored tombstone carries the epoch-oldest stamp (got ${put[1].updatedAt}; pre-fix was undefined → upsert stamped now and the tombstone won LWW against a peer's recovered category)`)
  // live rows keep the now-stamp behavior (restore:true only re-stamps tombstones)
  globalThis.localStorage.setItem('categoryState', JSON.stringify({ list: [{ categoryId: 555, userId: 840001, categoryName: 'Live', categoryColor: '#123', createTime: 1, listSort: 1, folderIs: false, folderId: 0, delete: false }] }))
  ops.length = 0
  await cat.actions.init.call({ state, dispatch: ctx.dispatch }, ctx)
  const live = ops.find(o => o[0] === 'upsertCategory' && o[1] && o[1].id === 555)
  assert.ok(live, 'live row committed')
  assert.ok(live[1].updatedAt === undefined, 'live rows still take the db-layer now-stamp (backup wins locally)')
})

/* ==================== #10: unique partial index closes the renewal race ==================== */

test('#10 DB: a second live renewal for the same (recurGroupId, scheduledDay) is rejected by the unique index', () => {
  const db = require_('../../../src/main/db.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd13-repeat-'))
  db.init(dir)
  try {
    const base = { taskId: 'r1', taskContent: 'renewal', dayStart: today, todoTime: today, repeatId: 'grp1', categoryId: 0, userId: 1, status: 'add', createTime: Date.now(), updateTime: Date.now(), complete: false, delete: false }
    const r1 = db.call('upsert', { ...base, taskId: 'r1' })
    assert.ok(r1, 'first renewal instance inserted')
    assert.throws(() => db.call('upsert', { ...base, taskId: 'r2' }),
      /UNIQUE constraint failed/,
      'the duplicate live renewal write is rejected (renderer/CLI adopt the existing instance)')
    // a second instance on another day is fine, and tombstoned rows do not block re-minting
    assert.ok(db.call('upsert', { ...base, taskId: 'r3', dayStart: today + DAY_MS, todoTime: today + DAY_MS }), 'different day still inserts')
    assert.ok(db.call('upsert', { ...base, taskId: 'r1', delete: true, deletedAt: Date.now() }), 'tombstone update of the same row ok')
    assert.ok(db.call('upsert', { ...base, taskId: 'r4', dayStart: today, repeatId: 'grp1', delete: false }), 'after the row is deleted, a new renewal for the same day is allowed')
  } finally { db.close() }
})

test('#10 DB migration v9 collapses pre-existing duplicate live renewals (keeps the oldest)', () => {
  const db = require_('../../../src/main/db.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd13-repeat-mig-'))
  // Round 1: boot WITHOUT v9 (test seam), plant duplicates like the pre-fix race would
  db.__setMigrationsForTests([{ v: 1, fn: () => true }])
  db.init(dir)
  try {
    const base = { taskContent: 'dup', dayStart: today, todoTime: today, repeatId: 'grpX', categoryId: 0, userId: 1, status: 'add', createTime: 1, updateTime: 1, complete: false, delete: false }
    db.call('upsert', { ...base, taskId: 'd1', createTime: 1 })
    db.call('upsert', { ...base, taskId: 'd2', createTime: 2 })
    db.call('upsert', { ...base, taskId: 'd3', createTime: 3 })
  } finally { db.close() }
  // Round 2: real migrations (v9 runs) — duplicates collapsed, index live
  db.__setMigrationsForTests(null)
  db.init(dir)
  try {
    const rows = db.call('queryTodos', { deleted: 0, repeatId: 'grpX', dayStartFrom: today, dayStartTo: today })
    assert.equal(rows.length, 1, 'exactly one live instance survives the migration')
    assert.equal(rows[0].taskId, 'd1', 'the OLDEST instance is kept')
    const bin = db.call('queryTodos', { deleted: 1, repeatId: 'grpX', dayStartFrom: today, dayStartTo: today })
    assert.equal(bin.length, 2, 'later duplicates are tombstoned, not destroyed')
  } finally { db.close() }
})

test('#10 renderer addTodo: a constraint-rejected renewal write adopts the winner instead of duplicating', async () => {
  const todoMod = (await import('../../../renderer/js/store/todo.js')).default
  let emptyQueries = 0
  const puts = []
  globalThis.window.todoAPI = {
    dbCall (op, params) {
      if (op === 'queryTodos') {
        emptyQueries++
        if (emptyQueries === 1) return Promise.resolve([]) // pre-write guard: no existing instance yet
        return Promise.resolve([{ taskId: 'winner', repeatId: 'grp9', dayStart: today, taskContent: 'renewal', delete: false, complete: false }])
      }
      if (op === 'upsert') {
        puts.push(params)
        return Promise.reject(new Error('UNIQUE constraint failed: todos.recurGroupId, todos.scheduledDay'))
      }
      return Promise.resolve(null)
    }
  }
  const state = { todoList: [], recycleList: [], viewsDirty: true, recentlyAddedTaskId: '' }
  const mutationsCalled = []
  const ctx = {
    state,
    rootState: { settings: { newTodoCategoryId: 0, newTodoDefaultSort: 'top' }, auth: { user: { userId: 1 } } },
    commit (m, p) { mutationsCalled.push([m, p]); if (todoMod.mutations[m]) todoMod.mutations[m](state, p) },
    dispatch () { return Promise.resolve() }
  }
  emptyQueries = 0
  const t = await todoMod.actions.addTodo.call(ctx, ctx, { categoryId: 0, todoContent: 'renewal', todoDate: today, repeatId: 'grp9' })
  assert.equal(t.taskId, 'winner', 'the caller resolves to the winner instance (transparent adoption)')
  const removed = mutationsCalled.find(([m]) => m === 'removeLocal')
  assert.ok(removed, 'the losing optimistic row was removed from memory')
  assert.equal(state.todoList.find(x => x.taskId === removed[1]), undefined, 'the loser row is gone from the list')
  const winner = state.todoList.find(x => x.taskId === 'winner')
  assert.ok(winner, 'the winner row is adopted into memory')
  assert.equal(puts.length, 1, 'exactly one DB write attempted by the loser')
})

/* ==================== #11: quit-flush ack waits for the critical write ==================== */

test('#11 ackQuitFlushAfterWrite: the ack fires only after the retained write settles (bounded)', async () => {
  const BACKUP = await import('../../../renderer/js/store/helpers/todoBackup.js')
  let acked = 0
  let resolveWrite
  const write = new Promise(r => { resolveWrite = r })
  const done = BACKUP.ackQuitFlushAfterWrite({ write, notifyDone: () => { acked++ }, capMs: 5000, floorMs: 5 })
  await new Promise(r => setTimeout(r, 60))
  assert.equal(acked, 0, 'pre-fix shape: a fixed 60ms ack would already have fired while the write is still in flight')
  resolveWrite(true)
  await done
  assert.equal(acked, 1, 'ack fires after the write settles')
})

test('#11 ackQuitFlushAfterWrite: a hung write cannot block the quit (cap) and a rejected write still acks', async () => {
  const BACKUP = await import('../../../renderer/js/store/helpers/todoBackup.js')
  let acked = 0
  await BACKUP.ackQuitFlushAfterWrite({ write: new Promise(() => {}), notifyDone: () => { acked++ }, capMs: 30, floorMs: 1 })
  assert.equal(acked, 1, 'cap fires the ack even when the write never settles')
  acked = 0
  await BACKUP.ackQuitFlushAfterWrite({ write: Promise.reject(new Error('disk full')), notifyDone: () => { acked++ }, capMs: 5000, floorMs: 1 })
  assert.equal(acked, 1, 'a failed write does not block the ack (failure already stamped in runtimeState)')
})

/* ==================== #12: dbMirror give-up parks the blob durably ==================== */

test('#12 dbMirror: exhausting the retry budget parks the blob durably and restore prefers LS', async () => {
  // Isolate LS keys this test touches
  const KEY = 'db.settingsState'
  globalThis.localStorage.removeItem('dbMirror.unflushed.' + KEY)
  const calls = []
  let fail = true
  const origDbCall = globalThis.window.todoAPI && globalThis.window.todoAPI.dbCall
  globalThis.window.todoAPI = {
    ...(globalThis.window.todoAPI || {}),
    dbCall (op, params) { calls.push([op, params]); return fail ? Promise.reject(new Error('disk full')) : Promise.resolve('ok') }
  }
  const M = await import('../../../renderer/js/utils/dbMirror.js')
  const savedTiming = { ...M._timing }
  try {
    M._timing.retryBaseMs = 1
    M._timing.retryMaxMs = 1
    M._timing.maxAttempts = 1 // first failure retries once, second gives up
    M.mirrorToDb(KEY, { v: 'newer-ls' }, true)
    await new Promise(r => setTimeout(r, 15)) // attempt 1 fails -> re-queued
    M.mirrorToDb(KEY, { v: 'newer-ls' }, true) // same blob, fresh budget burn: attempt fails -> re-queued
    await new Promise(r => setTimeout(r, 15))
    M.mirrorToDb(KEY, { v: 'newer-ls' }, true)
    await new Promise(r => setTimeout(r, 15))
    const parked = JSON.parse(globalThis.localStorage.getItem('dbMirror.unflushed.' + KEY) || 'null')
    assert.ok(parked && parked.blob, 'give-up parks the blob durably (pre-fix: deleted, silent)')
    assert.equal(parked.blob.v, 'newer-ls', 'the parked blob is the newest LS content')
    // consumer side: the marker is consumed and the caller re-mirrors with a fresh budget
    fail = false
    const consumed = M.consumeUnflushed(KEY)
    assert.ok(consumed && consumed.blob.v === 'newer-ls', 'restore consumes the marker and gets the LS blob')
    assert.equal(globalThis.localStorage.getItem('dbMirror.unflushed.' + KEY), null, 'marker cleared on consumption')
    M.mirrorToDb(KEY, { v: 'newer-ls' }, true) // settings.initFromDb's re-mirror
    await new Promise(r => setTimeout(r, 15))
    assert.ok(calls.some(c => c[0] === 'setMeta' && JSON.parse(c[1][1]).v === 'newer-ls'), 'the newer LS blob is re-mirrored over the stale DB copy')
  } finally {
    Object.assign(M._timing, savedTiming)
    globalThis.localStorage.removeItem('dbMirror.unflushed.' + KEY)
    if (origDbCall) globalThis.window.todoAPI.dbCall = origDbCall
  }
})

test('#12 settings.initFromDb: a parked unflushed marker skips the DB restore and re-mirrors LS', async () => {
  const settingsMod = (await import('../../../renderer/js/store/settings.js')).default
  const KEY = 'db.settingsState'
  globalThis.localStorage.setItem('dbMirror.unflushed.' + KEY, JSON.stringify({ at: Date.now(), blob: { v: 'ls-newer' } }))
  const mirrored = []
  const origDbCall = globalThis.window.todoAPI && globalThis.window.todoAPI.dbCall
  globalThis.window.todoAPI = {
    ...(globalThis.window.todoAPI || {}),
    dbCall (op, params) {
      if (op === 'getMeta' && params[0] === KEY) { callsGetMeta = true; return Promise.resolve(JSON.stringify({ _savedAt: 1, theme: 'stale-db' })) } // OLD db blob
      if (op === 'setMeta') mirrored.push(params)
      return Promise.resolve('ok')
    }
  }
  const state = { theme: 'ls-newer' }
  const committed = []
  let callsGetMeta = false
  const ctx = {
    state,
    commit (m, p) { committed.push([m, p]) },
    dispatch () { return Promise.resolve() }
  }
  try {
    await settingsMod.actions.initFromDb.call(ctx, ctx)
    assert.equal(globalThis.localStorage.getItem('dbMirror.unflushed.' + KEY), null, 'the marker was consumed')
    assert.ok(!mirrored.some(p => p[0] === 'getMeta' && p[1] === KEY) && !callsGetMeta, 'the stale DB blob was NOT restored over LS (no read of the DB mirror)')
    assert.ok(!committed.some(c => c[0] === 'updateSettings'), 'no DB values were adopted over LS')
  } finally {
    globalThis.localStorage.removeItem('dbMirror.unflushed.' + KEY)
    if (origDbCall) globalThis.window.todoAPI.dbCall = origDbCall
  }
})
