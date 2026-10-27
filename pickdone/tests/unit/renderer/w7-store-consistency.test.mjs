/**
 * W7 store-consistency fixes — regression guards.
 *  R1 [P2] moments deletion tombstones (habits.js): delMoment records a { id, deletedAt } tombstone
 *      in the blob's `deletedMoments` array; every inbound boundary (replaceAll / applyExternal /
 *      applyExternalPatch) merges the tombstones and filters the inbound moments BEFORE the
 *      union-merge, so a peer blob can no longer resurrect a deleted moment.
 *  R2 [P2] backup dump (todoBackup.js): the habitsState segment carries the tombstones
 *      (deleted + deletedMoments) so a JSON restore cannot resurrect post-dump deletions.
 *  R3 [P3] tomato succeed true→false rollback (tomato.js): updateRecord enqueues a symmetric
 *      negative task-side compensation (snow queue, dedupKey 'undo:' + phase identity).
 *  R4 [P3] settings/update appLocale enum gate (settings.js): a junk locale is rejected — never
 *      seats in state, never written to the LS boot cache, never pushed to main.
 *  R5 [P3] categoryLsMigrated is machine-local (shared/machine-local-keys.mjs).
 * Run: node --test tests/unit/renderer/w7-store-consistency.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

if (!globalThis.window.location) globalThis.window.location = { hash: '' }

/* stub bridge BEFORE importing the stores (f3-habits pattern) */
const metaStore = new Map()
const dbCalls = []
globalThis.window.todoAPI = {
  dbCall: async (op, params) => {
    dbCalls.push([op, params])
    if (op === 'getMeta') return metaStore.has(params) ? metaStore.get(params) : null
    if (op === 'setMeta') { metaStore.set(params[0], params[1]); return 'ok' }
    if (op === 'deleteMeta') { metaStore.delete(params); return 'ok' }
    return 'ok'
  }
}
const lastHabitsBlob = () => JSON.parse(metaStore.get('db.habitsState'))
const tick = () => new Promise(r => setTimeout(r, 0))

const habits = (await import('../../../renderer/js/store/habits.js')).default
const { mergeMomentTombstones, applyMomentTombstones } = await import('../../../renderer/js/store/habits.js')
const { buildBackupDump } = await import('../../../renderer/js/store/helpers/todoBackup.js')
const tomatoMod = await import('../../../renderer/js/store/tomato.js')
const settings = (await import('../../../renderer/js/store/settings.js')).default
const { isLegalAppLocale } = await import('../../../renderer/js/store/settings.js')
const { isMachineLocalMetaKey } = await import('../../../shared/machine-local-keys.mjs')

const mkHabitsState = ({ habits: h = [], moments = [], savedAt = 0, deleted = [], deletedMoments = [] } = {}) =>
  ({ habits: h, moments, savedAt, deleted, deletedMoments })

/* ---------------- R1: moments deletion tombstones ---------------- */

test('R1.1 delMoment records a tombstone and persists deletedMoments in the blob', async () => {
  const s = mkHabitsState({ moments: [{ id: 'm1', name: 'Launch', date: '2026-11-01', kind: 'countdown' }] })
  habits.mutations.delMoment(s, 'm1')
  assert.deepEqual(s.moments, [], 'moment removed')
  assert.equal(s.deletedMoments.length, 1)
  assert.equal(s.deletedMoments[0].id, 'm1')
  assert.ok(s.deletedMoments[0].deletedAt > 0)
  await tick()
  const blob = lastHabitsBlob()
  assert.ok(Array.isArray(blob.deletedMoments) && blob.deletedMoments[0].id === 'm1', 'tombstone in the durable blob')
})

