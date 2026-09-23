/* maint/dw wave2 — domain 1 (renderer store/data-flow) regressions:
 * [F1] settings/restore now fans out into the repeatSettings module + tours LS cache via the same
 *      subscription that serves settings/updateSettings (backup restore used to leave the module on
 *      pre-restore values; the next repeatSettings/updateSettings re-committed the stale package
 *      over the freshly restored blob).
 * [F2] settings/restore mirrors duration keys (tomatoTime/restTime/dailyTomatoTarget) into the
 *      tomato runtime ledger — the live countdown no longer stays stale until restart after a
 *      restore whose blob carries different durations.
 * [F3] i18n flatOf joins keys with a real dot: lookupMessage('app.name') resolves (was 'appname',
 *      so the tt() fallback in stub hosts returned key names).
 * [F4] sanitizeSettingsPatch drops non-array junk on ARRAY-default fields (foldedTodoList) —
 *      symmetric with the unknown-key and type-mismatch junk drops.
 * Run: node --test tests/unit/store/maint-dw2-domain1-fixes.test.mjs
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

/* ---------------- F3: i18n flat lookup ---------------- */

test('F3: lookupMessage resolves dotted keys (flatOf joins with a dot)', async () => {
  const i18n = await importSrc('renderer/js/i18n/index.js')
  const zh = i18n.lookupMessage('app.name')
  assert.ok(zh !== undefined && zh !== 'app.name', 'zh fallback resolves app.name, got: ' + JSON.stringify(zh))
  assert.equal(typeof zh, 'string')
  assert.ok(zh.length > 0)
  // a nested deep key too (two-level join)
  const deep = i18n.lookupMessage('statsE.SettingsModal.restorePartialFail')
  assert.ok(deep !== undefined, 'two-level dotted key resolves')
  // en-US table resolves through the same join
  assert.ok(i18n.lookupMessage('app.name', 'en-US') !== undefined)
})

/* ---------------- F4: sanitizer array-default junk drop ---------------- */

test('F4: sanitizeSettingsPatch drops non-array junk on an array-default field', async () => {
  const { sanitizeSettingsPatch } = await importSrc('renderer/js/store/settings.js')
  assert.deepEqual(sanitizeSettingsPatch({ foldedTodoList: { junk: 1 } }), {},
    'array-default field receiving an object must be dropped, not passed verbatim')
  // legit arrays still flow, entries still filtered
  assert.deepEqual(sanitizeSettingsPatch({ foldedTodoList: ['today-done', 'x'] }).foldedTodoList, ['today-done', 'x'])
  assert.deepEqual(sanitizeSettingsPatch({ foldedTodoList: ['a', 3, null, ''] }).foldedTodoList, ['a'])
  // other fields unaffected
  assert.equal(sanitizeSettingsPatch({ developerMode: true }).developerMode, true)
})

/* ---------------- F1/F2: restore fan-out + tomato mirror (full store subscription) ---------------- */

test('F1/F2: settings/restore fans out to repeatSettings, tours LS and the tomato ledger', async t => {
  // fresh LS + real vuex, then build the full store exactly like the app does
  const mem = new Map()
  globalThis.localStorage = {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: k => mem.delete(k)
  }
  globalThis.window.Vuex = await import('vuex')
  const { default: store } = await importSrc('renderer/js/store/index.js')

  // pre-state: module/LS carry values that DIFFER from what the backup blob will restore
  store.commit('repeatSettings/updateSettings', { pomodoroMinutes: 25 })
  store.commit('settings/updateSettings', { tomatoTime: 25, restTime: 5, dailyTomatoTarget: 8 })
  mem.set('onboardingToursSeen', JSON.stringify({ localTour: 999 }))
  assert.equal(store.state.repeatSettings.pomodoroMinutes, 25)

  // the restore blob carries DIFFERENT durations + repeat defaults + a tour stamp
  store.commit('settings/restore', {
    tomatoTime: 50, restTime: 15, dailyTomatoTarget: 12,
    repeatDefaultSettings: { pomodoroMinutes: 45 },
    onboardingToursSeen: { restoredTour: 500 }
  })

  assert.equal(store.state.settings.tomatoTime, 50, 'restore assigned the blob into live settings')
  assert.equal(store.state.repeatSettings.pomodoroMinutes, 45,
    'F1: repeatSettings module adopted the restored blob (was stuck at 25 before the fix)')
  assert.equal(JSON.parse(mem.get('repeatSettingsV2State')).pomodoroMinutes, 45,
    'F1: the module LS cache is write-through updated too')
  assert.equal(JSON.parse(mem.get('onboardingToursSeen')).restoredTour, 500,
    'F1: restored tour ledger is written through to LS')
  assert.equal(JSON.parse(mem.get('onboardingToursSeen')).localTour, 999,
    'F1: per-key max merge keeps a locally-newer tour stamp')
  assert.equal(store.state.tomato.tomatoTime, 50,
    'F2: tomato runtime ledger mirrored the restored durations (was stale until restart)')
  assert.equal(store.state.tomato.restTime, 15)

  // F1 full user-visible chain: after restore, a repeat-default change must NOT re-commit the
  // stale pre-restore package over the fresh blob (the original silent-rollback bug)
  store.commit('repeatSettings/updateSettings', { pomodoroMinutes: 46 })
  assert.equal(store.state.settings.repeatDefaultSettings.pomodoroMinutes, 46,
    'post-restore edit persists the restored+edited value, not the stale pre-restore one')
  assert.equal(store.state.tomato.tomatoTime, 50, 'tomato ledger untouched by the repeat edit')
})

test('F1: source anchor — the subscription matches settings/restore alongside updateSettings', () => {
  const src = read('renderer/js/store/index.js')
  assert.ok(src.includes("mutation.type === 'settings/restore'"), 'restore is matched in the fan-out subscription')
  assert.ok(src.includes('tomatoLedgerPatch'), 'restore mirrors durations via the shared helper')
})
