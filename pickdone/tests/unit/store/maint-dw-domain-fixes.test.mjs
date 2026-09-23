/* maint/dw wave (2026-09-23) renderer-state-ui domain regressions:
 * [1] P1-1: settings/update mirrors tomatoTime/restTime/dailyTomatoTarget into the tomato runtime
 *     ledger (tomato/patch commit) — CLI `settings set` / LAN sync (updateExternal) / DB restore
 *     (initFromDb) all converge through the action, so the live countdown no longer stays stale.
 * [2] P1-1: SettingsModal no longer carries its own mirror (the action is the single bridge).
 * [3] P2-2: settings/update reports IPC failure as { ok:false } — saveShortcuts must not fake
 *     "saved" nor advance the dirty snapshot when config.json was not written.
 * [4] P2-3: the shortcut factory table is single-sourced (shared/shortcut-defaults.mjs) —
 *     config-store DEFAULT_SHORTCUTS, settings DEFAULT_SETTINGS and the shortcuts tab's reset
 *     must all be the same map; a drifted hand-copy re-enabled dead hotkeys on reset+save.
 * [5] P2-4: TodoItem sort writes are guarded by normalizeSortMode !== 'custom' (drag + keyboard)
 *     and the false "moved" announce is skipped when blocked.
 * [6] P2-5: editSave failure paths re-queue the immediate patch (failure injection) — a failed
 *     dispatch leaves the queued patch replayable instead of silently dropped.
 * [7] P3-6: category tombstone cutoff uses the same calendar-day arithmetic as the todo purge.
 * [8] P3-9: ui exposes an openFeedback mutation (showFeedbackModal was permanently unreachable).
 * Run: node --test tests/unit/store/maint-dw-domain-fixes.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')
const require = createRequire(import.meta.url)

test('[1] settings/update mirrors duration keys into the tomato ledger for EVERY inbound path', async () => {
  const { default: settings, tomatoLedgerPatch } = await import('../../../renderer/js/store/settings.js')
  // pure helper: only declared, non-null duration keys are mirrored
  assert.deepEqual(tomatoLedgerPatch({ tomatoTime: 30, junk: 1 }), { tomatoTime: 30 })
  assert.deepEqual(tomatoLedgerPatch({ tomatoTime: 30, restTime: 10, dailyTomatoTarget: 12, sortMode: 'custom' }),
    { tomatoTime: 30, restTime: 10, dailyTomatoTarget: 12 })
  assert.deepEqual(tomatoLedgerPatch({ sortMode: 'custom' }), {}, 'no duration keys = no mirror commit')
  assert.deepEqual(tomatoLedgerPatch(null), {})

  const committed = []
  const ctx = { commit: (m, p, opts) => committed.push({ m, p, opts }) }
  await settings.actions.update(ctx, { tomatoTime: 30, colorMode: 'dark' })
  const mirror = committed.find(c => c.m === 'tomato/patch')
  assert.ok(mirror, 'update with tomatoTime commits tomato/patch')
  assert.deepEqual(mirror.p, { tomatoTime: 30 })
  assert.equal(mirror.opts && mirror.opts.root, true, 'the mirror commit targets the tomato module (root)')

  committed.length = 0
  await settings.actions.update(ctx, { sortMode: 'created' })
  assert.ok(!committed.some(c => c.m === 'tomato/patch'), 'non-duration patches must NOT touch the tomato ledger')
})

test('[1b] updateExternal (LAN sync / CLI watcher) reaches the tomato ledger through update', async () => {
  const { default: settings } = await import('../../../renderer/js/store/settings.js')
  const committed = []
  const dispatched = []
  const ctx = {
    state: { onboardingToursSeen: {}, shortcutKeySettings: {} },
    commit: (m, p, opts) => committed.push({ m, p, opts }),
    dispatch: (a, p) => dispatched.push({ a, p })
  }
  // inbound patch crosses the trust boundary as legacy numeric STRINGS (CLI shape)
  await settings.actions.updateExternal(ctx, { tomatoTime: '45' })
  const upd = dispatched.find(d => d.a === 'update')
  assert.ok(upd, 'updateExternal re-dispatches through the update action')
  // wire the fake dispatch to the REAL update action so the full chain is exercised
  await settings.actions.update(ctx, upd.p)
  const mirror = committed.find(c => c.m === 'tomato/patch')
  assert.ok(mirror, 'the inbound duration reached the tomato ledger')
  assert.deepEqual(mirror.p, { tomatoTime: 45 }, 'numeric-string coerced and mirrored')
})

test('[1c] initFromDb raw-commit branch mirrors the tomato ledger too', () => {
  assert.ok(read('renderer/js/store/settings.js').includes('mirrorTomatoLedger(commit, patch) } // P1-1'),
    'the non-main-apply commit branch carries the same mirror call')
})

test('[2] SettingsModal.set no longer carries its own tomato mirror (thin call)', () => {
  const modal = read('renderer/js/components/SettingsModal.vue')
  assert.ok(!modal.includes('tomatoKeys'), 'the hand-rolled duration mirror block must be gone (single bridge = the action)')
})

test('[3] settings/update reports IPC failure as { ok:false }; success/absent-bridge as { ok:true }', async () => {
  const { default: settings } = await import('../../../renderer/js/store/settings.js')
  const errors = []
  const realError = console.error
  console.error = (...a) => errors.push(a)
  try {
    // IPC failure path
    globalThis.window.todoAPI = { updateSettings: async () => { throw new Error('ipc down') } }
    const r1 = await settings.actions.update({ commit: () => {} }, { appLocale: 'zh-CN' })
    assert.equal(r1.ok, false, 'a rejected updateSettings IPC must be reported, not swallowed')
    // success path
    let written = null
    globalThis.window.todoAPI = { updateSettings: async p => { written = p } }
    const r2 = await settings.actions.update({ commit: () => {} }, { appLocale: 'zh-CN' })
    assert.equal(r2.ok, true)
    assert.deepEqual(written, { appLocale: 'zh-CN' })
    // degraded host (no bridge): treated as ok, must not throw
    delete globalThis.window.todoAPI
    const r3 = await settings.actions.update({ commit: () => {} }, { appLocale: 'zh-CN' })
    assert.equal(r3.ok, true, 'absent bridge (tests/browser host) counts as ok')
  } finally {
    console.error = realError
    delete globalThis.window.todoAPI
  }
})

test('[3b] saveShortcuts honors the result: failure = error toast + snapshot NOT advanced', () => {
  const src = read('renderer/js/components/settings/SettingsShortcutsTab.vue')
  assert.ok(/await this\.\$store\.dispatch\('settings\/update'/.test(src), 'the dispatch is awaited (was fire-and-forget)')
  const saveIdx = src.indexOf('async saveShortcuts')
  const body = src.slice(saveIdx, src.indexOf('isDirty ()', saveIdx))
  const failIdx = body.indexOf('r.ok === false')
  const snapIdx = body.indexOf('this._shortcutSnapshot = JSON.stringify')
  const errIdx = body.indexOf('$message.error')
  assert.ok(failIdx > -1, 'failure branch exists')
  assert.ok(failIdx < errIdx, 'failure shows an error toast…')
  assert.ok(errIdx < snapIdx, '…and the failure branch precedes the snapshot advance (isDirty stays true)')
})

test('[4] shortcut factory table is single-sourced across main config-store, settings store and the reset button', async () => {
  const shared = await import('../../../shared/shortcut-defaults.mjs')
  const configStore = require(path.join(ROOT, 'src/main/config-store.js'))
  assert.deepEqual(configStore.DEFAULT_SHORTCUTS, shared.DEFAULT_SHORTCUTS, 'main process reads the shared table')
  const { DEFAULT_SETTINGS } = await import('../../../renderer/js/store/settings.js')
  assert.deepEqual(DEFAULT_SETTINGS.shortcutKeySettings, shared.DEFAULT_SHORTCUTS, 'renderer store seeds the shared table')
  const tab = read('renderer/js/components/settings/SettingsShortcutsTab.vue')
  assert.ok(tab.includes('resetShortcuts ()') && /\{\s*\.\.\.DEFAULT_SHORTCUTS\s*\}/.test(tab),
    'restore-defaults reads the shared table (no hand-copied literal)')
  assert.ok(!/pinEvent: 'ctrl\+p'/.test(tab), 'the drifted hand-copy (which re-enabled dead hotkeys) is gone')
})

test('[5] TodoItem sort writes are guarded by non-custom sort mode (drag + keyboard)', () => {
  const src = read('renderer/js/components/TodoItem.vue')
  const writeSort = src.slice(src.indexOf('_writeSort (list)'), src.indexOf('keyboardMove (dir)'))
  assert.ok(writeSort.includes("normalizeSortMode(this.$store.state.settings.sortMode) !== 'custom'"),
    '_writeSort checks the sort mode (covers onDrop drag path)')
  assert.ok(writeSort.includes('pinIgnoredSort'), 'blocked writes announce honestly (same copy as pinEvent)')
  assert.ok(writeSort.includes('return false'), 'the guard reports the block to callers')
  const kb = src.slice(src.indexOf('keyboardMove (dir)'), src.indexOf('onCheckClick (e)'))
  assert.ok(/if \(!this\._writeSort\(list\)\) return/.test(kb),
    'keyboardMove skips the false "moved" announce when the write was blocked')
})

test('[6] editSave failure injection: every catch re-queues the immediate patch', async () => {
  const { createSaveQueue } = await import('../../../renderer/js/utils/editSave.js')
  const dispatches = []
  let fail = true
  const store = { dispatch: async (a, p) => { dispatches.push(p); if (fail) throw new Error('db down') } }
  const opts = { getTaskId: () => 'T1', debounceMs: 5, onFail: () => {} }
  const q = createSaveQueue(store, opts)
  q.boot()

  // (a) debounce-timer catch: immediate patch survives a failed dispatch…
  q.queueSave({ taskContent: 'typed title' })
  await new Promise(r => setTimeout(r, 30))
  assert.equal(dispatches.length, 1)
  assert.ok(fail === true)
  // …and the NEXT flush replays it (retrySave / next queueSave actually resends)
  fail = false
  await q.flushSave()
  assert.ok(dispatches[1] && dispatches[1].patch && dispatches[1].patch.taskContent === 'typed title',
    'the failed timer patch is replayed by the next flush')

  // (b) flushSave same-task catch: the failed flush fails again (fail still true), then replays
  dispatches.length = 0; fail = true
  q.queueSave({ taskDescribe: 'immediate desc' })
  await new Promise(r => setTimeout(r, 30)) // timer fires, fails, patch re-queued
  await q.flushSave() // same-task flush also fails (fail still true)
  assert.equal(dispatches.length, 2, 'timer attempt + failed same-task flush')
  fail = false
  await q.flushSave()
  assert.ok(dispatches[2].patch.taskDescribe === 'immediate desc',
    'the failed same-task flush patch is replayed')

  // (c) the task-switched branch is covered by [6c-alt] below.
})

test('[6c-alt] the task-switched flush re-queues the old task patch with its ORIGINAL taskId', async () => {
  const { createSaveQueue } = await import('../../../renderer/js/utils/editSave.js')
  const dispatches = []
  let currentTaskId = 'T1'
  let fail = true
  const store = {
    dispatch: async (a, p) => { dispatches.push({ to: p.taskId, patch: p.patch }); if (fail) throw new Error('db down') }
  }
  const q = createSaveQueue(store, { getTaskId: () => currentTaskId, debounceMs: 5, onFail: () => {} })
  q.boot()
  q.queueSave({ taskContent: 'A-typed' }) // enqueued under T1
  await new Promise(r => setTimeout(r, 30)) // timer fires, dispatch to T1 fails, patch re-queued as T1
  currentTaskId = 'T2' // user switches tasks
  fail = false
  await q.flushSave()
  const t1Writes = dispatches.filter(d => d.to === 'T1' && d.patch.taskContent === 'A-typed')
  assert.equal(t1Writes.length, 2, 'the re-queued patch replays to the ENQUEUE-time task after the switch')
  assert.ok(!dispatches.some(d => d.to === 'T2' && d.patch.taskContent === 'A-typed'),
    'the old task edit never leaks onto the new task')
})

test('[7] category tombstone cutoff matches the todo purge calendar-day arithmetic', () => {
  const cat = read('renderer/js/store/category.js')
  // local-midnight minus N whole calendar days (equivalent to store/todo.js's
  // startOf('day').subtract(days,'day')), computed with plain Date math (no window.dayjs dependency)
  assert.ok(cat.includes('_localMidnight - retentionDays * 86400000'),
    'the cutoff rolls back whole calendar days from local midnight (same basis as todo.js purgeRecycleBin)')
  assert.ok(!cat.includes('Date.now() - retentionDays'), 'the drifting rolling-24h arithmetic is gone')
})

test('[8] ui exposes openFeedback (showFeedbackModal was permanently unreachable)', async () => {
  const { default: ui } = await import('../../../renderer/js/store/ui.js')
  const state = ui.state()
  assert.equal(state.showFeedbackModal, false)
  ui.mutations.openFeedback(state)
  assert.equal(state.showFeedbackModal, true, 'an open mutation now exists and flips the flag')
  ui.mutations.closeFeedback(state)
  assert.equal(state.showFeedbackModal, false)
})

test('[8b] FeedbackModal stages at most PENDING_CAP entries (oldest dropped)', () => {
  const src = read('renderer/js/components/FeedbackModal.vue')
  assert.ok(/const PENDING_CAP = \d+/.test(src), 'the staging cap is declared')
  assert.ok(/while \(arr\.length > PENDING_CAP\) arr\.shift\(\)/.test(src),
    'overflow drops the OLDEST entry, never the new feedback')
})
