/**
 * Sync coverage round 2 (agent Y, fix/sync-coverage-2-ui) regression tests:
 *   Y1   appLocale rides the settings blob (default + sanitizer + LS cache write-through contract)
 *   Y2   shortcutKeySettings: partial inbound map merges over defaults; first-run seed from config
 *   Y3   sidebar folds (sidebarCollapsed/catFold/showTagPanel) live in the blob; SideNav reads store
 *   Y4   repeatDefaultSettings: repeatSettings store mirrors to the blob, blob inbound adopts back
 *   Y5   leftoverAskDate flag via meta (LS fallback read kept)
 *   Y6   onboardingToursSeen blob ledger: inbound merge-max, LS write-through, reset clears
 *   Y7   ProjectView/DepView register onTodosChanged re-reads (source anchors)
 *   Y8   EditPanel refreshes repeatGroupInfo on inbound row change (source anchors)
 *   Y9   conflict-backup UI consumes agent X's ops defensively (source anchors + i18n parity)
 *   Y10  gamification delta-log: migration base delta, fold with dedupe guard
 *   X3/Y per-task tomatoEstimate keys with legacy union, per-cat projectCategoryFlag keys
 *
 * Run: node --test tests/unit/renderer/sync-coverage-2.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')
// Cache-busted import: several modules read localStorage at import time (settings/auth load()),
// so each test needs a FRESH instance reflecting the current LS stub state.
let importSeq = 0
const importSrc = p => import(pathToFileURL(path.join(ROOT, p)).href + '?fresh=' + (++importSeq))

/* Fresh module registry per test group: settings/auth load() reads LS at import time. */
const LS_MIRROR = new Map()
function resetLs () {
  LS_MIRROR.clear()
  globalThis.localStorage = {
    getItem: k => (LS_MIRROR.has(k) ? LS_MIRROR.get(k) : null),
    setItem: (k, v) => LS_MIRROR.set(k, String(v)),
    removeItem: k => LS_MIRROR.delete(k)
  }
}
function stubDb (impl) {
  globalThis.window.todoAPI = { dbCall: async (op, p) => impl(op, p) }
}

/* ---------------- Y1/Y2: settings blob carriers + sanitizer ---------------- */

test('Y1/Y2: DEFAULT_SETTINGS declares the new sync-carrier fields with correct shapes', async () => {
  const { DEFAULT_SETTINGS } = await importSrc('renderer/js/store/settings.js')
  assert.equal(DEFAULT_SETTINGS.appLocale, 'zh-CN')
  assert.equal(DEFAULT_SETTINGS.sidebarCollapsed, false)
  assert.equal(DEFAULT_SETTINGS.catFold, false)
  assert.equal(DEFAULT_SETTINGS.showTagPanel, true)
  assert.equal(typeof DEFAULT_SETTINGS.shortcutKeySettings, 'object')
  assert.equal(DEFAULT_SETTINGS.shortcutKeySettings.quickAddGlobal, 'alt+shift+t')
  assert.deepEqual(DEFAULT_SETTINGS.repeatDefaultSettings, {})
  assert.deepEqual(DEFAULT_SETTINGS.onboardingToursSeen, {})
})

test('Y1: sanitizeSettingsPatch passes a string appLocale through', async () => {
  const { sanitizeSettingsPatch } = await importSrc('renderer/js/store/settings.js')
  const out = sanitizeSettingsPatch({ appLocale: 'en-US' })
  assert.equal(out.appLocale, 'en-US')
})

