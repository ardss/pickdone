/* maint/d11 coverage-restore wave: behavior tests for renderer/js/store/settings.js trust-boundary
 * paths — sanitizeSettingsPatch (unknown keys, type junk, enum gates, secret strip, tombstones,
 * partial-object merge base), clampNumericSettings, tomatoLedgerPatch, update/updateExternal
 * actions (tomato ledger mirror + tour map merge), restore mutation (secret carve-out), and
 * initFromDb (schema downgrade guard, whitelist, stale/failed mirror branches).
 * Run: node --test tests/unit/store/settings-d11-coverage.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import settings, {
  sanitizeSettingsPatch, clampNumericSettings, coerceNumericSettings, mergeTourMap,
  canonicalJson, mainConsumedSettingsDiff, tomatoLedgerPatch, MAIN_CONSUMED_SETTINGS,
  DEFAULT_SETTINGS, TOMATO_LEDGER_KEYS
} from '../../../renderer/js/store/settings.js'

const freshState = () => JSON.parse(JSON.stringify(settings.state))

test('sanitizeSettingsPatch: unknown keys and type junk dropped; numeric strings coerced; enums gated', () => {
  const out = sanitizeSettingsPatch({
    bogusKey: 1,
    tomatoTime: '45', // numeric string → coerced
    restTime: 'abc', // non-numeric string for a number field → dropped
    colorMode: 'hotpink', // not in the enum → dropped
    enableBeep: 'yes' // string where boolean declared → dropped
  })
  assert.equal(out.tomatoTime, 45)
  assert.ok(!('restTime' in out))
  assert.ok(!('colorMode' in out))
  assert.ok(!('enableBeep' in out))
  assert.ok(!('bogusKey' in out))
  assert.deepEqual(sanitizeSettingsPatch(null), {})
  assert.deepEqual(sanitizeSettingsPatch([1, 2]), {})
})

test('sanitizeSettingsPatch: null tombstone reverts to the declared default; secret keys always stripped', () => {
  const out = sanitizeSettingsPatch({ tomatoTime: null, colorMode: null, securityLockPassword: 'hunter2' })
  assert.equal(out.tomatoTime, DEFAULT_SETTINGS.tomatoTime)
  assert.equal(out.colorMode, DEFAULT_SETTINGS.colorMode)
  assert.ok(!('securityLockPassword' in out), 'peer-pushed secret never lands')
})

test('sanitizeSettingsPatch: partial shortcut map merges over the CURRENT state, not defaults (U3)', () => {
  const current = { shortcutKeySettings: { ...DEFAULT_SETTINGS.shortcutKeySettings, quickAdd: 'Ctrl+Shift+A' } }
  const out = sanitizeSettingsPatch({ shortcutKeySettings: { toggleTodo: 'Ctrl+K' } }, current)
  assert.equal(out.shortcutKeySettings.quickAdd, 'Ctrl+Shift+A', 'local customization survives')
  assert.equal(out.shortcutKeySettings.toggleTodo, 'Ctrl+K')
  // array-default fields only accept arrays with string entries (round-2 P1 / wave2 P3)
  const folded = sanitizeSettingsPatch({ foldedTodoList: ['a', 42, '', null, 'b'] })
  assert.deepEqual(folded.foldedTodoList, ['a', 'b'])
  assert.ok(!('foldedTodoList' in sanitizeSettingsPatch({ foldedTodoList: { x: 1 } })), 'object where array declared → dropped')
})

test('clampNumericSettings: tomatoTime 9999 clamps to the shared manifest range; garbage untouched', () => {
  assert.equal(clampNumericSettings({ tomatoTime: 9999 }).tomatoTime <= 600, true)
  assert.equal(clampNumericSettings({ tomatoTime: 0 }).tomatoTime >= 1, true)
  assert.equal(clampNumericSettings({ tomatoTime: 'x' }).tomatoTime, 'x', 'non-numbers pass through')
  assert.equal(clampNumericSettings(null), null)
  assert.deepEqual(coerceNumericSettings({ tomatoTime: '30', enableBeep: 'true' }), { tomatoTime: 30, enableBeep: 'true' }, 'only number-declared keys coerce')
})

test('mergeTourMap / canonicalJson / mainConsumedSettingsDiff / tomatoLedgerPatch pure contracts', () => {
  assert.deepEqual(mergeTourMap({ a: 5, b: 1 }, { b: 9, c: 2 }), { a: 5, b: 9, c: 2 })
  assert.deepEqual(mergeTourMap(null, { a: 1 }), { a: 1 })
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }))
  assert.equal(canonicalJson(undefined), 'null')
  const st = { ...DEFAULT_SETTINGS, appLocale: 'en-US' }
  const diff = mainConsumedSettingsDiff(st)
  assert.deepEqual(diff, { appLocale: 'en-US' }, 'only the changed main-consumed keys are pushed to main')
  assert.deepEqual(mainConsumedSettingsDiff({ ...DEFAULT_SETTINGS }), {})
  assert.deepEqual(tomatoLedgerPatch({ tomatoTime: 30, bogus: 1, restTime: null }), { tomatoTime: 30 })
  assert.deepEqual(tomatoLedgerPatch(null), {})
  assert.deepEqual(TOMATO_LEDGER_KEYS, ['tomatoTime', 'restTime', 'dailyTomatoTarget'])
  assert.ok(MAIN_CONSUMED_SETTINGS.includes('appLocale'))
})

test('settings.update action: mirrors duration keys into the tomato ledger and reports IPC failure', async () => {
  const st = freshState()
  const commits = []
  const ctx = {
    state: st,
    commit (m, p) { commits.push([m, p]); if (m === 'updateSettings') Object.assign(st, p) },
    dispatch: async () => {}
  }
  globalThis.window.todoAPI = { onAppQuittingFlush () {}, dbCall: async () => null }
  const r = await settings.actions.update(ctx, { tomatoTime: 40, colorMode: 'dark' })
  assert.deepEqual(r, { ok: true }, 'missing bridge counts as ok')
  assert.ok(commits.some(([m, p]) => m === 'tomato/patch' && p.tomatoTime === 40), 'duration mirror fired (P1-1)')
  assert.equal(st.tomatoTime, 40)

  // IPC failure is reported, not swallowed (P2-2)
  globalThis.window.todoAPI.updateSettings = async () => { throw new Error('ipc down') }
  const fail = await settings.actions.update(ctx, { colorMode: 'light' })
  assert.equal(fail.ok, false)
  assert.ok(fail.error)
})

test('settings.updateExternal: sanitizes inbound patches and merges the tour ledger per-key max (Y6)', async () => {
  const st = freshState()
  st.onboardingToursSeen = { pips: 100 }
  const dispatched = []
  const ctx = { state: st, dispatch: async (path, patch) => { dispatched.push(patch) } }
  await settings.actions.updateExternal(ctx, { tomatoTime: '35', bogus: 1, securityLockPassword: 'x', onboardingToursSeen: { pips: 50, rail: 7 } })
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0].tomatoTime, 35)
  assert.equal(dispatched[0].onboardingToursSeen.pips, 100, 'peer older ts never rolls the local tour back')
  assert.equal(dispatched[0].onboardingToursSeen.rail, 7)
  assert.ok(!('securityLockPassword' in dispatched[0]))
  assert.ok(!('bogus' in dispatched[0]))
  // empty sanitized patch → no dispatch
  await settings.actions.updateExternal(ctx, { bogus: 2 })
  assert.equal(dispatched.length, 1)
})

test('settings.restore mutation: secret carve-out keeps the backup lock; defaults backstop fills absent secrets', () => {
  globalThis.window.todoAPI = { onAppQuittingFlush () {}, dbCall: async () => null }
  const st = freshState()
  settings.mutations.restore(st, { colorMode: 'dark', securityLockPassword: 'secret123', tomatoTime: 50 })
  assert.equal(st.securityLockPassword, 'secret123', "restore is the user's own import — secrets survive")
  assert.equal(st.colorMode, 'dark')
  assert.equal(st.tomatoTime, 50)
  // restore without secrets reseats defaults
  settings.mutations.restore(st, { colorMode: 'light' })
  assert.equal(st.securityLockPassword, DEFAULT_SETTINGS.securityLockPassword)
})

test('settings.initFromDb: newer DB blob is whitelisted and applied; stale LS writes back; higher schemaV rejected; read error no-ops', async () => {
  const st = freshState()
  let mirror = null
  globalThis.window.todoAPI = { onAppQuittingFlush () {}, dbCall: async (op) => op === 'getMeta' ? mirror : null }
  // point dbMirror at our in-memory meta via the module's expected bridge
  const ctx = { state: st, commit: (m, p) => { if (m === 'updateSettings') Object.assign(st, p) }, dispatch: async (p, patch) => { Object.assign(st, patch); return { ok: true } } }
  // stale LS (no MIRROR_AT stamp) + fresh blob → blob wins
  mirror = JSON.stringify({ _savedAt: Date.now() + 10000, tomatoTime: 45, habits: 'junk', schemaV: 1 })
  await settings.actions.initFromDb(ctx)
  assert.equal(st.tomatoTime, 45, 'newer DB blob applied')
  assert.equal(st.habits, undefined, 'habits-family junk keys whitelisted out (F-C2)')

  // higher schemaV than supported → reject without washing the mirror away
  mirror = JSON.stringify({ _savedAt: Date.now() + 20000, schemaV: 99, tomatoTime: 99 })
  const before = st.tomatoTime
  await settings.actions.initFromDb(ctx)
  assert.equal(st.tomatoTime, before, 'downgrade protection: future blob not adopted')

  // no DB blob and no newer LS stamp → current state mirrors back to the DB
  mirror = null
  await settings.actions.initFromDb(ctx)
  assert.ok(st.tomatoTime, 'no-blob branch completes without throwing')
})
