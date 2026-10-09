/* Settings-center UX fixes (maint round, 2026-10-09):
 * [1] silent settings-save failure: set() in BOTH SettingsModal.vue and SettingsDataTab.vue must
 *     honor the {ok:false} result of settings/update (config.json IPC write failure) with an
 *     error toast (settingsSaveFailed) — not just SettingsShortcutsTab.
 * [2] enabling the security lock with no password set is false protection (security-lock.js:
 *     `if (!expected) return true` accepts ANY input) — the toggle must block with
 *     lockNeedsPassword and keep the switch off.
 * [3] shortcuts tab: a getSettings IPC rejection used to set shortcutsLoaded=true with the empty
 *     skeleton form; Save then wiped the real bindings. The catch must keep shortcutsLoaded
 *     false and the save button must be disabled while not loaded.
 * [4] preview button must always play the selected completion sound (no white-noise override).
 * [5] the degraded-segments restore warning must come from an i18n key (backupDegradedWarn),
 *     not hardcoded English.
 * [6] auto-backup list IPC rejection must show an error toast, not silently empty the list.
 * [7] global Space handler must cover role="link".
 * [8] search-clear chip gets a dedicated aria-label (clearSearch), not "Close".
 * [9] lock password input must NOT bind the stored enc1:… ciphertext; an untouched empty draft
 *     must never overwrite the stored password (saveLockPassword guards empty).
 * Run: node --test tests/unit/components/maint-settings-ux-fixes.test.mjs */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

const modal = read('renderer/js/components/SettingsModal.vue')
const dataTab = read('renderer/js/components/settings/SettingsDataTab.vue')
const scTab = read('renderer/js/components/settings/SettingsShortcutsTab.vue')
const mainJs = read('renderer/js/main.js')
const zhE = read('renderer/js/i18n/locales/zh-CN-E.js')
const enE = read('renderer/js/i18n/locales/en-US-E.js')
const bothE = [['zh-CN', zhE], ['en-US', enE]]

test('[1] set() reports {ok:false} from settings/update with settingsSaveFailed (modal + data tab)', () => {
  for (const [name, src] of [['SettingsModal', modal], ['SettingsDataTab', dataTab]]) {
    const fn = src.match(/set \(patch\) \{[\s\S]*?\n {4}\},/)
    assert.ok(fn, `${name}.set() found`)
    assert.match(fn[0], /dispatch\('settings\/update', patch\)/)
    assert.match(fn[0], /ok === false/)
    assert.match(fn[0], /settingsSaveFailed/)
    for (const [loc, lsrc] of bothE) assert.match(lsrc, /"settingsSaveFailed": "(?!")/, `${loc} has settingsSaveFailed`)
  }
})

test('[2] enabling the security lock without a stored password is blocked with a warning', () => {
  const fn = modal.match(/onLockToggle \(v\) \{[\s\S]*?\n {4}\},/)
  assert.ok(fn, 'onLockToggle found')
  assert.match(fn[0], /if \(v && !this\.st\.securityLockPassword\)/)
  assert.match(fn[0], /lockNeedsPassword/)
  assert.match(fn[0], /return/)
  // the switch template routes through the guard, not a bare set()
  assert.match(modal, /:model-value="st\.enableSecurityLock" @change="onLockToggle"/)
  for (const [loc, lsrc] of bothE) assert.match(lsrc, /"lockNeedsPassword": "(?!")/, `${loc} has lockNeedsPassword`)
})

test('[3] shortcuts tab: getSettings rejection keeps shortcutsLoaded false; Save disabled until loaded', () => {
  const created = scTab.match(/created \(\) \{[\s\S]*?\r?\n {2}\},/)
  assert.ok(created, 'created() found')
  const catchLine = created[0].match(/\.catch\(([^\r\n]*)/)
  assert.ok(catchLine, 'getSettings catch found')
  assert.ok(!/shortcutsLoaded\s*=\s*true/.test(catchLine[1]), 'catch must NOT set shortcutsLoaded = true')
  // save button is disabled while the snapshot has not loaded
  assert.match(scTab, /:disabled="!shortcutsLoaded" @click="saveShortcuts"/)
})

test('[4] preview plays the selected completion sound (no white-noise override)', () => {
  const fn = modal.match(/previewCompleteSound \(\) \{[\s\S]*?\n {4}\},/)
  assert.ok(fn, 'previewCompleteSound found')
  assert.match(fn[0], /confirmUrl\(st\.completeSound\)/)
  assert.ok(!/whiteNoiseAudio/.test(fn[0]), 'white-noise override removed from the preview path')
})

test('[5] degraded-segments warning is i18n (backupDegradedWarn), not hardcoded English', () => {
  assert.match(dataTab, /\$t\('statsE\.SettingsModal\.backupDegradedWarn', \{ s: degraded \}\)/)
  assert.ok(!/'Backup missing segments/.test(dataTab), 'hardcoded English warning removed')
  for (const [loc, lsrc] of bothE) {
    assert.match(lsrc, /"backupDegradedWarn": "[^"]*\{s\}"/, `${loc} backupDegradedWarn interpolates {s}`)
  }
})

test('[6] auto-backup list IPC rejection shows an error toast instead of silently emptying', () => {
  const fn = dataTab.match(/async loadAutoBackupList \(\) \{[\s\S]*?\n {4}\},/)
  assert.ok(fn, 'loadAutoBackupList found')
  assert.match(fn[0], /catch \(e\) \{ this\.autoBackupFiles = \[\]; this\.\$message\.error\(/)
  assert.match(fn[0], /backupFailed/)
})

test('[7] global Space activation covers role="link"', () => {
  const handler = mainJs.match(/if \(role === 'button'[^\r\n]*/)
  assert.ok(handler, 'role branch found')
  assert.match(handler[0], /role === 'link'/)
})

test('[8] search-clear chip uses a dedicated clearSearch aria-label (not Close)', () => {
  const chip = modal.match(/settings-search__clear[^>]*>/)
  assert.ok(chip, 'clear chip found')
  assert.match(chip[0], /clearSearch/)
  assert.ok(!/closeBtn/.test(chip[0]), 'must not reuse the closeBtn label')
  assert.match(zhE, /"clearSearch": "清除搜索"/)
  assert.match(enE, /"clearSearch": "Clear search"/)
})

test('[9] lock password input binds a local draft; empty input never overwrites the stored ciphertext', () => {
  // the input must NOT bind the stored ciphertext
  const input = modal.match(/<el-input[^>]*lockPasswordLabel[^>]*>/)
  assert.ok(input, 'lock password input found')
  assert.match(input[0], /:model-value="lockPwDraft"/)
  assert.ok(!/:model-value="st\.securityLockPassword"/.test(input[0]), 'ciphertext must not be bound into the input')
  // the change handler guards the empty write
  const fn = modal.match(/async saveLockPassword \(v\) \{[\s\S]*?\n {4}\},/)
  assert.ok(fn, 'saveLockPassword found')
  assert.match(fn[0], /if \(!v\) return/)
})