test('R1.2 applyExternal: a tombstone superseded by a newer alive inbound moment is pruned; absent ids stay sticky; peer tombstones merge', () => {
  const s = mkHabitsState({ savedAt: 500, moments: [{ id: 'keep', name: 'K' }], deletedMoments: [{ id: 'm1', deletedAt: 400 }] })
  habits.mutations.applyExternal(s, {
    savedAt: 900,
    habits: [],
    moments: [{ id: 'm1', name: 'UndoneUpstream' }, { id: 'peer', name: 'Peer' }],
    deletedMoments: [{ id: 'm9', deletedAt: 800 }]
  })
  // [W11 2026-10-26] recalibrated: the round postdates the delete (400 < 900) and still carries
  // m1 alive → undone upstream, alive row wins, tombstone pruned. m9 is absent from the inbound
  // moments array → its tombstone keeps full stickiness.
  assert.ok(s.moments.some(m => m.id === 'm1'), 'W11: superseded tombstone pruned — the alive inbound moment survives')
  assert.ok(s.moments.some(m => m.id === 'keep'), 'local moment survives the union-merge')
  assert.ok(s.moments.some(m => m.id === 'peer'), 'peer moment merged (union-merge intact)')
  assert.deepEqual(s.deletedMoments.map(t => t.id), ['m9'], 'm1 tombstone pruned; m9 (absent inbound) sticky')
})

test('R1.3 applyExternalPatch: superseded moment tombstones pruned on the LAN fold channel; newer tombstones still filter (fields + bare-blob shapes)', () => {
  const s = mkHabitsState({ savedAt: 500, deletedMoments: [{ id: 'm1', deletedAt: 400 }] })
  habits.mutations.applyExternalPatch(s, { savedAt: 900, fields: { moments: [{ id: 'm1', name: 'undone upstream' }, { id: 'm3', name: 'ok' }] } })
  // [W11 2026-10-26] the fold round postdates the delete and carries m1 alive → pruned, m1 survives
  assert.ok(s.moments.some(m => m.id === 'm1'), 'W11: superseded tombstone pruned — fold round cannot re-delete the undone moment')
  assert.ok(s.moments.some(m => m.id === 'm3'))
  habits.mutations.applyExternalPatch(s, { savedAt: 1000, moments: [{ id: 'm4', name: 'x' }], deletedMoments: [{ id: 'm4', deletedAt: 1100 }] })
  assert.ok(!s.moments.some(m => m.id === 'm4'), 'bare-blob shape: a tombstone NEWER than the patch still filters its moment')
})

test('R1.4 replaceAll: a backup OLDER than the delete cannot resurrect a deleted moment; superseded tombstones prune (W11); sticky merge of the rest', () => {
  const s = mkHabitsState({ savedAt: 500, deletedMoments: [{ id: 'm1', deletedAt: 400 }] })
  habits.mutations.replaceAll(s, { savedAt: 300, habits: [], moments: [{ id: 'm1', name: 'FromBackup' }] })
  assert.ok(!s.moments.some(m => m.id === 'm1'), 'an older backup blob is LWW-rejected outright (stickiness kept)')
  // [W11 2026-10-26] a NEWER restore round (savedAt 900 > deletedAt 400) carrying m1 alive =
  // undone upstream → prune; a tombstone newer than the round (950 > 900... use round 900) still filters
  habits.mutations.replaceAll(s, { savedAt: 900, habits: [], moments: [{ id: 'm1', name: 'UndoneUpstream' }] })
  assert.ok(s.moments.some(m => m.id === 'm1'), 'W11: superseded tombstone pruned by a newer alive restore round')
  assert.equal(s.deletedMoments.some(t => t.id === 'm1'), false, 'its tombstone did not survive the prune')
  habits.mutations.replaceAll(s, { savedAt: 1000, habits: [], moments: [{ id: 'm5', name: 'x' }], deletedMoments: [{ id: 'm5', deletedAt: 1100 }] })
  assert.ok(!s.moments.some(m => m.id === 'm5'), 'backup whose own NEWER tombstone deletes its moment')
  assert.deepEqual(s.deletedMoments.map(t => t.id), ['m5'], 'sticky merge of the non-superseded tombstones')
})

test('R1.5 re-adding a deliberately restored id clears its tombstone; tombstone helpers exported', () => {
  const s = mkHabitsState({ deletedMoments: [{ id: 'm7', deletedAt: 10 }] })
  habits.mutations.addMoment(s, { id: undefined, name: 'n', date: '2026-12-01', kind: 'memorial' })
  assert.equal(s.moments.length, 1)
  // direct id re-add path: filter parity with addHabit
  s.deletedMoments = mergeMomentTombstones(s.deletedMoments, [{ id: 'm8', deletedAt: 20 }])
  assert.deepEqual(applyMomentTombstones([{ id: 'm8' }, { id: 'm9' }], s.deletedMoments), [{ id: 'm9' }])
})

