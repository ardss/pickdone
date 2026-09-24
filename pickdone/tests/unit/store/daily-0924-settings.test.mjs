/* Daily 2026-09-24 settings single-source regressions:
 * [B5] manifest ranges gained whiteNoiseVolume/notificationTimeoutInterval/autoBackupKeep —
 *      keys that had no entry bypassed clampNumericSettings entirely on the LAN-ingress path
 *      (the renderer's SETTING_RANGES IS the shared manifest table).
 * [B6] SETTING_ENUMS covers the five keys that only existed in the shared manifest enum, and
 *      sanitizeSettingsPatch DROPS non-member enum values (peer junk like weekStartDay:'monday'
 *      used to land verbatim). The VALUE SET single source is the manifest; a drift pin asserts
 *      SETTING_ENUMS and SETTINGS_MANIFEST.enum agree on every key both declare.
 * [B9] schemaV de-ambiguation pin: stripHabitsFamily strips ONLY the habits-exclusive fields —
 *      the settings blob's own schemaV survives — and lan-sync-bootstrap consumes the SHARED
 *      family contract (no hand-copied HABITS_BLOB_FIELDS literal, B3).
 * Run: node --test tests/unit/store/daily-0924-settings.test.mjs */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')
const importSrc = p => import(pathToFileURL(path.join(ROOT, p)).href)

const { SETTINGS_MANIFEST } = await importSrc('shared/settings-manifest.mjs')
const { HABITS_BLOB_FIELDS, HABITS_EXCLUSIVE_FIELDS, stripHabitsFamily } = await importSrc('shared/settings-families.mjs')
const { SETTING_ENUMS, SETTING_RANGES, sanitizeSettingsPatch, DEFAULT_SETTINGS } = await importSrc('renderer/js/store/settings.js')

test('B5: the previously unbounded numeric keys now clamp via the shared manifest table', () => {
  assert.equal(SETTING_RANGES, SETTINGS_MANIFEST.ranges, 'single source: SETTING_RANGES IS the manifest table')
  for (const k of ['whiteNoiseVolume', 'notificationTimeoutInterval', 'autoBackupKeep']) {
    assert.ok(SETTING_RANGES[k], `manifest ranges carries ${k}`)
  }
  const out = sanitizeSettingsPatch({ whiteNoiseVolume: 55, autoBackupKeep: 100, notificationTimeoutInterval: 60000 })
  assert.equal(out.whiteNoiseVolume, 1, 'volume 55 clamps to the 0-1 domain (LAN/CLI inbound cannot bypass)')
  assert.equal(out.autoBackupKeep, 30, 'autoBackupKeep clamps to the UI option ceiling')
  assert.equal(out.notificationTimeoutInterval, 60000, 'in-range value passes through untouched')
})

test('B6: non-member enum values are DROPPED by sanitizeSettingsPatch', () => {
  const clean = sanitizeSettingsPatch({
    weekStartDay: 'sun', todoBoxSortMethod: 'due', todoBoxSortOrder: 'asc',
    calendarBackground: 'theme', calendarFontColor: 'black',
  })
  assert.deepEqual(clean, {
    weekStartDay: 'sun', todoBoxSortMethod: 'due', todoBoxSortOrder: 'asc',
    calendarBackground: 'theme', calendarFontColor: 'black',
  })
  const junk = sanitizeSettingsPatch({
    weekStartDay: 'monday', todoBoxSortMethod: 'alphabetical', todoBoxSortOrder: 'up',
    calendarBackground: 'purple', calendarFontColor: 'blue',
  })
  assert.deepEqual(junk, {}, 'non-member enum junk must not reach live state')
  // enum validation must not disturb unrelated keys in the same patch
  const mixed = sanitizeSettingsPatch({ weekStartDay: 'monday', tomatoTime: 25 })
  assert.deepEqual(mixed, { tomatoTime: 25 })
})

test('B6: SETTING_ENUMS and the shared manifest enum agree on every shared key (single-source drift pin)', () => {
  // Direction: the manifest is the single source for VALUE SETS — every SETTING_ENUMS key must
  // be declared there with the exact same values. (Manifest keys with no SETTING_ENUMS entry
  // yet, e.g. appLocale from the concurrent CLI round, are that round's surface and are
  // intentionally not asserted here.)
  for (const [key, entries] of Object.entries(SETTING_ENUMS)) {
    assert.ok(SETTINGS_MANIFEST.enum[key], `manifest enum declares SETTING_ENUMS key ${key}`)
    assert.deepEqual(
      [...entries.map(o => o.v)].sort(),
      [...SETTINGS_MANIFEST.enum[key]].sort(),
      `value sets must match for ${key} (manifest is the single source)`)
  }
  // The five keys this round added must exist in DEFAULT_SETTINGS (sanitize whitelists by it).
  for (const k of ['weekStartDay', 'calendarBackground', 'calendarFontColor', 'todoBoxSortMethod', 'todoBoxSortOrder']) {
    assert.ok(k in DEFAULT_SETTINGS, `${k} is a declared setting`)
    assert.ok(Array.isArray(SETTING_ENUMS[k]) && SETTING_ENUMS[k].length > 0)
  }
})

test('B9/B3: stripHabitsFamily preserves the blob-own schemaV; bootstrap consumes the shared family set', () => {
  const doc = { schemaV: 7, habits: [{ id: 'h1' }], moments: [{ id: 'm1' }], savedAt: 123, tomatoTime: 25 }
  const stripped = stripHabitsFamily(doc)
  assert.equal(stripped.schemaV, 7, 'the SETTINGS blob schemaV must survive the strip (only habits-exclusive fields go)')
  assert.deepEqual(Object.keys(stripped).sort(), ['schemaV', 'tomatoTime'])
  // habits blob shape keeps schemaV in the FAMILY set (both blobs may carry it)
  assert.deepEqual([...HABITS_BLOB_FIELDS].sort(), ['habits', 'moments', 'savedAt', 'schemaV'])
  assert.deepEqual([...HABITS_EXCLUSIVE_FIELDS].sort(), ['habits', 'moments', 'savedAt'])
  // B3 source anchor: lan-sync-bootstrap must consume the shared module, not a hand-copied literal
  const boot = read('src/main/lan-sync-bootstrap.js')
  assert.ok(boot.includes("require('../../shared/settings-families.mjs')"), 'bootstrap imports the shared family contract')
  assert.ok(!boot.includes("new Set(['schemaV'"), 'no hand-copied HABITS_BLOB_FIELDS literal may return')
})
