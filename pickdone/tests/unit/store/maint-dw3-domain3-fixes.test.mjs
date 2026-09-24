/* maint/dw wave3 — domain 3 (renderer store state / settings pipeline / batch performance):
 * [F-C1] todo/deleteTodosMany: batch soft-delete — the deleted SET is exactly the live rows asked
 *        for (dead ids skipped), ONE undo step restores the whole batch (single pre-batch history
 *        snapshot), ONE putMany write carries all rows with the local `deleting` flag stripped.
 * [F-C2] settings/initFromDb: DEFAULT_SETTINGS whitelist — habits-family keys riding the
 *        db.settingsState blob no longer land in the live settings state.
 * [F-C3] sanitizeSettingsPatch / tomato patch: out-of-range durations are clamped
 *        (tomatoTime 5-180, restTime 1-60, dailyTomatoTarget 1-50) instead of reaching the
 *        running countdown verbatim.
 * [F-C4] dbMirror.restoreFromDb: distinguishes READ ERROR (DB_MIRROR_ERROR sentinel) from an empty
 *        mirror, and initFromDb's error path neither restores nor writes back.
 * Run: node --test tests/unit/store/maint-dw3-domain3-fixes.test.mjs
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = (fn, ms) => realSetTimeout(fn, Math.min(ms || 0, 20))
const sleep = ms => new Promise(r => realSetTimeout(r, ms))

const mkDayjs = ts => {
  const t = ts == null ? Date.now() : (ts && typeof ts === 'object' && ts.valueOf ? ts.valueOf() : ts)
  const o = {
    format: f => f === 'YYYY-MM-DD' ? String(t) : String(t),
    valueOf: () => t,
    startOf: u => u === 'day' ? mkDayjs(t) : o,
    add: () => o, subtract: () => o, isSame: () => false
  }
  return o
}
globalThis.dayjs = mkDayjs
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
try { globalThis.navigator = { language: 'zh-CN' } } catch { /* read-only on newer Node */ }

// dbCall stub: getMeta served from a settable impl; every op is RECORDED so tests can assert
// exactly which writes fired.
let getMetaImpl = () => Promise.resolve(null)
const dbOps = []
globalThis.window = {
  location: { hash: '', href: 'http://localhost/' },
  dayjs: mkDayjs,
  todoAPI: {
    dbCall: (op, ...a) => {
      dbOps.push([op, a])
      if (op === 'getMeta') return getMetaImpl(...a)
      return Promise.resolve(null)
    },
    writeCriticalStateBackup: () => Promise.resolve()
  }
}

let importSeq = 0
const importSrc = p => import(pathToFileURL(p).href + '?fresh=' + (++importSeq))
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const src = p => path.join(ROOT, p)

const todoMod = await importSrc(src('renderer/js/store/todo.js'))
const todoActions = todoMod.default.actions
const todoMutations = todoMod.default.mutations
const settingsMod = await importSrc(src('renderer/js/store/settings.js'))
const settingsActions = settingsMod.default.actions
const dbMirrorMod = await importSrc(src('renderer/js/utils/dbMirror.js'))
const tomatoMod = await importSrc(src('renderer/js/store/tomato.js'))

const row = (taskId, over = {}) => ({
  taskId, taskContent: 't-' + taskId, delete: false, dayStart: 0, todoTime: 0,
  updateTime: 1, status: 'update', version: 1, ...over
})

beforeEach(() => {
  dbOps.length = 0
  getMetaImpl = () => Promise.resolve(null)
})

/* ---------------- F-C1: deleteTodosMany ---------------- */

function mkCtx (todoState, dispatches) {
  const applied = []
  const commit = (type, payload) => {
    applied.push(type)
    const short = type.startsWith('todo/') ? type.slice(5) : type
    if (todoMutations[short]) todoMutations[short](todoState, payload)
  }
  const dispatch = async (name, payload) => { dispatches.push(name); return {} }
  return { ctx: { commit, dispatch, rootState: { tomato: { attachTodo: null } }, state: todoState }, applied, dispatches }
}