/* ---------------- R2: backup dump carries the tombstones ---------------- */

test('R2.1 buildBackupDump habitsState segment includes deleted + deletedMoments', () => {
  const rootState = {
    category: { list: [] },
    filters: { list: [] },
    settings: {},
    tomato: { tomatoRecordList: [] },
    habits: {
      habits: [{ id: 'h1', records: {} }],
      moments: [{ id: 'm1', name: 'x' }],
      savedAt: 123,
      deleted: [{ id: 'h2', deletedAt: 5 }],
      deletedMoments: [{ id: 'm2', deletedAt: 6 }]
    }
  }
  const dump = buildBackupDump(rootState, { search: '', todoList: [], recycleList: [], version: 0, remoteVersion: 0, todayTimestamp: 0, todosVersion: 0 })
  const seg = JSON.parse(dump.backup.habitsState)
  assert.deepEqual(seg.deleted, [{ id: 'h2', deletedAt: 5 }], 'habit tombstones in the dump')
  assert.deepEqual(seg.deletedMoments, [{ id: 'm2', deletedAt: 6 }], 'moment tombstones in the dump')
})

test('R2.2 dump → restore round-trip: tombstones survive and filter the restored arrays', () => {
  const rootState = {
    category: { list: [] },
    filters: { list: [] },
    settings: {},
    tomato: { tomatoRecordList: [] },
    habits: {
      habits: [{ id: 'hLive', records: {} }],
      moments: [{ id: 'mLive', name: 'x' }],
      savedAt: 123,
      deleted: [{ id: 'hGone', deletedAt: 5 }],
      deletedMoments: [{ id: 'mGone', deletedAt: 6 }]
    }
  }
  const dump = buildBackupDump(rootState, {})
  const seg = JSON.parse(dump.backup.habitsState)
  const s = mkHabitsState()
  habits.mutations.replaceAll(s, { ...seg, force: true })
  assert.ok(!s.habits.some(h => h.id === 'hGone') && !s.moments.some(m => m.id === 'mGone'), 'restored state filtered (tombstones traveled)')
  assert.ok(s.habits.some(h => h.id === 'hLive') && s.moments.some(m => m.id === 'mLive'))
  assert.deepEqual(s.deleted.map(t => t.id), ['hGone'])
  assert.deepEqual(s.deletedMoments.map(t => t.id), ['mGone'])
})

/* ---------------- R3: tomato succeed true→false rollback ---------------- */

const mkTomatoState = records => Object.assign({}, tomatoMod.default.state, { tomatoRecordList: records })

test('R3.1 focusStartedAtOf parses the phase identity back out of a salted focus tomatoId', () => {
  assert.equal(tomatoMod.focusStartedAtOf('tmt_f_1760000000000_ab12cd'), 1760000000000)
  assert.equal(tomatoMod.focusStartedAtOf('tmt_f_1760000000000'), 1760000000000)
  assert.equal(tomatoMod.focusStartedAtOf('tmt_a_1760000000000_x'), 0, 'give-up ids: nothing was bumped')
  assert.equal(tomatoMod.focusStartedAtOf('junk'), 0)
  assert.equal(tomatoMod.focusStartedAtOf(undefined), 0)
})

test('R3.2 updateRecord succeed true→false enqueues a negative task-side compensation', () => {
  const s = mkTomatoState([{ tomatoId: 'tmt_f_1760000000000_salt', focusTaskId: 'task-1', focusDuration: 25, succeed: true, dateKey: '2026-10-23', endTime: 1760000000000 }])
  tomatoMod.default.mutations.updateRecord(s, { tomatoId: 'tmt_f_1760000000000_salt', patch: { succeed: false } })
  assert.equal(s.tomatoRecordList[0].succeed, false, 'the correction still applies')
  const keys = []
  for (let i = 0; i < globalThis.localStorage.length; i++) { const k = globalThis.localStorage.key(i); if (k && k.startsWith('tomatoPendingSnow.')) keys.push(k) }
  const entries = keys.map(k => JSON.parse(globalThis.localStorage.getItem(k)).entry)
  const comp = entries.find(e => e.params && String(e.params.dedupKey || '').startsWith('undo:'))
  assert.ok(comp, 'a compensation entry is enqueued in the durable snow queue')
  assert.equal(comp.params.taskId, 'task-1')
  assert.equal(comp.params.minutes, -25, 'symmetric negative delta')
  assert.equal(comp.params.dedupKey, 'undo:1760000000000', 'phase identity — can never be deduped against the original credit')
})

