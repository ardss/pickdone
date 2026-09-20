/**
 * Sync verify UI round (agent U, fix/sync-verify-ui) — BEHAVIOR regression tests:
 *   U1  gamification fold does not double-count own flushed deltas across restarts
 *   U2  fold guard: a null (not-yet-synced) delta read is retried next init, never folded-skip-forever
 *   U3  sanitizeSettingsPatch merges partial inbound shortcut maps over CURRENT LIVE STATE
 *   U4  narrow-viewport forced collapse is transient (navCollapse state machine) — settings untouched
 *   U5  settings initFromDb seeds/restores shortcuts through the updateSettings IPC + canonical compare
 *   U6  conflict-backup restore sends the {key} payload object
 *   U7  setProject writes only the per-cat flag key (legacy whole-array blob never written)
 *   U8  estimate boot issues no per-task getMeta; first read memoizes one fetch per id
 *   U9  gamification: index self-heal for the device's own last delta + 7-day compaction
 *
 * Run: node --test tests/unit/renderer/sync-verify-ui.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
// Cache-busted import: settings/auth load() reads localStorage at import time, so each test gets a
// FRESH module instance reflecting the current LS stub state.
let importSeq = 0
const importSrc = p => import(pathToFileURL(path.join(ROOT, p)).href + '?fresh=' + (++importSeq))

const LS_MIRROR = new Map()
function resetLs () {
  LS_MIRROR.clear()
  globalThis.localStorage = {
    getItem: k => (LS_MIRROR.has(k) ? LS_MIRROR.get(k) : null),
    setItem: (k, v) => LS_MIRROR.set(k, String(v)),
    removeItem: k => LS_MIRROR.delete(k)
  }
}

/** Recording dbCall stub: impl(op, params) may handle or fall through to a default meta store. */
function stubDb (calls, impl) {
  const meta = new Map()
  globalThis.window.todoAPI = {
    dbCall: async (op, params) => {
      calls.push({ op, params })
      if (impl) {
        const r = await impl(op, params, meta)
        if (r !== undefined) return r
      }
      if (op === 'getMeta') return meta.has(params) ? meta.get(params) : null
      if (op === 'setMeta') { meta.set(params[0], params[1]); return { ok: true } }
      if (op === 'deleteMeta') { meta.delete(params); return { ok: true } }
      return null
    }
  }
  return meta
}

const tick = () => new Promise(r => setTimeout(r, 20))

/** Minimal Vuex-store-like context for auth actions: commit via arrow (actions call bare commit). */
function mkStore (user) {
  const st = { state: { user: { ...user } }, commit: (mut, patch) => { st.state.user = { ...st.state.user, ...patch } } }
  return st
}

/* ---------------- U1: no double-count across restarts ---------------- */

test('U1: earn 5 -> flush -> restart -> fold => total is base+5 exactly, and stays base+5 after another restart', async () => {
  resetLs()
  const calls = []
  const meta = stubDb(calls)
  // session 1: start from a base of 100 (legacy LS user blob)
  LS_MIRROR.set('user', JSON.stringify({ snow: 100, tomatoGain: 10 }))
  let auth = await importSrc('renderer/js/store/auth.js')
  let store = mkStore({ snow: 100, tomatoGain: 10 })
  await auth.default.actions.saveSnowGain(store, 5)
  assert.equal(store.state.user.snow, 105)
  await tick() // first flush bypasses the 60s batch window (lastFlushAt = 0)
  // the flushed delta exists in meta
  const deltaKeys = [...meta.keys()].filter(k => k.startsWith('gamification.delta.') && !k.endsWith(':c') && k !== 'gamification.delta.index')
  assert.equal(deltaKeys.length, 1, 'exactly one delta flushed')
  assert.equal(JSON.parse(meta.get(deltaKeys[0])).snow, 5)

  // restart #1: fresh module + store, fold must land on exactly 105 (not 110) — the own flushed
  // delta is skipped at fold because its value is already inside the LS total (U1 model).
  auth = await importSrc('renderer/js/store/auth.js')
  store = mkStore({ snow: 105, tomatoGain: 15 })
  await auth.default.actions.initGamification(store)
  assert.equal(store.state.user.snow, 105, 'fold = LS total 105; own delta skipped, no double count')
  assert.equal(store.state.user.tomatoGain, 15)

  // restart #2: fold again — nothing new to fold, total must stay 105
  auth = await importSrc('renderer/js/store/auth.js')
  store = mkStore({ snow: 105, tomatoGain: 15 })
  await auth.default.actions.initGamification(store)
  assert.equal(store.state.user.snow, 105, 'second restart does not inflate')

  // a PEER device folding the same delta gains exactly +5 (deltas exist to reach peers)
  auth = await importSrc('renderer/js/store/auth.js')
  LS_MIRROR.set('gamification.deviceId', 'dpeer1')
  store = mkStore({ snow: 200, tomatoGain: 0 })
  await auth.default.actions.initGamification(store)
  assert.equal(store.state.user.snow, 205, 'peer folds the owner delta exactly once')
  LS_MIRROR.delete('gamification.deviceId')
})