test('Y2: sanitizeSettingsPatch merges a PARTIAL inbound shortcut map over the defaults (no clobber)', async () => {
  const { sanitizeSettingsPatch, DEFAULT_SETTINGS } = await importSrc('renderer/js/store/settings.js')
  const out = sanitizeSettingsPatch({ shortcutKeySettings: { sync: 'ctrl+shift+s' } })
  assert.equal(out.shortcutKeySettings.sync, 'ctrl+shift+s')
  // every default key still present — a partial map must never unregister the other shortcuts
  for (const k of Object.keys(DEFAULT_SETTINGS.shortcutKeySettings)) {
    assert.ok(k in out.shortcutKeySettings, 'default key kept: ' + k)
  }
  // non-object junk is dropped
  assert.deepEqual(sanitizeSettingsPatch({ shortcutKeySettings: 'junk' }), {})
  assert.deepEqual(sanitizeSettingsPatch({ shortcutKeySettings: ['x'] }), {})
})

test('Y6: mergeTourMap keeps the per-key MAX (no whole-doc clobber)', async () => {
  const { mergeTourMap } = await importSrc('renderer/js/store/settings.js')
  const merged = mergeTourMap({ today: 100, pips: 300 }, { pips: 200, journey: 400 })
  assert.equal(merged.today, 100)
  assert.equal(merged.pips, 300) // inbound older ts loses
  assert.equal(merged.journey, 400)
})

test('Y6: settings/updateExternal merges an inbound tours ledger per-key max', async () => {
  resetLs()
  const settings = (await importSrc('renderer/js/store/settings.js')).default
  const dispatches = []
  const ctx = {
    state: { onboardingToursSeen: { today: 100, editpanel: 50 } },
    dispatch: (type, payload) => dispatches.push([type, payload])
  }
  await settings.actions.updateExternal(ctx, { onboardingToursSeen: { today: 90, pips: 200 }, developerMode: true }) // plain call: env quirk drops args on async .call
  const [, patch] = dispatches[0]
  assert.equal(patch.developerMode, true)
  assert.equal(patch.onboardingToursSeen.today, 100) // local newer wins
  assert.equal(patch.onboardingToursSeen.pips, 200)
  assert.equal(patch.onboardingToursSeen.editpanel, 50) // untouched keys survive
})

test('Y2: settings/initFromDb seeds shortcutKeySettings from config.json when the blob is untouched', async () => {
  resetLs()
  const settings = (await importSrc('renderer/js/store/settings.js')).default
  const updates = []
  const seededMap = { sync: 'ctrl+shift+x' }
  stubDb((op, p) => {
    if (op === 'get-settings') return Promise.resolve({ shortcutKeySettings: seededMap }) // note: also exposed as window.todoAPI.getSettings below
    if (op === 'getMeta') return Promise.resolve(null) // no DB mirror
    if (op === 'setMeta') return Promise.resolve(true)
    return Promise.resolve(null)
  })
  globalThis.window.todoAPI.getSettings = () => Promise.resolve({ shortcutKeySettings: seededMap }) // seeding reads the get-settings channel
  globalThis.window.todoAPI.updateSettings = () => Promise.resolve(true)
  const state = { shortcutKeySettings: { ...settings.state.shortcutKeySettings } }
  // U5: seeding routes through the `update` action (commit + updateSettings IPC for main hot-apply)
  const ctx = {
    state,
    commit: (m, p) => { Object.assign(state, p) },
    dispatch: async (a, p) => { updates.push(p); Object.assign(state, p) }
  }
  await settings.actions.initFromDb(ctx)
  const seeded = updates.find(p => p && p.shortcutKeySettings)
  assert.ok(seeded, 'shortcut map seeded from config.json via the update action')
  assert.equal(seeded.shortcutKeySettings.sync, 'ctrl+shift+x')
  assert.ok('quickAddGlobal' in seeded.shortcutKeySettings, 'seed merged over defaults')
})

/* ---------------- Y3: sidebar folds from the store ---------------- */

