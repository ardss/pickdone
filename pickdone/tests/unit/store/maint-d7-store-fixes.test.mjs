/* maint/d7 store-domain regressions:
 * [1] auth.saveSnowGain honors a dedupKey: the completeFocus retry path (phase claim released after a
 *     mid-way failure) re-dispatches the same focus's snow gain — it must be applied exactly once.
 * [2] completeFocus passes dedupKey = String(startedAt) to auth/saveSnowGain.
 * [3] tomato flushPendingLedger / todo flushPendingUpserts: a failed quit-flush entry STAYS queued
 *     (was: requeued only in the Promise.all aggregate callback, which never ran when the process
 *     exited — the entry was permanently lost).
 * [4] purgeAllRecycle deletes the purged tasks' per-task pomodoro-estimate meta keys (parity with
 *     purgeIds / review M-C5 / the CLI purge path).
 * [5] settings: isShowCalendarCompleted and tomatoTime/restTime are declared in DEFAULT_SETTINGS
 *     (inbound sync must not strip them); legacy tomatoTimeDefault/restTimeDefault migrate to the
 *     live keys and are dropped from the loaded blob.
 * [6] settings restore() pushes main-consumed key diffs through the updateSettings IPC channel.
 * Run: node --test tests/unit/store/maint-d7-store-fixes.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const sleep = ms => new Promise(r => setTimeout(r, ms))

test('[1] saveSnowGain applies a dedupKey-gained focus exactly once (retry-safe)', async () => {
  globalThis.localStorage.removeItem('gamification.gainDedup')
  const { default: auth } = await import('../../../renderer/js/store/auth.js')
  const state = { user: { snow: 0, tomatoGain: 0 } }
  const ctx = { state, commit: (m, p) => auth.mutations.patchUser(state, p) }
  await auth.actions.saveSnowGain(ctx, { gain: 5, dedupKey: '1700000000001' })
  assert.equal(state.user.snow, 5, 'first application credits the gain')
  await auth.actions.saveSnowGain(ctx, { gain: 5, dedupKey: '1700000000001' }) // completion retry, same focus
  assert.equal(state.user.snow, 5, 'the retried same-focus gain is NOT applied twice')
  await auth.actions.saveSnowGain(ctx, { gain: 3, dedupKey: '1700000000002' })
  assert.equal(state.user.snow, 8, 'a different focus (different key) still credits')
  await auth.actions.saveSnowGain(ctx, 2) // legacy bare-number payload stays compatible
  assert.equal(state.user.snow, 10, 'legacy numeric payload still credits')
})

test('[1b] the dedup guard survives a restart (persisted, not just in-memory)', async () => {
  globalThis.localStorage.removeItem('gamification.gainDedup')
  const mod = '../../../renderer/js/store/auth.js'
  const first = await import(mod)
  const s1 = { user: { snow: 0, tomatoGain: 0 } }
  await first.default.actions.saveSnowGain({ state: s1, commit: (m, p) => first.default.mutations.patchUser(s1, p) }, { gain: 7, dedupKey: 'restart-key-1' })
  assert.equal(s1.user.snow, 7)
  // Fresh module instance = fresh in-memory Set, same localStorage = "restart"
  const second = await import(mod + '?restart=1')
  assert.notEqual(first.default, second.default, 'sanity: a distinct module instance was loaded')
  const s2 = { user: { snow: 0, tomatoGain: 0 } }
  await second.default.actions.saveSnowGain({ state: s2, commit: (m, p) => second.default.mutations.patchUser(s2, p) }, { gain: 7, dedupKey: 'restart-key-1' })
  assert.equal(s2.user.snow, 0, 'the persisted guard blocks the replayed gain after restart')
})

test('[2] completeFocus dispatches auth/saveSnowGain with dedupKey = String(startedAt)', async () => {
  const { default: tomato } = await import('../../../renderer/js/store/tomato.js')
  globalThis.localStorage.removeItem('tomatoLastPhaseDone')
  const startedAt = Date.now() - 25 * 60000 // a full 25-minute focus so the measured gain is deterministic
  const state = Object.assign({}, tomato.state, {
    status: 'startTomatoTime', startedAt, tomatoTime: 25, restTime: 5,
    enableNotification: false, attachTodo: null, tomatoRecordList: [], todayTomatoCount: 0
  })
  const dispatched = []
  const ctx = {
    state,
    rootState: { todo: { todoList: [] }, settings: {} },
    commit (m, p) { tomato.mutations[m] && tomato.mutations[m](state, p) },
    dispatch (path, payload) { dispatched.push({ path, payload }); return Promise.resolve() }
  }
  await tomato.actions.completeFocus(ctx)
  const gain = dispatched.find(d => d.path === 'auth/saveSnowGain')
  assert.ok(gain, 'completeFocus dispatches auth/saveSnowGain')
  assert.equal(gain.payload.dedupKey, String(startedAt), 'the dedup key is the focus phase identity')
  assert.equal(gain.payload.gain, 25, 'the gain is the measured focus minutes')
})

test('[3a] tomato: a ledger entry that fails the quit-flush stays queued and replays', async () => {
  const quitHooks = []
  let fail = true
  const calls = []
  globalThis.window.todoAPI = {
    dbCall: async (op, params) => {
      calls.push([op, params])
      if (op === 'tomatoAppendMany' && fail) throw new Error('db down at quit');
      return op === 'tomatoAppendMany' ? { accepted: 1, rejected: [] } : 'ok'
    },
    onAppQuittingFlush: fn => { quitHooks.push(fn); return () => {} }
  }
  const { default: tomato } = await import('../../../renderer/js/store/tomato.js?flush')
  const s = { tomatoRecordList: [] }
  tomato.mutations.addRecord(s, { tomatoId: 'tmt_flush_1', endTime: Date.now(), dateKey: '2026-09-22', focusDuration: 25 })
  await sleep(10)
  assert.equal(quitHooks.length, 1, 'the quit-flush hook was registered')
  quitHooks[0]() // quit flush: db is down
  await sleep(10)
  const sendCount = () => calls.filter(c => c[0] === 'tomatoAppendMany' && c[1].tomatoId === 'tmt_flush_1').length
  assert.equal(sendCount(), 2, 'the flush attempted the failed entry again (initial write + flush)')
  // After quit-flush failed, the entry must still be queued: any later write (or a succeeding flush)
  // replays it — it was NOT silently dropped.
  fail = false
  quitHooks[0]()
  await sleep(10)
  assert.equal(sendCount(), 3, 'the failed entry survived the failed quit-flush and landed on retry')
})

test('[3b] todo: a pending upsert that fails the quit-flush stays queued and replays', async () => {
  const quitHooks = []
  let fail = true
  const calls = []
  globalThis.window.todoAPI = {
    dbCall: async (op, params) => {
      calls.push([op, params])
      if (params && params.taskId === 'td_flush_1' && fail) throw new Error('db down at quit')
      return 'ok'
    },
    onAppQuittingFlush: fn => { quitHooks.push(fn); return () => {} }
  }
  const { safeUpsert, flushPendingUpserts } = await import('../../../renderer/js/store/todo.js?flush')
  safeUpsert({ taskId: 'td_flush_1', taskContent: 'survive the quit' })
  await sleep(10)
  quitHooks[0]() // flush with db down
  await sleep(10)
  const sendCount = () => calls.filter(c => c[1] && c[1].taskId === 'td_flush_1').length
  assert.equal(sendCount(), 2, 'failed upsert was attempted by the flush, not dropped')
  flushPendingUpserts() // second flush attempt — in-memory queue must still hold the entry
  await sleep(10)
  assert.equal(sendCount(), 3, 'the entry stayed queued across failed flushes and landed on retry')
  fail = false
  flushPendingUpserts()
  await sleep(10)
  assert.equal(sendCount(), 4, 'the surviving entry lands on the next succeeding flush')
  flushPendingUpserts()
  await sleep(10)
  assert.equal(sendCount(), 4, 'after success the entry is removed (no infinite resend)')
})

test('[4] purgeAllRecycle deletes the purged tasks tomato-estimate meta keys (M-C5 parity)', async () => {
  const calls = []
  globalThis.window.todoAPI = {
    dbCall: async (op, params) => { calls.push([op, params]); return 'ok' },
    purgeRecycleBin: async () => true,
    deleteTodoFilesRelevant: async () => {}
  }
  const { default: todo } = await import('../../../renderer/js/store/todo.js?purge')
  const state = {
    todoList: [], recycleList: [{ taskId: 42, categoryId: 0 }, { taskId: 43, categoryId: 0 }],
    undoStack: [], redoStack: [], views: { todayTodoList: [] }, viewsDirty: true, _histEpoch: 0, _histBytes: 0
  }
  const rootState = { tomato: { attachTodo: null }, settings: {} }
  const committed = []
  const ctx = {
    state, rootState,
    commit (m, p) { committed.push(m) },
    dispatch (path, p) { return Promise.resolve() }
  }
  const r = await todo.actions.purgeAllRecycle(ctx)
  assert.equal(r, true, 'purge succeeded')
  const deleted = calls.filter(c => c[0] === 'deleteMeta').map(c => c[1])
  assert.ok(deleted.includes('tomatoEstimateState:42'), 'estimate meta key of task 42 is deleted')
  assert.ok(deleted.includes('tomatoEstimateState:43'), 'estimate meta key of task 43 is deleted')
})

test('[5] settings: live duration keys are declared and legacy keys migrate', async () => {
  globalThis.localStorage.removeItem('settingsState')
  globalThis.localStorage.setItem('settingsState', JSON.stringify({ tomatoTimeDefault: 45, restTimeDefault: 10, schemaV: 1 }))
  const mod = await import('../../../renderer/js/store/settings.js?legacy')
  assert.equal(mod.DEFAULT_SETTINGS.isShowCalendarCompleted, false, 'isShowCalendarCompleted is declared (inbound sync must not strip it)')
  assert.equal(mod.DEFAULT_SETTINGS.tomatoTime, 25, 'tomatoTime is declared')
  assert.equal(mod.DEFAULT_SETTINGS.restTime, 5, 'restTime is declared')
  const store = mod.default
  assert.equal(store.state.tomatoTime, 45, 'legacy tomatoTimeDefault value migrated to the live key')
  assert.equal(store.state.restTime, 10, 'legacy restTimeDefault value migrated to the live key')
  assert.equal(store.state.tomatoTimeDefault, undefined, 'the legacy key is dropped from live state')
  assert.equal(store.state.restTimeDefault, undefined, 'the legacy key is dropped from live state')
})

test('[5b] sanitizeSettingsPatch no longer strips tomatoTime/restTime/isShowCalendarCompleted', async () => {
  const { sanitizeSettingsPatch } = await import('../../../renderer/js/store/settings.js?san')
  const out = sanitizeSettingsPatch({ tomatoTime: '30', restTime: '10', isShowCalendarCompleted: true }, {})
  assert.equal(out.tomatoTime, 30, 'inbound numeric-string tomatoTime is coerced and kept')
  assert.equal(out.restTime, 10, 'inbound restTime is kept')
  assert.equal(out.isShowCalendarCompleted, true, 'inbound isShowCalendarCompleted is kept')
})

test('[6] settings restore() pushes main-consumed diffs through the updateSettings IPC', async () => {
  const ipc = []
  globalThis.window.todoAPI = Object.assign(globalThis.window.todoAPI || {}, {
    updateSettings: async patch => { ipc.push(patch) }
  })
  const { default: settings, SETTINGS_SCHEMA_V } = await import('../../../renderer/js/store/settings.js?restore')
  const state = {}
  settings.mutations.restore(state, {
    runWhenComputerStart: true, closeActionMinimize: false, appLocale: 'en-US',
    shortcutKeySettings: { sync: 'ctrl+k' }, securityLockPassword: 'pw', enableSecurityLock: true,
    schemaV: SETTINGS_SCHEMA_V
  })
  assert.equal(state.runWhenComputerStart, true, 'restore still applies the saved values')
  assert.ok(ipc.length, 'the main process was notified')
  const merged = Object.assign({}, ...ipc)
  assert.equal(merged.runWhenComputerStart, true, 'config-consumed key rides the IPC')
  assert.equal(merged.closeActionMinimize, false, 'windows.js-consumed key rides the IPC')
  assert.equal(merged.appLocale, 'en-US', 'locale rides the IPC')
  assert.equal(merged.securityLockPassword, 'pw', 'security lock password rides the IPC (per-sender strip allows main window)')
  assert.equal(merged.foldedTodoList, undefined, 'renderer-only keys are NOT pushed to main')
  // Defaults-only restore (nothing differs) → no spurious IPC
  ipc.length = 0
  settings.mutations.restore({}, null)
  assert.equal(ipc.length, 0, 'no IPC when the restored state equals defaults for main-consumed keys')
})