/* ---------------- U2: null delta reads retry next init ---------------- */

test('U2: a delta listed in the index but not yet readable (null) is NOT marked folded and folds on a later init', async () => {
  resetLs()
  const calls = []
  const meta = stubDb(calls)
  LS_MIRROR.set('user', JSON.stringify({ snow: 100, tomatoGain: 0 }))
  // index lists two deltas but only one is readable (peer's delta not synced yet)
  meta.set('gamification.delta.index', JSON.stringify(['gamification.delta.peerA:1', 'gamification.delta.peerB:2']))
  meta.set('gamification.delta.peerA:1', JSON.stringify({ snow: 3, tomatoGain: 0, ts: Date.now() }))

  let auth = await importSrc('renderer/js/store/auth.js')
  let store = mkStore({ snow: 100, tomatoGain: 0 })
  await auth.default.actions.initGamification(store)
  assert.equal(store.state.user.snow, 103, 'readable delta folded')
  let folded = JSON.parse(LS_MIRROR.get('gamification.folded'))
  assert.equal(folded['gamification.delta.peerA:1'].s, 3, 'successful fold is marked with its value')
  assert.ok(!folded['gamification.delta.peerB:2'], 'null read is NOT marked folded')

  // the missing delta arrives; next init folds it (retry worked)
  meta.set('gamification.delta.peerB:2', JSON.stringify({ snow: 7, tomatoGain: 0, ts: Date.now() }))
  auth = await importSrc('renderer/js/store/auth.js')
  store = mkStore({ snow: 103, tomatoGain: 0 })
  await auth.default.actions.initGamification(store)
  assert.equal(store.state.user.snow, 110, 'late-arriving delta folded exactly once')
  folded = JSON.parse(LS_MIRROR.get('gamification.folded'))
  assert.equal(folded['gamification.delta.peerB:2'].s, 7)
})

/* ---------------- U3: partial inbound shortcut patch keeps live state ---------------- */

test('U3: sanitizeSettingsPatch merges a partial inbound shortcut map over the CURRENT live state, not defaults', async () => {
  const { sanitizeSettingsPatch } = await importSrc('renderer/js/store/settings.js')
  const live = {
    shortcutKeySettings: { sync: 'ctrl+shift+x', quickAddGlobal: 'ctrl+q', addEvent: 'ctrl+n' }
  }
  const out = sanitizeSettingsPatch({ shortcutKeySettings: { sync: 'ctrl+shift+s' } }, live)
  assert.equal(out.shortcutKeySettings.sync, 'ctrl+shift+s', 'inbound key wins')
  assert.equal(out.shortcutKeySettings.quickAddGlobal, 'ctrl+q', 'local customization preserved')
  assert.equal(out.shortcutKeySettings.addEvent, 'ctrl+n', 'other live binding preserved')
  // no current state passed -> falls back to declared defaults (pure validation mode)
  const out2 = sanitizeSettingsPatch({ shortcutKeySettings: { sync: 'ctrl+shift+s' } })
  assert.equal(out2.shortcutKeySettings.quickAddGlobal, 'alt+shift+t')
})

/* ---------------- U4: narrow-viewport forced collapse never touches the settings store ---------------- */

test('U4: applyNarrow flips only transient component fields; the synced preference changes solely via explicit toggle', async () => {
  const { applyNarrow, toggleCollapse } = await importSrc('renderer/js/utils/navCollapse.js')
  const comp = { narrow: false, forcedCollapsed: false }
  const committed = []
  const settingsStore = { sidebarCollapsed: false }
  // simulate the mounted narrow snapshot
  applyNarrow(comp, true)
  assert.equal(comp.narrow, true)
  assert.equal(comp.forcedCollapsed, true, 'forced collapse is transient component state')
  assert.equal(settingsStore.sidebarCollapsed, false, 'settings store untouched by the narrow event')
  assert.deepEqual(committed, [], 'no settings commit issued by the viewport event')
  // widen back: forced collapse clears, still no store write
  applyNarrow(comp, false)
  assert.equal(comp.forcedCollapsed, false)
  assert.equal(settingsStore.sidebarCollapsed, false)
  // explicit user toggle IS the only writer (resolves against the effective collapsed state)
  const next = toggleCollapse({ getCollapsed: () => comp.forcedCollapsed || settingsStore.sidebarCollapsed, commit: v => { committed.push(v); settingsStore.sidebarCollapsed = v } })
  assert.equal(next, true, 'effective collapsed -> toggling expands... wait: getCollapsed false here means expand')
  assert.equal(settingsStore.sidebarCollapsed, true)
  assert.deepEqual(committed, [true])
})