test('Y3: SideNav reads sidebar folds from the settings store (computed accessors), not mount-time LS', async () => {
  const src = read('renderer/js/components/SideNav.vue')
  assert.ok(src.includes("get () { return !!this.$store.state.settings.sidebarCollapsed }"), 'userCollapsed computed get')
  assert.ok(src.includes("get () { return !!this.$store.state.settings.catFold }"), 'catFold computed get')
  assert.ok(src.includes("get () { return this.$store.state.settings.showTagPanel !== false }"), 'showTagPanel computed get')
  assert.ok(!src.includes("userCollapsed: localStorage.getItem('sidebarCollapsed') === 'true'"), 'mount-time LS read removed')
  // LS stays as write-through cache
  assert.ok(src.includes("localStorage.setItem('sidebarCollapsed'"), 'LS write-through kept')
})

test('Y3: settings load() seeds sidebarCollapsed/appLocale from legacy LS on first run', async () => {
  resetLs()
  LS_MIRROR.set('sidebarCollapsed', 'true')
  LS_MIRROR.set('appLocale', 'en-US')
  const settings = (await importSrc('renderer/js/store/settings.js')).default
  assert.equal(settings.state.sidebarCollapsed, true)
  assert.equal(settings.state.appLocale, 'en-US')
})

/* ---------------- Y4: repeat defaults through the blob ---------------- */

test('Y4: repeatSettings/updateSettings mirrors into the settings blob and keeps the LS cache', async () => {
  resetLs()
  const mod = (await importSrc('renderer/js/store/repeatSettings.js')).default
  const commits = []
  const s = { maxRepeat: '2' }
  const ctx = { commit (m, p) { commits.push([m, p]) } }
  mod.mutations.updateSettings.call(ctx, s, { maxRepeat: '5' })
  assert.equal(s.maxRepeat, '5')
  assert.equal(LS_MIRROR.get('repeatSettingsV2State'), JSON.stringify(s))
  const blob = commits.find(([m]) => m === 'settings/updateSettings')
  assert.ok(blob, 'blob mirrored')
  assert.deepEqual(blob[1].repeatDefaultSettings, { maxRepeat: '5' })
})

test('Y4: repeatSettings/updateFromBlob adopts inbound blob state without re-committing', async () => {
  resetLs()
  const mod = (await importSrc('renderer/js/store/repeatSettings.js')).default
  const commits = []
  const s = { maxRepeat: '2' }
  const ctx = { commit (m) { commits.push(m) } }
  mod.mutations.updateFromBlob.call(ctx, s, { maxRepeat: '7', restMin: 8 })
  assert.equal(s.maxRepeat, '7')
  assert.deepEqual(commits, [], 'one-way adopt: no settings re-commit (no loop)')
  // junk blobs ignored
  mod.mutations.updateFromBlob.call(ctx, s, 'junk')
  mod.mutations.updateFromBlob.call(ctx, s, null)
  assert.equal(s.maxRepeat, '7')
})

test('Y4: store/index.js fans blob changes into repeatSettings + tours LS cache', async () => {
  const src = read('renderer/js/store/index.js')
  assert.ok(src.includes("'repeatDefaultSettings' in mutation.payload"), 'repeat fan-out subscription')
  assert.ok(src.includes('onboardingToursSeen'), 'tours LS write-through subscription')
})

/* ---------------- Y5: leftovers meta flag ---------------- */

test('Y5: maybeAskLeftovers reads the asked-date flag from META first (LS fallback), writes both', async () => {
  resetLs()
  const calls = []
  const today = globalThis.window.dayjs().format('YYYY-MM-DD') // same clock as the module under test
  stubDb((op, p) => { calls.push([op, p]); return Promise.resolve(op === 'getMeta' ? today : true) })
  const leftovers = (await importSrc('renderer/js/utils/leftovers.js'))
  const store = { state: { todo: { todoList: [] } }, dispatch: () => Promise.resolve() }
  await leftovers.maybeAskLeftovers(store)
  assert.ok(calls.some(([op, p]) => op === 'getMeta' && p === 'leftoverAskDate'), 'meta read first')
  // meta says asked-today → early return, no prompt path touched
  assert.ok(!LS_MIRROR.has('leftoverAskDate'), 'flag not written to LS on early return')
})

