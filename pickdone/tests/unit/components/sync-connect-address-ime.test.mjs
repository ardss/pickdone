/**
 * D2-b/c (pair-by-IP fallback) + D4-ime (composition guard) — behavior regression tests.
 *
 * D2: the add-device field had no port handling, so "127.0.0.1:59801" was sent verbatim as the
 * hostname (main.log: 'getaddrinfo ENOTFOUND 127.0.0.1:59801') and the user only saw the generic
 * 配对失败 toast. Fix: parseConnectAddress splits host:port (bare host keeps port null so main
 * applies DEFAULT_PORT), connectPeer dials the parsed pair, and a DNS-lookup failure maps to the
 * dedicated sync.pairBadAddrMsg toast instead of the generic one.
 *
 * D4: @keyup.enter on the device-name / peer-alias / settings-username fields fired on the IME
 * commit Enter (keyup of the commit has isComposing=false), saving half-converted pinyin. Fix:
 * @keydown.enter with the standard `isComposing || keyCode === 229` guard (blur-save stays).
 *
 * Pure helpers are extracted verbatim between the [component-fixes] markers; template bindings
 * are locked as structural source assertions (same convention as device-center-sync-tab.test.mjs).
 * Run: node --test tests/unit/components/sync-connect-address-ime.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const SYNC_TAB = 'renderer/js/components/settings/SettingsSyncTab.vue'
// 2026-10-10: the pure block moved verbatim to its own module (size ratchet) — markers intact
const SYNC_TAB_PURE = 'renderer/js/components/settings/sync-tab-helpers.js'
const SETTINGS_MODAL = 'renderer/js/components/SettingsModal.vue'
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')
const syncSrc = read(SYNC_TAB)
const pureSrc = read(SYNC_TAB_PURE)

function pureFns (names) {
  const m = pureSrc.match(/\/\/ \[component-fixes\] pure-start[^\n]*\n([\s\S]*?)\/\/ \[component-fixes\] pure-end/)
  assert.ok(m, `${SYNC_TAB_PURE}: pure block markers missing`)
  const fn = new Function(m[1] + `\nreturn { ${names.join(', ')} }`)
  return fn()
}

/* ---------- parseConnectAddress ---------- */

test('parseConnectAddress: host:port splits into host + numeric port', () => {
  const { parseConnectAddress } = pureFns(['parseConnectAddress'])
  assert.deepEqual(parseConnectAddress('127.0.0.1:59801'), { host: '127.0.0.1', port: 59801 })
  assert.deepEqual(parseConnectAddress(' 192.168.1.64:58471 '), { host: '192.168.1.64', port: 58471 })
})

test('parseConnectAddress: bare host keeps port null (main applies DEFAULT_PORT)', () => {
  const { parseConnectAddress } = pureFns(['parseConnectAddress'])
  assert.deepEqual(parseConnectAddress('192.168.1.64'), { host: '192.168.1.64', port: null })
  assert.deepEqual(parseConnectAddress('  my-nas  '), { host: 'my-nas', port: null })
})

test('parseConnectAddress: empty input and out-of-range/garbage ports are rejected', () => {
  const { parseConnectAddress } = pureFns(['parseConnectAddress'])
  assert.equal(parseConnectAddress(''), null)
  assert.equal(parseConnectAddress('   '), null)
  assert.equal(parseConnectAddress(null), null)
  assert.equal(parseConnectAddress('127.0.0.1:0'), null)
  assert.equal(parseConnectAddress('127.0.0.1:99999'), null)
  assert.equal(parseConnectAddress('127.0.0.1:abc'), null)
})

test('parseConnectAddress: IPv6 literal (multiple colons) passes through untouched', () => {
  const { parseConnectAddress } = pureFns(['parseConnectAddress'])
  assert.deepEqual(parseConnectAddress('fe80::1'), { host: 'fe80::1', port: null })
})

/* ---------- connectPeer wiring + DNS-failure toast mapping ---------- */

test('connectPeer dials the parsed host/port pair, not the raw field string', () => {
  assert.match(syncSrc, /const parsed = parseConnectAddress\(this\.connectHost\)/, 'connectPeer must parse the field')
  assert.match(syncSrc, /syncPairRequest\(parsed\.host, parsed\.port\)/, 'syncPairRequest must receive the parsed pair')
  assert.doesNotMatch(syncSrc, /syncPairRequest\(host\)/, 'the old verbatim-host call must be gone')
})

test('pairFailureKey maps DNS lookup failure to the dedicated bad-address message', () => {
  const { pairFailureKey } = pureFns(['pairFailureKey'])
  assert.equal(pairFailureKey({ message: 'getaddrinfo ENOTFOUND 127.0.0.1:59801' }), 'sync.pairBadAddrMsg')
  assert.equal(pairFailureKey({ reason: 'getaddrinfo EAI_AGAIN nas.local' }), 'sync.pairBadAddrMsg')
  // other reasons keep their existing mappings
  assert.equal(pairFailureKey({ reason: 'pair rejected by peer' }), 'sync.pairRejectedMsg')
  assert.equal(pairFailureKey({ reason: 'request timed out' }), 'sync.pairTimeoutMsg')
  assert.equal(pairFailureKey({ reason: 'throttled' }), 'sync.pairThrottledMsg')
  assert.equal(pairFailureKey({ reason: 'connection refused' }), '')
})

test('i18n: sync.pairBadAddrMsg exists in both locales', () => {
  for (const f of ['renderer/js/i18n/zh-CN.js', 'renderer/js/i18n/en-US.js']) {
    assert.match(read(f), /"pairBadAddrMsg"/, `${f} must define sync.pairBadAddrMsg`)
  }
})

/* ---------- D4-ime: composition guard on Enter-to-save fields ---------- */

const IME_GUARD = /@keydown\.enter="e => \{ if \(e\.isComposing \|\| e\.keyCode === 229\) return;/

test('SettingsSyncTab: device-name field saves on keydown Enter behind the composition guard', () => {
  assert.match(syncSrc, new RegExp(IME_GUARD.source + ' saveName\\(\\) \\}"'))
  assert.doesNotMatch(syncSrc, /@keyup\.enter="saveName"/, 'unguarded keyup must be gone')
})

test('SettingsSyncTab: peer-alias field saves on keydown Enter behind the composition guard', () => {
  assert.match(syncSrc, new RegExp(IME_GUARD.source + ' saveAlias\\(p\\) \\}"'))
  assert.doesNotMatch(syncSrc, /@keyup\.enter="saveAlias"/, 'unguarded keyup must be gone')
})

test('SettingsModal: username field saves on keydown Enter behind the composition guard', () => {
  const modalSrc = read(SETTINGS_MODAL)
  assert.match(modalSrc, new RegExp(IME_GUARD.source + ' saveName\\(\\) \\}"'))
  assert.doesNotMatch(modalSrc, /@keyup\.enter="saveName"/, 'unguarded keyup must be gone')
})