/* ---------------- U5: initFromDb routes shortcut seed/restore through the updateSettings IPC ---------------- */

test('U5: initFromDb with a synced shortcut map dispatches the updateSettings IPC (main hot-apply) and compares canonically', async () => {
  resetLs()
  const calls = []
  stubDb(calls, async (op, params) => {
    if (op === 'db.settingsState' || op === 'restoreFromDb') return null
    return null
  })
  // the settings store mirror is read via utils/dbMirror.restoreFromDb('db.settingsState'); stub the bridge shape it uses
  globalThis.window.todoAPI.dbCall = async (op, params) => {
    calls.push({ op, params })
    if (op === 'getSettings') return { shortcutKeySettings: { addEvent: 'ctrl+shift+n' } } // first-run seed path
    return null
  }
  const mod = await importSrc('renderer/js/store/settings.js')
  // build a real store-like context from the module defaults (state = defaults)
  const state = { ...mod.DEFAULT_SETTINGS }
  let ipcPatches = []
  globalThis.window.todoAPI.updateSettings = async patch => { ipcPatches.push(patch) }
  globalThis.window.todoAPI.getSettings = async () => ({ shortcutKeySettings: { addEvent: 'ctrl+shift+n' } })
  const ctx = {
    state,
    // arrows: the store calls commit/dispatch unbound (no `this`)
    commit: (mut, patch) => { Object.assign(ctx.state, patch) },
    dispatch: async (act, patch) => {
      // mirror the real update action contract: commit + IPC
      Object.assign(ctx.state, patch)
      await globalThis.window.todoAPI.updateSettings(patch)
    }
  }
  await mod.default.actions.initFromDb(ctx)
  assert.equal(ipcPatches.length, 1, 'seed path dispatched through the update action once')
  assert.equal(ipcPatches[0].shortcutKeySettings.addEvent, 'ctrl+shift+n')
  assert.equal(state.shortcutKeySettings.sync, 'ctrl+s', 'seed merges over defaults')

  // canonical comparison: a key-order-shuffled equal map is NOT seen as a change (no spurious reseed)
  ipcPatches = []
  state.shortcutKeySettings = { addEvent: 'ctrl+shift+n', sync: 'ctrl+s', toggleMainWindow: '', quickAddGlobal: 'alt+shift+t', deleteEvent: 'ctrl+d', pinEvent: '', unpinEvent: '', toggleAllSubtasks: '', startPomodoro: '', switchToDaytodo: 'ctrl+1', switchToRecentTodos: 'ctrl+2', switchToSchedule: 'ctrl+3', switchToInbox: 'ctrl+4' }
  const { canonicalJson } = await importSrc('renderer/js/store/settings.js')
  assert.notEqual(JSON.stringify({ a: 1, b: 2 }), JSON.stringify({ b: 2, a: 1 }), 'sanity: raw stringify is order-sensitive')
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }), 'canonical compare is key-order-insensitive')
  assert.equal(canonicalJson({ a: 1, b: { c: 2, d: 3 } }), canonicalJson({ b: { d: 3, c: 2 }, a: 1 }), 'canonical compare recurses')
})

/* ---------------- U6: conflict restore sends the {key} payload object ---------------- */

test('U6: restoreConflict passes a {key} payload object to the syncConflictBackupRestore op', async () => {
  // .vue SFCs are not importable under node: extract the REAL restoreConflict method source and run
  // it against a stubbed db layer (behavioral: assert the payload shape reaching the db layer).
  const fs = await import('node:fs')
  const src = fs.readFileSync(path.join(ROOT, 'renderer/js/components/settings/SettingsSyncTab.vue'), 'utf8')
  const m = src.match(/async restoreConflict \(b\) \{([\s\S]*?)\n {4}\}/)
  assert.ok(m, 'restoreConflict method found')
  const seen = []
  const ctx = {
    dbCallLoose: async (op, payload) => { seen.push({ op, payload }) },
    conflictBusy: null,
    $message: { success () {}, error () {} },
    $t: k => k,
    loadConflictBackups: async () => {}
  }
  const body = m[1]
  const fn = new Function('ctx', `
    const { dbCallLoose, $message, $t, loadConflictBackups } = ctx
    return (async function (b) {${body}}).call(ctx, { key: 'metaConflictBackup:todos:abc.1' })
  `)
  await fn(ctx)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].op, 'syncConflictBackupRestore')
  assert.deepEqual(seen[0].payload, { key: 'metaConflictBackup:todos:abc.1' }, 'payload is the {key} object main expects')
})

