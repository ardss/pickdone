/**
 * W22 P2 — repeatSettings key-level whitelist (the sync-blob contract bypass).
 *
 * Root cause being pinned: repeatSettings.load() Object.assigned ANY key found in the LS cache,
 * updateFromBlob adopted the whole inbound repeatDefaultSettings blob, and the store/index.js seed
 * mirrored the whole module state into settings.repeatDefaultSettings — so junk/foreign keys
 * entered live state and rode settings persist/mirrorBlob into LS + db.settingsState + backups
 * (the nested-object twin of the F-C2 DEFAULT_SETTINGS whitelist hole closed at the settings top
 * level).
 *
 * Covered:
 *   [1] LS entry: unknown keys in 'repeatSettingsV2State' never enter module state.
 *   [2] blob entry: updateFromBlob adopts only whitelisted keys; the LS write-through cache is clean.
 *   [3] settings boundary: the sanitizeSettingsPatch export key-whitelists the nested
 *       repeatDefaultSettings object (both a wrapper and a passthrough shape).
 *   [4] legal keys still flow (declared REPEAT_DEFAULTS keys are adopted, arrays intact).
 *
 * Run: node --test tests/unit/renderer/w22-repeat-settings-whitelist.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
let importSeq = 0
const importSrc = p => import(pathToFileURL(path.join(ROOT, p)).href + '?w22r=' + (++importSeq))

const LS = {}
globalThis.localStorage = {
  getItem: k => (k in LS ? LS[k] : null),
  setItem: (k, v) => { LS[k] = String(v) },
  removeItem: k => { delete LS[k] }
}
globalThis.window = { location: { hash: '' } } // no todoAPI: settings persist takes the no-DB branch

const RS_LS = 'repeatSettingsV2State'

test('[1] load(): unknown keys in the LS cache never enter module state', async () => {
  const { REPEAT_DEFAULT_SETTINGS } = await importSrc('renderer/js/store/repeatSettings.js')
  LS[RS_LS] = JSON.stringify({ repeatType: 'week', schemaV: 9, habitsState: 'pollution', evilJunk: { x: 1 }, repeatInterval: 3 })
  const mod = await importSrc('renderer/js/store/repeatSettings.js')
  const state = mod.default.state()
  assert.equal(state.repeatType, 'week', 'a declared key is adopted')
  assert.equal(state.repeatInterval, 3, 'a second declared key is adopted')
  for (const junk of ['schemaV', 'habitsState', 'evilJunk']) {
    assert.equal(junk in state, false, `unknown key "${junk}" dropped from state`)
  }
  // the whitelist itself is exactly the REPEAT_DEFAULTS key set
  assert.deepEqual(Object.keys(REPEAT_DEFAULT_SETTINGS).sort(), Object.keys(mod.REPEAT_DEFAULT_SETTINGS).sort())
})

test('[2] updateFromBlob: only whitelisted keys adopted, LS write-through cache stays clean', async () => {
  const mod = await importSrc('renderer/js/store/repeatSettings.js')
  const state = mod.default.state()
  mod.default.mutations.updateFromBlob(state, {
    repeatWeekCount: 7, repeatWeekDays: [0, 6], deletedTombstones: [{ id: 'x' }], habits: [], moments: [], savedAt: 123
  })
  assert.equal(state.repeatWeekCount, 7, 'declared key adopted from the blob')
  assert.deepEqual(state.repeatWeekDays, [0, 6], 'declared array value intact')
  for (const junk of ['deletedTombstones', 'habits', 'moments', 'savedAt']) {
    assert.equal(junk in state, false, `blob key "${junk}" dropped`)
  }
  const cache = JSON.parse(LS[RS_LS])
  for (const junk of ['deletedTombstones', 'habits', 'moments', 'savedAt']) {
    assert.equal(junk in cache, false, `blob key "${junk}" absent from the LS write-through cache`)
  }
  assert.equal(cache.repeatWeekCount, 7, 'the clean value still reached the cache')
})

test('[3] settings.sanitizeSettingsPatch key-whitelists the nested repeatDefaultSettings object', async () => {
  const settings = await importSrc('renderer/js/store/settings.js')
  // inbound trust-boundary shape (updateExternal / restore both route through this export)
  const clean = settings.sanitizeSettingsPatch({
    repeatDefaultSettings: { repeatType: 'month', repeatMonthCount: 6, tombstoneJunk: 1, habits: [], schemaV: 3 },
    showComplete: false
  })
  assert.equal(clean.showComplete, false, 'unrelated top-level key still sanitizes through')
  const rep = clean.repeatDefaultSettings
  assert.ok(rep, 'the nested object survives sanitization')
  assert.equal(rep.repeatType, 'month', 'declared nested key kept')
  assert.equal(rep.repeatMonthCount, 6, 'second declared nested key kept')
  for (const junk of ['tombstoneJunk', 'habits', 'schemaV']) {
    assert.equal(junk in rep, false, `nested key "${junk}" dropped by the whitelist`)
  }
})

test('[4] declared REPEAT_DEFAULTS keys flow end-to-end (no over-filtering)', async () => {
  const mod = await importSrc('renderer/js/store/repeatSettings.js')
  const { REPEAT_DEFAULT_SETTINGS } = mod
  const probe = {}
  for (const k of Object.keys(REPEAT_DEFAULT_SETTINGS)) probe[k] = Array.isArray(REPEAT_DEFAULT_SETTINGS[k]) ? [9] : (typeof REPEAT_DEFAULT_SETTINGS[k] === 'boolean' ? true : 42)
  const state = mod.default.state()
  mod.default.mutations.updateFromBlob(state, probe)
  for (const k of Object.keys(REPEAT_DEFAULT_SETTINGS)) {
    assert.ok(k in state, `declared key "${k}" survives the blob entry`)
  }
  assert.deepEqual(state.repeatWeekDays, [9], 'declared array key value passes through')
})
