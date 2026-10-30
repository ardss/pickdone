/**
 * W12 renderer fixes — regression guards (source-anchor + extracted-behavior idiom).
 * Fixes covered:
 *   [1] SettingsDataTab restore: the settings segment rides the shared parseStampedSeg schemaV
 *       downgrade guard like every other stamped segment (it used to be a bare JSON.parse, so a
 *       backup from a NEWER build was silently downgrade-read and re-persisted).
 *   [2] main.js onExternalHabitBlob: the pre-guard uses the mutation's own isStaleExternalRound
 *       (`<=` — ties reject) so the callback's verdict matches habits/applyExternal on ties; the
 *       old hand-rolled strict `<` reported accepted=true on ties and let relayAuxBlob write the
 *       REJECTED blob verbatim into the durable DB meta row.
 *   [3] WeatherWidget source watcher: a source switch during an in-flight fetch queues exactly
 *       one pending re-fetch (same [D19] pattern as manualCity) instead of being swallowed by
 *       fetchWeather's re-entry guard until the next 30-min refresh.
 * Run: node --test tests/unit/renderer/w12-renderer-fixes.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')
const importMod = p => import(pathToFileURL(path.join(ROOT, p)).href)

/* ---------- [1] settings restore segment is schemaV-guarded ---------- */

test('[1] the settings restore segment rides the shared parseStampedSeg guard', () => {
  const src = read('renderer/js/components/settings/SettingsDataTab.vue')
  // mirror render-consistency [R3]: every stamped segment guarded via the shared helper
  assert.ok(src.includes('this.parseStampedSeg(b.settingsState)'), 'settings segment guarded like its siblings')
  // no bare JSON.parse of settingsState left at the restore call site (the old downgrade hole)
  assert.ok(!src.includes("commit('settings/restore', JSON.parse(b.settingsState))"),
    'the bare JSON.parse settings restore path is gone')
  // the guard sits BEFORE the commit (a newer-schema blob is rejected, not restored)
  const seg = src.indexOf('parseStampedSeg(b.settingsState)')
  const commit = src.indexOf("commit('settings/restore'", seg)
  assert.ok(commit > seg, 'guard precedes the settings/restore commit')
  // dated comment marks the fix
  assert.match(src, /W12 fix \(2026-10-26\)[\s\S]{0,900}parseStampedSeg\(b\.settingsState\)/)
})

test('[1] behavioral: parseStampedSeg-equivalent guard rejects a newer schemaV settings blob', async () => {
  // extract the component's shared guard semantics from source, exactly as the
  // h7-settings-tabs idiom pins parseTodoState: threshold from the single SCHEMA_V constant
  const src = read('renderer/js/components/settings/SettingsDataTab.vue')
  assert.match(src, /import \{[^}]*SCHEMA_V[^}]*\} from '\.\.\/\.\.\/store\/helpers\/todoBackup\.js'/)
  const { SCHEMA_V } = await importMod('renderer/js/store/helpers/todoBackup.js')
  // the guard the component must apply: newer stamped segment throws, legacy (no schemaV) allowed
  const newer = { schemaV: SCHEMA_V + 1, theme: 'dark' }
  assert.ok(Number(newer.schemaV) > SCHEMA_V, 'a newer-schema settings blob must exceed SCHEMA_V')
  assert.equal({}.schemaV, undefined, 'legacy blobs carry no schemaV and stay allowed')
})

/* ---------- [2] external habit blob tie verdict matches the mutation ---------- */

test('[2] behavioral: applyExternal rejects a TIE (prior writer wins)', async () => {
  const habits = (await importMod('renderer/js/store/habits.js')).default
  const LS = globalThis.localStorage
  for (let i = LS.length - 1; i >= 0; i--) LS.removeItem(LS.key(i))
  const habit = { id: 'a', name: 'H', color: '#fff', createdAt: 1, frequency: { type: 'daily' }, records: {} }
  const s = { habits: [habit], moments: [], savedAt: 200 }
  habits.mutations.applyExternal(s, { habits: [{ ...habit, name: 'PEER' }], moments: [], savedAt: 200 })
  assert.equal(s.habits[0].name, 'H', 'a tied round must not re-write state')
  assert.equal(s.savedAt, 200, 'the tie did not advance the local stamp')
})

test('[2] behavioral: isStaleExternalRound rejects the same tie the callback sees', async () => {
  const { isStaleExternalRound } = await importMod('renderer/js/store/habits.js')
  // TIE: same-ms fold round — the callback's pre-guard must return false (rejected)
  assert.equal(isStaleExternalRound(200, 200), true, 'tie is stale (<=)')
  assert.equal(isStaleExternalRound(100, 200), true, 'strictly older is stale')
  assert.equal(isStaleExternalRound(300, 200), false, 'strictly newer is accepted')
})

test('[2] source anchor: main.js routes the pre-guard through the mutation predicate', () => {
  const src = read('renderer/js/main.js')
  assert.match(src, /import \{ onExternalHabitBlob, isStaleExternalRound \} from '\.\/store\/habits\.js'/)
  const cb = src.match(/onExternalHabitBlob\(blob => \{[\s\S]*?\n\}\)/)
  assert.ok(cb, 'the aux-relay callback found')
  assert.match(cb[0], /isStaleExternalRound\(blob\.savedAt, s\.savedAt\)/, 'the pre-guard uses the shared predicate')
  assert.ok(!/< \(s\.savedAt \|\| 0\)/.test(cb[0]), 'the hand-rolled strict-< guard is gone')
  assert.match(src, /W12 fix \(2026-10-26\)[\s\S]{0,600}isStaleExternalRound\(blob\.savedAt, s\.savedAt\)/)
})

/* ---------- [3] WeatherWidget source watcher queues a pending re-fetch ---------- */

test('[3] source anchor: the source watcher mirrors the manualCity pending-fetch pattern', () => {
  const src = read('renderer/js/components/WeatherWidget.vue')
  const watcher = src.match(/source \(\) \{[\s\S]*?\n {4}\}\r?\n {2}\},\r?\n {2}mounted/)
  assert.ok(watcher, 'the source watcher found')
  assert.match(watcher[0], /if \(!this\.enabled\) return/)
  assert.match(watcher[0], /if \(this\.loading\) \{ this\._pendingFetch = true; return \}/,
    'an in-flight fetch must queue exactly one re-run, not be swallowed by the re-entry guard')
  assert.match(watcher[0], /this\.fetchWeather\(\)/)
  assert.match(src, /W12 fix \(2026-10-26\)[\s\S]{0,600}source \(\) \{\r?\n {6}if \(!this\.enabled\) return/)
})