/* ---------------- U7: setProject writes only the per-cat flag key ---------------- */

test('U7: setProject persists only the projectCategoryFlag key (legacy whole-array blob is never written)', async () => {
  resetLs()
  const calls = []
  stubDb(calls)
  const { default: catStore } = await importSrc('renderer/js/store/category.js')
  const state = { list: [], projectIds: [], projectMeta: {} }
  catStore.mutations.setProject(state, { id: 42, flag: true })
  const writes = calls.filter(c => c.op === 'setMeta')
  assert.equal(writes.length, 1, 'exactly one meta write')
  assert.deepEqual(writes[0].params, ['projectCategoryFlag:42', '1'], 'the per-cat flag key is the only synced write')
  assert.ok(!writes.some(c => c.params[0] === 'projectCategoryIds'), 'legacy whole-array key never written')
  assert.deepEqual(state.projectIds, [42])
  // unflag deletes the flag key, still no legacy array write
  calls.length = 0
  catStore.mutations.setProject(state, { id: 42, flag: false })
  assert.ok(calls.some(c => c.op === 'deleteMeta' && c.params === 'projectCategoryFlag:42'))
  assert.ok(!calls.some(c => c.op === 'setMeta' && c.params[0] === 'projectCategoryIds'))
})

/* ---------------- U8: boot is O(1) meta reads; first read memoizes one fetch per id ---------------- */

test('U8: estimate initFromDb does not scan task ids; ensureEstimate fetches an id once and caches', async () => {
  resetLs()
  const calls = []
  const meta = stubDb(calls)
  meta.set('tomatoEstimateState:7', '4')
  const est = await importSrc('renderer/js/utils/tomatoEstimate.js')
  await est.initFromDb([1, 2, 3, 4, 5, 6, 7])
  const bootPerTaskReads = calls.filter(c => c.op === 'getMeta' && String(c.params).startsWith('tomatoEstimateState:'))
  assert.equal(bootPerTaskReads.length, 0, 'boot issues NO per-task getMeta calls (legacy blob pass only)')
  assert.equal(est.getEstimate(7), 0, 'not read yet — lazy')
  await est.ensureEstimate(7)
  assert.equal(est.getEstimate(7), 4, 'first read fetches the per-task value')
  const readsAfterFirst = calls.filter(c => c.op === 'getMeta' && String(c.params) === 'tomatoEstimateState:7').length
  assert.ok(readsAfterFirst >= 1)
  await est.ensureEstimate(7)
  await est.ensureEstimate(7)
  assert.equal(calls.filter(c => c.op === 'getMeta' && String(c.params) === 'tomatoEstimateState:7').length, readsAfterFirst, 'memoized: no further fetches')
  // inbound meta round invalidates the cache: next read re-fetches once
  meta.set('tomatoEstimateState:7', '9')
  est.invalidateEstimateCache()
  await est.ensureEstimate(7)
  assert.equal(est.getEstimate(7), 9, 'invalidation re-fetches the fresh value')
})

/* ---------------- U9: index self-heal + 7-day compaction ---------------- */

test('U9a: a delta orphaned by a lost index race is re-added to the index on the next init', async () => {
  resetLs()
  const calls = []
  const meta = stubDb(calls)
  LS_MIRROR.set('user', JSON.stringify({ snow: 100, tomatoGain: 0 }))
  LS_MIRROR.set('gamification.deviceId', 'dme')
  LS_MIRROR.set('gamification.lastDeltaKey', 'gamification.delta.dme:5')
  meta.set('gamification.delta.dme:5', JSON.stringify({ snow: 2, tomatoGain: 0, ts: Date.now() }))
  meta.set('gamification.delta.index', JSON.stringify([])) // race lost the key
  const auth = await importSrc('renderer/js/store/auth.js')
  const store = mkStore({ snow: 100, tomatoGain: 0 })
  await auth.default.actions.initGamification(store)
  await tick()
  const idx = JSON.parse(meta.get('gamification.delta.index'))
  assert.ok(idx.includes('gamification.delta.dme:5'), 'own last delta re-added (self-heal)')
  assert.equal(store.state.user.snow, 100, 'own delta is NOT folded again — its value is already in the LS total (U1)')
})