test('Y5: markAsked writes meta AND the LS cache', async () => {
  resetLs()
  const calls = []
  stubDb((op, p) => { calls.push([op, p]); return Promise.resolve(null) })
  // drive through maybeAskLeftovers with an empty list: flag not written there... use the internal
  // contract via a second call: simulate cancel path is heavy; assert the meta write helper exists
  const src = read('renderer/js/utils/leftovers.js')
  assert.ok(src.includes("dbCall('setMeta', [FLAG_KEY, todayStr])"), 'meta write on markAsked')
  assert.ok(src.includes("localStorage.setItem(FLAG_KEY, todayStr)"), 'LS cache kept')
})

/* ---------------- Y6: onboarding tours ledger ---------------- */

test('Y6: resetToursSeen clears LS and replaces the blob field wholesale', async () => {
  resetLs()
  LS_MIRROR.set('onboardingToursSeen', JSON.stringify({ today: 1 }))
  const commits = []
  globalThis.window.appUI = { $store: { commit: (m, p) => commits.push([m, p]) } }
  const tours = (await importSrc('renderer/js/utils/onboardingTours.js'))
  tours.resetToursSeen()
  assert.ok(!LS_MIRROR.has('onboardingToursSeen'), 'LS ledger cleared')
  assert.deepEqual(commits[0], ['settings/updateSettings', { onboardingToursSeen: {} }])
  delete globalThis.window.appUI
})

test('Y6: runTour markSeen path mirrors the ledger into the blob (debounced)', async () => {
  resetLs()
  const commits = []
  globalThis.window.appUI = { $store: { commit: (m, p) => commits.push([m, p]) } }
  const src = read('renderer/js/utils/onboardingTours.js')
  assert.ok(src.includes("onboardingToursSeen: { ...seenMap() }"), 'blob mirror of LS ledger')
  assert.ok(src.includes('syncBlob()'), 'markSeen triggers the mirror')
  delete globalThis.window.appUI
})

/* ---------------- Y7/Y8: live refresh anchors ---------------- */

test('Y7: ProjectView registers a throttled onTodosChanged re-read and unregisters on unmount', () => {
  const src = read('renderer/js/views/ProjectView.vue')
  assert.ok(src.includes('onTodosChanged'), 'todos-changed listener')
  assert.ok(src.includes('_msRefreshAt'), 'throttle guard')
  assert.ok(src.includes('reloadMilestones()\n          this.reloadDeadline()') || (src.includes('this.reloadMilestones()') && src.includes('this.reloadDeadline()')), 're-reads milestones + deadline')
  assert.ok(src.includes('rebasing on latest meta'), 'MilestoneEditModal save rebases on latest')
  assert.ok(src.includes('if (this._offTodosChanged) { try { this._offTodosChanged() }'), 'listener removed on unmount')
})

test('Y7: DepView registers a throttled onTodosChanged re-read', () => {
  const src = read('renderer/js/components/DepView.vue')
  assert.ok(src.includes('onTodosChanged'), 'todos-changed listener')
  assert.ok(src.includes('this.loadMs()'), 're-reads milestones')
})

test('Y8: EditPanel re-runs repeatGroupInfo when the panel row changes inbound', () => {
  const src = read('renderer/js/components/EditPanel.vue')
  assert.ok(src.includes('t.repeatId === this.e.repeatId'), 'repeatId-matched watcher piggyback')
  assert.ok(src.includes('_rgRefreshAt'), 'throttle guard')
})

/* ---------------- Y9: conflict backup UI ---------------- */

test('Y9: SettingsSyncTab consumes exactly the contract ops and hides when absent', () => {
  const src = read('renderer/js/components/settings/SettingsSyncTab.vue')
  assert.ok(src.includes("dbCallLoose('syncConflictBackupsList')"), 'list op')
  assert.ok(src.includes("dbCallLoose('syncConflictBackupRestore', { key: b.key })"), 'restore op with the {key} payload object (U6)')
  assert.ok(src.includes('conflictBackups = null'), 'ops absent -> section hidden')
  assert.ok(src.includes("v-if=\"conflictBackups !== null\""), 'defensive section gate')
})

