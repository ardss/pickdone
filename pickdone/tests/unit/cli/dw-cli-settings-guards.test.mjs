/**
 * dw wave — P3-5/P3-6: CLI settings manifest & numeric-range guards.
 *  P3-5  showTagPanel (a real DEFAULT_SETTINGS sync field, SideNav.vue computed read/write) was
 *        missing from SETTINGS_MANIFEST.boolean → `settings set showTagPanel` reported UNKNOWN_KEY
 *        and `settings list` didn't show it. Plus a gate test pinning the manifest against
 *        DEFAULT_SETTINGS so future renderer keys can't silently go missing again.
 *  P3-6  numeric settings now carry per-key min/max mirrored from the UI's input controls
 *        (SETTINGS_MANIFEST.ranges); previously only isFinite/≥0 were enforced, so e.g.
 *        `settings set tomatoTime 99999` was accepted while the App clamps 5-180.
 * Run: node --test tests/unit/cli/dw-cli-settings-guards.test.mjs
 */
import '../../setup.mjs' // window/localStorage/i18n shims — the gate test imports the renderer's store/settings.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'
import { isolatedTmpDir } from '../../lib/tmp-dir.mjs'

process.env.TODO_DB_DIR = isolatedTmpDir('todo-dw-settings-')
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')
db.init(process.env.TODO_DB_DIR)

test('P3-5: showTagPanel is manifest-exposed and settable', () => {
  assert.ok(lib.SETTINGS_MANIFEST.boolean.includes('showTagPanel'), 'showTagPanel must be in the boolean manifest (SideNav.vue reads/writes it via the settings store)')
  const r = lib.settingsSet('showTagPanel', 'false')
  assert.equal(r.value, false)
  assert.equal(lib.settingsSet('showTagPanel', 'true').value, true)
  const listed = lib.settingsList().find(x => x.key === 'showTagPanel')
  assert.ok(listed, 'settings list must surface showTagPanel')
  assert.equal(listed.type, 'boolean')
})

test('P3-5 gate: every DEFAULT_SETTINGS syncable key is manifest-exposed with the right type', async () => {
  const { DEFAULT_SETTINGS } = await import('../../../renderer/js/store/settings.js')
  const manifest = lib.SETTINGS_MANIFEST
  // Keys intentionally NOT manifest-exposed (documented in cli/lib.js manifest header + DEFAULT_SETTINGS comments):
  const intentional = new Set([
    'foldedTodoList',        // complex object managed by the App's own UI
    'shortcutKeySettings',   // complex object (config.json-backed, shared/shortcut-defaults.mjs)
    'repeatDefaultSettings', // complex object (repeat-modal defaults, managed by the App's repeat UI)
    'onboardingToursSeen',   // complex object (onboarding tour completion state, App-managed)
    '_lsAt',                 // internal LS write stamp
    'tomatoTimeDefault', 'restTimeDefault' // legacy dead keys, migrated away on load
  ])
  const denied = new Set(['securityLockPassword', 'securityLockQuestion', 'schemaV', '_savedAt'])
  const known = new Set([
    ...manifest.boolean,
    ...manifest.number,
    ...Object.keys(manifest.enum),
    ...manifest.string
  ])
  const missing = []
  for (const [key, def] of Object.entries(DEFAULT_SETTINGS)) {
    if (key.startsWith('_') || intentional.has(key) || denied.has(key)) continue
    if (!known.has(key)) { missing.push(key); continue }
    const expected = typeof def === 'boolean' ? 'boolean'
      : typeof def === 'number' ? 'number'
        : manifest.enum[key] ? 'enum' : 'string'
    const info = lib.settingsKnown(key)
    assert.equal(info.type, expected, `key ${key}: manifest type ${info.type} != DEFAULT_SETTINGS type ${expected}`)
  }
  assert.deepEqual(missing, [], 'DEFAULT_SETTINGS keys missing from the CLI manifest')
})

test('P3-6: numeric per-key ranges mirror the UI clamps', () => {
  assert.deepEqual(lib.SETTINGS_MANIFEST.ranges.tomatoTime, { min: 5, max: 180 })
  assert.deepEqual(lib.SETTINGS_MANIFEST.ranges.restTime, { min: 1, max: 60 })
  assert.throws(() => lib.settingsSet('tomatoTime', '999'), /between 5 and 180/)
  assert.throws(() => lib.settingsSet('tomatoTime', '3'), /between 5 and 180/)
  assert.throws(() => lib.settingsSet('restTime', '0'), /between 1 and 60/)
  assert.equal(lib.settingsSet('tomatoTime', '45').value, 45, 'in-range values keep working')
  assert.equal(lib.settingsSet('restTime', '10').value, 10)
})

test('P3-6: keys without a range entry keep the generic ≥0 gate', () => {
  assert.throws(() => lib.settingsSet('recycleBinAutoDeleteDays', '-1'), /must be >= 0/)
  assert.equal(lib.settingsSet('recycleBinAutoDeleteDays', '7').value, 7)
})