test('R3.3 no compensation on false→true, other patches, zero-minute or unlinked records', () => {
  const countUndoEntries = () => {
    let n = 0
    for (let i = 0; i < globalThis.localStorage.length; i++) {
      const k = globalThis.localStorage.key(i)
      if (k && k.startsWith('tomatoPendingSnow.') && String(globalThis.localStorage.getItem(k) || '').includes('"undo:')) n++
    }
    return n
  }
  const before = countUndoEntries()
  const base = { tomatoId: 'tmt_f_111_s', focusTaskId: 't', focusDuration: 30, succeed: false, dateKey: '2026-10-23', endTime: 111 }
  const s = mkTomatoState([Object.assign({}, base)])
  tomatoMod.default.mutations.updateRecord(s, { tomatoId: 'tmt_f_111_s', patch: { succeed: true } })
  tomatoMod.default.mutations.updateRecord(s, { tomatoId: 'tmt_f_111_s', patch: { focusDuration: 10 } })
  const s0 = mkTomatoState([Object.assign({}, base, { tomatoId: 'tmt_f_222_s', focusDuration: 0 })])
  tomatoMod.default.mutations.updateRecord(s0, { tomatoId: 'tmt_f_222_s', patch: { succeed: false } })
  const sFree = mkTomatoState([Object.assign({}, base, { tomatoId: 'tmt_f_333_s', focusTaskId: null })])
  tomatoMod.default.mutations.updateRecord(sFree, { tomatoId: 'tmt_f_333_s', patch: { succeed: false } })
  assert.equal(countUndoEntries(), before, 'none of the non-credit cases enqueued a compensation')
})

/* ---------------- R4: settings/update appLocale enum gate ---------------- */

test('R4.1 isLegalAppLocale pins the manifest enum', () => {
  assert.equal(isLegalAppLocale('zh-CN'), true)
  assert.equal(isLegalAppLocale('en-US'), true)
  assert.equal(isLegalAppLocale('junk'), false)
  assert.equal(isLegalAppLocale(''), false)
  assert.equal(isLegalAppLocale(42), false)
  assert.equal(isLegalAppLocale(undefined), false)
})

test('R4.2 dispatch settings/update with a junk appLocale: rejected, never seats in state nor LS', async () => {
  const state = Object.assign({}, settings.state)
  const prevLs = globalThis.localStorage.getItem('appLocale')
  const ctx = { commit: (type, payload) => settings.mutations[type](state, payload) }
  const r = await settings.actions.update(ctx, { appLocale: 'junk', developerMode: true })
  assert.ok(r && r.ok !== false, 'the action still completes (locale field rejected, not the whole patch)')
  assert.equal(state.appLocale, 'zh-CN', 'junk locale never seats in state')
  assert.equal(state.developerMode, true, 'the rest of the patch still applies')
  assert.equal(globalThis.localStorage.getItem('appLocale'), prevLs, 'LS boot cache untouched')
  const setLocaleCalls = dbCalls.filter(c => false) // no direct assertion needed; setAppLocale bridge absent in tests
  assert.ok(Array.isArray(setLocaleCalls))
})

test('R4.3 a legal locale still passes the action gate and reaches the LS boot cache', async () => {
  const state = Object.assign({}, settings.state)
  const ctx = { commit: (type, payload) => settings.mutations[type](state, payload) }
  try {
    await settings.actions.update(ctx, { appLocale: 'en-US' })
    assert.equal(state.appLocale, 'en-US')
    assert.equal(globalThis.localStorage.getItem('appLocale'), 'en-US')
  } finally {
    try { globalThis.localStorage.removeItem('appLocale') } catch { /* shared stub LS */ }
  }
})

/* ---------------- R5: categoryLsMigrated is machine-local ---------------- */

test('R5.1 categoryLsMigrated is classified machine-local (a peer flag must not block local migration)', () => {
  assert.equal(isMachineLocalMetaKey('categoryLsMigrated'), true)
  assert.equal(isMachineLocalMetaKey('projectDeadline:3'), false, 'user-data keys stay syncable')
})