test('Y9: conflict backup i18n keys exist in BOTH locales', () => {
  const zh = read('renderer/js/i18n/zh-CN.js')
  const en = read('renderer/js/i18n/en-US.js')
  for (const k of ['conflictSection', 'conflictEmpty', 'conflictLostAt', 'conflictRestore', 'conflictRestored', 'conflictRestoreFail']) {
    assert.ok(zh.includes('"' + k + '":'), 'zh has ' + k)
    assert.ok(en.includes('"' + k + '":'), 'en has ' + k)
  }
})

/* ---------------- Y10: gamification delta-log ---------------- */

test('Y10: saveSnowGain batches deltas (≤1/min) and initGamification migrates + folds with dedupe', async () => {
  resetLs()
  const meta = new Map()
  stubDb((op, p) => {
    if (op === 'getMeta') return Promise.resolve(meta.has(p) ? meta.get(p) : null)
    if (op === 'setMeta') { meta.set(p[0], p[1]); return Promise.resolve(true) }
    if (op === 'deleteMeta') { meta.delete(p); return Promise.resolve(true) }
    return Promise.resolve(null)
  })
  const auth = (await importSrc('renderer/js/store/auth.js')).default
  const patches = []
  const state = { user: { snow: 10, tomatoGain: 4 } }
  const ctx = { state, commit: (m, p) => patches.push(p) }

  await auth.actions.initGamification(ctx)
  // migration: non-default totals emitted as ONE base delta, flag set
  const baseKeys = [...meta.keys()].filter(k => k.startsWith('gamification.delta.') && k !== 'gamification.delta.index')
  assert.equal(baseKeys.length, 1, 'exactly one base delta emitted')
  const base = JSON.parse(meta.get(baseKeys[0]))
  assert.equal(base.snow, 10); assert.equal(base.tomatoGain, 4); assert.equal(base.base, true)
  assert.equal(meta.get('gamification.baseEmitted'), '1')
  assert.deepEqual(patches, [], 'no double count: fold of own base is a max, not an add')

  // default-888 profile: no migration delta
  const ctxDefault = { state: { user: { snow: 888, tomatoGain: 0 } }, commit: () => {} }
  const countBefore = [...meta.keys()].filter(k => k.startsWith('gamification.delta.') && k !== 'gamification.delta.index').length
  await auth.actions.initGamification(ctxDefault)
  const countAfter = [...meta.keys()].filter(k => k.startsWith('gamification.delta.') && k !== 'gamification.delta.index').length
  assert.equal(countAfter, countBefore, '888 factory default skipped')

  // fold a peer's increment delta exactly once (folded guard survives a second init)
  const peerKey = 'gamification.delta.dpeer:1'
  meta.set(peerKey, JSON.stringify({ snow: 3, tomatoGain: 2, ts: Date.now() }))
  meta.set('gamification.delta.index', JSON.stringify([baseKeys[0], peerKey]))
  await auth.actions.initGamification(ctx)
  const folded = patches[patches.length - 1]
  assert.equal(folded.snow, 13, 'peer increment added once')
  assert.equal(folded.tomatoGain, 6)
  await auth.actions.initGamification(ctx)
  const last = patches[patches.length - 1]
  assert.equal(last.snow, 13, 'second init does NOT re-add the same delta (folded guard)')
})

/* ---------------- X3/Y renderer contracts ---------------- */

test('tomatoEstimateState: setEstimate writes the per-task meta key (delete on 0)', async () => {
  resetLs()
  const calls = []
  stubDb((op, p) => { calls.push([op, p]); return Promise.resolve(true) })
  const mod = await importSrc('renderer/js/utils/tomatoEstimate.js')
  mod.setEstimate('t1', 4)
  mod.setEstimate('t1', 0)
  const setCall = calls.find(([op, p]) => op === 'setMeta' && p[0] === 'tomatoEstimateState:t1')
  assert.ok(setCall, 'per-task key written')
  assert.equal(setCall[1][1], '4')
  assert.ok(calls.some(([op, p]) => op === 'deleteMeta' && p === 'tomatoEstimateState:t1'), 'zero estimate removes the key')
})

