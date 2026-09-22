/* D6 security round (2026-09-21):
 *   F9   __proto__ injection: config-store writeConfig and the notify-settings-updated IPC
 *        route must never carry own '__proto__' keys onto Object.prototype
 *   F10  manifest localKeys mirror ≡ sync-apply authoritative machine-local filters over an
 *        enumerated key corpus (via the gate's checkLocalKeyMirror + a direct comparison)
 * Run: node --test tests/unit/main/d6-sec-proto-mirror.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'd6-sec-proto-'))

// F9: config-store with a temp config dir (no electron needed — __setConfigDir)
const configStore = require_('../../../src/main/config-store.js')
configStore.__setConfigDir(TMP)

test('F9: writeConfig drops an own __proto__ patch key instead of polluting Object.prototype', () => {
  // JSON.parse creates __proto__ as an OWN data property (the pollution vector); object literals cannot
  const patch = JSON.parse('{"__proto__":{"polluted":"yes"},"appLocale":"en","constructor":{"prototype":{"x":1}}}')
  const c = configStore.writeConfig(patch)
  assert.equal(c.appLocale, 'en', 'legit keys still land')
  assert.equal(({}).polluted, undefined, 'Object.prototype must stay clean')
  assert.equal(({}).x, undefined, 'constructor.prototype vector must stay clean')
  assert.equal(configStore.readConfig().polluted, undefined, 'nothing persisted under a polluted prototype')
  assert.equal(configStore.readConfig().appLocale, 'en')
  // own __proto__ must not survive as a data key in the JSON either
  const onDisk = JSON.parse(fs.readFileSync(path.join(TMP, 'config.json'), 'utf8'))
  assert.equal(Object.getOwnPropertyNames(onDisk).includes('__proto__'), false)
})

test('F9: writeConfig still merges over existing state (regression guard for the safe merge)', () => {
  configStore.writeConfig({ d6extra: 'v1' })
  assert.equal(configStore.readConfig().d6extra, 'v1')
  assert.equal(configStore.readConfig().appLocale, 'en', 'earlier keys survive the merge')
  assert.ok(configStore.readConfig().shortcutKeySettings, 'defaults fill still intact')
})

// F9: the notify-settings-updated IPC route (renderer-controlled patch object)
const settingsHandlers = require_('../../../src/main/handlers/settings.js')
test('F9: notify-settings-updated sanitizes a __proto__-bearing renderer patch before writeConfig', () => {
  const written = []
  const MAINWC = { id: 'main' }
  const api = settingsHandlers({
    readConfig: () => ({ shortcutKeySettings: {} }),
    writeConfig: patch => { written.push(patch); return { shortcutKeySettings: {} } },
    app: { setLoginItemSettings () {} },
    getMainWindow: () => ({ webContents: MAINWC, isDestroyed: () => false }),
    applyShortcuts () {},
    rebuildTrayMenu () {},
    getTray: null
  })
  const patch = JSON.parse('{"__proto__":{"polluted":"yes"},"securityLockPassword":"x","theme":"dark"}')
  api['notify-settings-updated']({ sender: MAINWC }, patch)
  assert.equal(written.length, 1)
  // 2026-09-22 main-ipc-1: the dangerous-key strip became PER-SENDER. The main window legitimately
  // writes the security keys through this channel (SettingsModal.saveLockPassword rides
  // settings/update), so the blanket strip is narrowed to auxiliary (float) senders — which is
  // also where the P2 threat lived ({enableSecurityLock:false} from a trapped float silently
  // killed the lock). The __proto__ de-fanging is unchanged for EVERY sender.
  let clean = written[0]
  assert.equal(({}).polluted, undefined, 'Object.prototype must stay clean')
  assert.equal(clean.theme, 'dark', 'legit keys still land')
  assert.equal(clean.securityLockPassword, 'x', 'main window keeps the lock-password write surface (settings-page save)')
  // impersonate the float sender (the handler checks tomatoFloat.isSelfSender at call time)
  const tomatoFloat = require_('../../../src/main/tomato-float.js')
  const realSelf = tomatoFloat.isSelfSender
  tomatoFloat.isSelfSender = () => true
  try { api['notify-settings-updated']({ sender: { id: 'float' } }, patch) } finally { tomatoFloat.isSelfSender = realSelf }
  clean = written[1]
  assert.equal('securityLockPassword' in clean, false, 'security keys still stripped for auxiliary (float) senders')
  assert.equal(({}).polluted, undefined, 'prototype stays clean for auxiliary senders too')
})

// F10: manifest mirror vs sync-apply authoritative filters
const manifest = require_('../../../src/main/command-manifest.js')
const syncApply = require_('../../../src/main/sync-apply.js')
const gate = require_('../../../cli/check-command-bus.cjs')

test('F10: gate checkLocalKeyMirror passes for the real manifest vs real sync-apply filters', () => {
  const problems = []
  assert.equal(gate.checkLocalKeyMirror(m => problems.push(m), syncApply), true)
  assert.deepEqual(problems, [])
  // direct comparison over the gate corpus too (belt and braces)
  for (const k of gate.MIRROR_KEY_CORPUS) {
    assert.equal(
      !!manifest.isMachineLocalMetaKey(k), !!syncApply.isMachineLocalMetaKey(k),
      `meta key "${k}" classified differently by manifest mirror vs sync-apply`)
    assert.equal(
      !!manifest.isMachineLocalSettingKey(k), !!syncApply.isMachineLocalSettingKey(k),
      `setting key "${k}" classified differently by manifest mirror vs sync-apply`)
  }
})

test('F10: the migration keys the round-3 sync-apply fix added are LOCAL in BOTH filters', () => {
  for (const k of ['schemaVersion', 'dayPlanState', 'dayPlanState.bak']) {
    assert.equal(syncApply.isMachineLocalMetaKey(k), true, `sync-apply must block "${k}"`)
    assert.equal(manifest.isMachineLocalMetaKey(k), true, `manifest mirror must agree on "${k}"`)
  }
})

test('F10: checkLocalKeyMirror REPORTS drift when a filter diverges (gate negative self-test)', () => {
  const problems = []
  const badMod = { isMachineLocalMetaKey: k => k === 'schemaVersion' ? false : syncApply.isMachineLocalMetaKey(k), isMachineLocalSettingKey: syncApply.isMachineLocalSettingKey }
  assert.equal(gate.checkLocalKeyMirror(m => problems.push(m), badMod), false)
  assert.ok(problems.some(p => p.includes('schemaVersion')), 'drift on a corpus key is reported')
  // a diverging mirror on a NON-corpus key stays invisible to the corpus check (documents scope)
  assert.equal(typeof badMod.isMachineLocalMetaKey, 'function')
})