test('F-C1: deleteTodosMany deletes exactly the live rows asked for and skips dead ids', async () => {
  const todoState = { todoList: [row('a'), row('b'), row('c')], recycleList: [], undoStack: [], redoStack: [], search: '' }
  const dispatches = []
  const { ctx, applied } = mkCtx(todoState, dispatches)
  const ids = await todoActions.deleteTodosMany.call({ state: { todo: todoState } }, ctx, [row('a'), row('b'), row('dead')])
  assert.deepEqual(ids, ['a', 'b'], 'dead id not in live table must be skipped')
  for (const t of todoState.todoList) {
    if (ids.includes(t.taskId)) {
      assert.equal(t.delete, true, t.taskId + ' soft-deleted')
      assert.equal(t.status, 'delete')
      assert.ok(t.deletedAt > 0)
      assert.equal(t.version, 0, 'version reset like deleteTodo (re-delete after restore re-enters sync)')
      assert.equal('deleting' in t ? t.deleting : false, true, 'local deleting flag set on live rows')
    } else {
      assert.equal(t.delete, false, t.taskId + ' untouched')
    }
  }
  // ONE computeViews, ONE writeCriticalBackup — not one per row
  assert.equal(dispatches.filter(n => n === 'computeViews').length, 1, 'single computeViews')
  assert.equal(dispatches.filter(n => n === 'writeCriticalBackup').length, 1, 'single writeCriticalBackup')
  // ONE batch DB write (putMany), not one put per row
  const puts = dbOps.filter(([op]) => op === 'upsert' || op === 'upsertMany')
  const putMany = puts.find(([op]) => op === 'upsertMany')
  assert.ok(putMany, 'batch goes through a single putMany')
  assert.equal(putMany[1][0].length, 2, 'putMany carries both rows')
  for (const r of putMany[1][0]) assert.equal('deleting' in r, false, 'local dialect flag stripped before persist')
  // exactly ONE history snapshot for the whole batch (not in undo action set, pushed in-action)
  assert.equal(applied.filter(t => t === 'historyPush').length, 1, 'one historyPush per batch')
  assert.equal(todoState.undoStack.length, 1, 'one undo step for the whole batch')
  const snap = JSON.parse(todoState.undoStack[0].replace(/,"_e":\d+\}$/, '}'))
  const snapById = Object.fromEntries([...snap.todoList, ...snap.recycleList].map(t => [t.taskId, t]))
  assert.equal(snapById.a.delete, false, 'snapshot is the PRE-batch state')
  assert.equal(snapById.b.delete, false)
  assert.equal(snapById.c.delete, false)
})

test('F-C1: empty/dead-only batch is a no-op (no snapshot, no write, no computeViews)', async () => {
  const todoState = { todoList: [], recycleList: [], undoStack: [], redoStack: [], search: '' }
  const dispatches = []
  const { ctx, applied } = mkCtx(todoState, dispatches)
  const ids = await todoActions.deleteTodosMany.call({ state: { todo: todoState } }, ctx, [row('ghost')])
  assert.deepEqual(ids, [])
  assert.equal(applied.filter(t => t === 'historyPush').length, 0)
  assert.equal(dispatches.filter(n => n === 'computeViews').length, 0)
  assert.equal(dbOps.filter(([op]) => op === 'upsertMany').length, 0)
})

/* ---------------- F-C2: initFromDb whitelist ---------------- */

test('F-C2: initFromDb drops habits-family junk keys from the db blob (DEFAULT_SETTINGS whitelist)', async () => {
  const { DEFAULT_SETTINGS } = settingsMod
  const blob = {
    _savedAt: Date.now(), schemaV: 1,
    developerMode: true, // legit settings key must still flow
    habits: [{ id: 'h1', records: {} }], moments: [], savedAt: Date.now() // habits-family pollution
  }
  getMetaImpl = () => Promise.resolve(JSON.stringify(blob))
  const state = { ...DEFAULT_SETTINGS, shortcutKeySettings: { ...DEFAULT_SETTINGS.shortcutKeySettings } }
  const commits = []
  const dispatches = []
  await settingsActions.initFromDb.call({}, {
    state,
    commit: (t, p) => commits.push([t, p]),
    dispatch: async (n, p) => { dispatches.push([n, p]) }
  })
  const upd = commits.find(([t]) => t === 'updateSettings')
  assert.ok(upd, 'legit differing keys are applied')
  assert.equal(upd[1].developerMode, true)
  for (const junk of ['habits', 'moments', 'savedAt', 'schemaV']) {
    assert.ok(!(junk in upd[1]), `${junk} must not land in the live settings state`)
  }
  assert.ok(!(('habits') in state), 'live state stays habits-free')
})