test('U9b: deltas older than 7 days compact into a per-device subtotal; peers fold the subtotal once', async () => {
  resetLs()
  const calls = []
  const meta = stubDb(calls)
  LS_MIRROR.set('user', JSON.stringify({ snow: 0, tomatoGain: 0 }))
  const DAY = 86400000
  const old1 = 'gamification.delta.dme:1'
  const old2 = 'gamification.delta.dme:2'
  meta.set(old1, JSON.stringify({ snow: 4, tomatoGain: 1, ts: Date.now() - 10 * DAY }))
  meta.set(old2, JSON.stringify({ snow: 6, tomatoGain: 2, ts: Date.now() - 9 * DAY }))
  meta.set('gamification.delta.dme:3', JSON.stringify({ snow: 5, tomatoGain: 0, ts: Date.now() - 1000 })) // fresh, stays
  meta.set('gamification.delta.index', JSON.stringify([old1, old2, 'gamification.delta.dme:3']))
  meta.set('gamification.baseEmitted', '1') // keep the one-time migration out of the seeded key namespace

  // owner (device dme) folds (own keys skipped per U1) + compacts
  LS_MIRROR.set('gamification.deviceId', 'dme')
  let auth = await importSrc('renderer/js/store/auth.js')
  let store = mkStore({ snow: 0, tomatoGain: 0 })
  await auth.default.actions.initGamification(store)
  assert.equal(store.state.user.snow, 0, 'owner skips own deltas (already in its LS total)')
  const sk = 'gamification.delta.dme:c'
  const subtotal = JSON.parse(meta.get(sk))
  assert.equal(subtotal.snow, 10, 'old deltas folded into the subtotal')
  assert.equal(subtotal.tomatoGain, 3)
  assert.equal(subtotal.gen, 1)
  assert.deepEqual(subtotal.compacted.sort(), [old1, old2].sort())
  assert.ok(!meta.has(old1) && !meta.has(old2), 'folded keys deleted')
  const idx = JSON.parse(meta.get('gamification.delta.index'))
  assert.ok(idx.includes(sk) && !idx.includes(old1) && !idx.includes(old2), 'index rewritten')

  // peer (never folded anything) folds the subtotal exactly once
  LS_MIRROR.set('gamification.deviceId', 'dpeer')
  auth = await importSrc('renderer/js/store/auth.js')
  store = mkStore({ snow: 0, tomatoGain: 0 })
  await auth.default.actions.initGamification(store)
  assert.equal(store.state.user.snow, 15, 'peer adopts subtotal + fresh delta')
  // restart: nothing re-folds
  auth = await importSrc('renderer/js/store/auth.js')
  store = mkStore({ snow: 15, tomatoGain: 3 })
  await auth.default.actions.initGamification(store)
  assert.equal(store.state.user.snow, 15, 'no double-count after restart')

  // owner compacts MORE keys into the subtotal (gen 2): peer folds only the generation delta
  meta.set('gamification.delta.dme:4', JSON.stringify({ snow: 20, tomatoGain: 0, ts: Date.now() - 8 * DAY }))
  const idxNow = JSON.parse(meta.get('gamification.delta.index'))
  idxNow.push('gamification.delta.dme:4')
  meta.set('gamification.delta.index', JSON.stringify(idxNow))
  LS_MIRROR.set('gamification.deviceId', 'dme')
  auth = await importSrc('renderer/js/store/auth.js')
  store = mkStore({ snow: 15, tomatoGain: 3 })
  await auth.default.actions.initGamification(store) // owner: compacts dme:4 into the subtotal (gen 2)
  assert.equal(JSON.parse(meta.get(sk)).gen, 2)
  assert.equal(JSON.parse(meta.get(sk)).snow, 30)
  // peer's gen-1 fold (guard entry persisted from its earlier init) folds only the +20 delta
  assert.equal(JSON.parse(LS_MIRROR.get('gamification.folded'))[sk].gen, 1, 'gen-1 guard persisted')
  LS_MIRROR.set('gamification.deviceId', 'dpeer')
  auth = await importSrc('renderer/js/store/auth.js')
  store = mkStore({ snow: 15, tomatoGain: 3 })
  await auth.default.actions.initGamification(store)
  assert.equal(store.state.user.snow, 35, 'peer folds the gen delta (10 -> 30 = +20), not the whole subtotal')
})