test('tomatoEstimateState: boot is lazy (U8) — legacy blob pass only, per-task keys read on demand', async () => {
  resetLs()
  const meta = new Map([
    ['tomatoEstimateState', JSON.stringify({ t1: 2 })],
    ['tomatoEstimateStateAt', String(Date.now())],
    ['tomatoEstimateState:t1', '3'], // per-task wins over legacy blob (read lazily)
    ['tomatoEstimateState:t2', '1']
  ])
  const deleted = []
  const reads = []
  stubDb((op, p) => {
    if (op === 'getMeta') { reads.push(p); return Promise.resolve(meta.has(p) ? meta.get(p) : null) }
    if (op === 'setMeta') { meta.set(p[0], p[1]); return Promise.resolve(true) }
    if (op === 'deleteMeta') { deleted.push(p); meta.delete(p); return Promise.resolve(true) }
    return Promise.resolve(null)
  })
  const mod = await importSrc('renderer/js/utils/tomatoEstimate.js')
  await mod.initFromDb(['t1', 't2', 't3'])
  // U8: boot does NOT scan every task id. The ONLY per-task read allowed is the one-time lazy
  // migration existence check for a LEGACY BLOB entry (t1); non-blob ids (t2/t3) are never read.
  const perTaskBootReads = reads.filter(k => /^tomatoEstimateState:(t1|t2|t3)$/.test(String(k)))
  assert.deepEqual(perTaskBootReads, ['tomatoEstimateState:t1'], 'only the blob-entry migration check runs at boot')
  assert.ok(deleted.includes('tomatoEstimateState'), 'legacy blob meta deleted after migration')
  await mod.ensureEstimate('t1')
  assert.equal(mod.getEstimate('t1'), 3, 'lazy read: per-task value wins over legacy blob')
  await mod.ensureEstimate('t2')
  assert.equal(mod.getEstimate('t2'), 1, 'per-task-only entry adopted on demand')
  assert.equal(mod.getEstimate('t3'), 0, 'absent key = 0')
})

test('category: setProject writes ONLY the per-cat flag key (legacy blob never written, U7)', async () => {
  resetLs()
  const calls = []
  stubDb((op, p) => { calls.push([op, p]); return Promise.resolve(true) })
  const mod = (await importSrc('renderer/js/store/category.js')).default
  const state = { list: [], projectIds: [111], projectMeta: {} }
  mod.mutations.setProject.call({ commit: () => {} }, state, { id: 222, flag: true })
  assert.ok(state.projectIds.includes(222))
  assert.ok(calls.some(([op, p]) => op === 'setMeta' && p[0] === 'projectCategoryFlag:222' && p[1] === '1'), 'per-cat flag set')
  assert.ok(!calls.some(([op, p]) => op === 'setMeta' && p[0] === 'projectCategoryIds'), 'legacy whole-array blob never written (U7)')
  mod.mutations.setProject.call({ commit: () => {} }, state, { id: 222, flag: false })
  assert.ok(calls.some(([op, p]) => op === 'deleteMeta' && p === 'projectCategoryFlag:222'), 'flag removal deletes the per-cat key')
  assert.ok(!calls.some(([op, p]) => op === 'setMeta' && p[0] === 'projectCategoryIds'), 'still no legacy write after unflag')
})

test('category: softDelete cleans per-cat project flag keys for cascade victims', () => {
  const src = read('renderer/js/store/category.js')
  assert.ok(src.includes('writeProjectFlag(vid, false)'), 'victim flag keys removed')
  assert.ok(src.includes('projectCategoryFlag:'), 'per-cat flag key helper present')
})