/* ---------------- F-C3: numeric range clamp ---------------- */

test('F-C3: sanitizeSettingsPatch clamps out-of-range durations instead of passing them verbatim', async () => {
  const { sanitizeSettingsPatch } = settingsMod
  // the probe case from the finding: {tomatoTime: 9999, restTime: 0} used to pass through untouched
  const out = sanitizeSettingsPatch({ tomatoTime: 9999, restTime: 0, dailyTomatoTarget: 999 })
  assert.equal(out.tomatoTime, 180, 'tomatoTime clamped to max 180')
  assert.equal(out.restTime, 1, 'restTime clamped to min 1')
  assert.equal(out.dailyTomatoTarget, 50, 'dailyTomatoTarget clamped to max 50')
  // in-range values pass untouched
  const ok = sanitizeSettingsPatch({ tomatoTime: 25, restTime: 5, dailyTomatoTarget: 8 })
  assert.deepEqual({ t: ok.tomatoTime, r: ok.restTime, d: ok.dailyTomatoTarget }, { t: 25, r: 5, d: 8 })
  // out-of-range from BELOW clamps too
  assert.equal(sanitizeSettingsPatch({ tomatoTime: 1 }).tomatoTime, 5)
  // non-numeric junk still dropped (type validation unchanged)
  assert.ok(!('tomatoTime' in sanitizeSettingsPatch({ tomatoTime: 'abc' })))
})

test('F-C3: tomato/patch mutation clamps the ledger keys as the final hop (other keys untouched)', async () => {
  const s = { tomatoTime: 25, restTime: 5, whiteNoiseVolume: 0.55 }
  tomatoMod.default.mutations.patch(s, { tomatoTime: 9999, restTime: 0, whiteNoiseVolume: 2 })
  assert.equal(s.tomatoTime, 180, 'running countdown cannot be driven to 9999 minutes')
  assert.equal(s.restTime, 1)
  // B5 (daily 2026-09-24): whiteNoiseVolume gained a manifest range ({min:0,max:1}, the UI
  // volume slider domain), so it is now a bounded setting and IS clamped by the shared table
  // like every other ranged key — the old "not clamped here" expectation was the exact gap B5 closes.
  assert.equal(s.whiteNoiseVolume, 1, 'whiteNoiseVolume clamps to the 0-1 slider domain')
})

/* ---------------- F-C4: restoreFromDb distinguishes error from empty ---------------- */

test('F-C4: restoreFromDb returns DB_MIRROR_ERROR on IPC rejection (not null)', async () => {
  const { restoreFromDb, DB_MIRROR_ERROR } = dbMirrorMod
  getMetaImpl = () => Promise.reject(new Error('transient IPC failure'))
  const r = await restoreFromDb('db.settingsState')
  assert.equal(r, DB_MIRROR_ERROR, 'a failed read must NOT read as "no mirror"')
})

test('F-C4: restoreFromDb returns null for a genuinely empty mirror', async () => {
  const { restoreFromDb, DB_MIRROR_ERROR } = dbMirrorMod
  getMetaImpl = () => Promise.resolve(null)
  const r = await restoreFromDb('db.settingsState')
  assert.equal(r, null)
  assert.notEqual(r, DB_MIRROR_ERROR)
})

test('F-C4: initFromDb on a read error neither restores nor writes the mirror back', async () => {
  getMetaImpl = () => Promise.reject(new Error('transient IPC failure'))
  const state = { ...settingsMod.DEFAULT_SETTINGS }
  const commits = []
  const dispatches = []
  await settingsActions.initFromDb.call({}, {
    state,
    commit: (t, p) => commits.push([t, p]),
    dispatch: async (n, p) => { dispatches.push([n, p]) }
  })
  assert.equal(commits.length, 0, 'no updateSettings commit on a read error')
  assert.equal(dispatches.length, 0, 'no update dispatch on a read error')
  await sleep(60) // let any (wrong) debounced mirror timer fire
  const writes = dbOps.filter(([op]) => op === 'put')
  assert.equal(writes.length, 0, 'the newer DB copy must not be drowned by in-memory defaults')
})
