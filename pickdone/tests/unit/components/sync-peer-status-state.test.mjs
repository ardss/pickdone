/**
 * 2026-10-10 work-package C (device/conflict visibility) — peerStatusInfo state mapping.
 * The Device Center must read the structured getStatus() fields (peerState, nextDialAt),
 * never fake state by regexing lastError. Pure block is eval'd from sync-tab-helpers.js
 * between the [component-fixes] markers, same harness as device-center-sync-tab.test.mjs.
 * Run: node --test tests/unit/components/sync-peer-status-state.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const SFC = 'renderer/js/components/settings/SettingsSyncTab.vue'
const PURE = 'renderer/js/components/settings/sync-tab-helpers.js'
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')
const src = read(SFC)
const pureSrc = read(PURE)

function pureFns (names) {
  const m = pureSrc.match(/\/\/ \[component-fixes\] pure-start[^\n]*\n([\s\S]*?)\/\/ \[component-fixes\] pure-end/)
  assert.ok(m, `${PURE}: pure block markers missing`)
  const fn = new Function(m[1] + `\nreturn { ${names.join(', ')} }`)
  return fn()
}

const NOW = 1700000000000

test('peerStatusInfo: structured peerState drives the card, one branch per backend state', () => {
  const { peerStatusInfo } = pureFns(['peerStatusInfo'])
  assert.deepEqual(
    { dot: peerStatusInfo({ peerState: 'unpaired', online: true }, NOW).dot, labelKey: peerStatusInfo({ peerState: 'unpaired' }, NOW).labelKey },
    { dot: 'sync-dot--err', labelKey: 'sync.unpairedByRemote' })
  assert.equal(peerStatusInfo({ peerState: 'oversized-segment' }, NOW).labelKey, 'sync.oversizedSegmentNotice')
  assert.equal(peerStatusInfo({ peerState: 'oversized-segment' }, NOW).dot, 'sync-dot--err')
  assert.equal(peerStatusInfo({ peerState: 'flush-stalled' }, NOW).labelKey, 'sync.flushStalledNotice')
  assert.equal(peerStatusInfo({ peerState: 'hibernating' }, NOW).labelKey, 'sync.hibernatingNotice')
  assert.equal(peerStatusInfo({ peerState: 'hibernating' }, NOW).dot, 'sync-dot--err')
  // healthy peer: no status line at all (nothing to say)
  assert.equal(peerStatusInfo({ peerState: 'ok', online: true }, NOW).labelKey, null)
  assert.equal(peerStatusInfo({ peerState: 'ok', online: true }, NOW).dot, 'sync-dot--ok')
  assert.equal(peerStatusInfo({ peerState: 'ok', online: false }, NOW).dot, 'sync-dot--off')
})

test('peerStatusInfo: hibernating retryInSec derives from nextDialAt (main-owned epoch)', () => {
  const { peerStatusInfo } = pureFns(['peerStatusInfo'])
  const r = peerStatusInfo({ peerState: 'hibernating', nextDialAt: NOW + 42 * 1000 }, NOW)
  assert.equal(r.retryInSec, 42)
  // no backoff pending (dialable now / legacy main): null, never an invented countdown
  assert.equal(peerStatusInfo({ peerState: 'hibernating' }, NOW).retryInSec, null)
  // past-due nextDialAt does not render a stale countdown
  assert.equal(peerStatusInfo({ peerState: 'hibernating', nextDialAt: NOW - 1 }, NOW).retryInSec, null)
})

test('peerStatusInfo: error state renders errorPrefix with the real lastError window', () => {
  const { peerStatusInfo } = pureFns(['peerStatusInfo'])
  assert.equal(peerStatusInfo({ peerState: 'error', lastError: 'ECONNREFUSED', lastErrorAt: NOW - 10 * 1000 }, NOW).labelKey, 'sync.errorPrefix')
  assert.equal(peerStatusInfo({ peerState: 'error', lastError: 'ECONNREFUSED', lastErrorAt: NOW - 10 * 1000 }, NOW).dot, 'sync-dot--err')
  // structured 'error' with a STALE lastErrorAt: main has already decayed state; do not keep it red forever
  const stale = peerStatusInfo({ peerState: 'error', lastError: 'ECONNREFUSED', lastErrorAt: NOW - 6 * 60 * 1000, online: false }, NOW)
  assert.equal(stale.labelKey, null)
  assert.equal(stale.dot, 'sync-dot--off')
})

test('peerStatusInfo: legacy main (no peerState) keeps the old regex + fresh-error fallbacks only', () => {
  const { peerStatusInfo } = pureFns(['peerStatusInfo'])
  // regex-detected unpaired still maps to the dedicated copy (older main build)
  assert.equal(peerStatusInfo({ lastError: 'peer-unauthorized: auth rejected' }, NOW).labelKey, 'sync.unpairedByRemote')
  // fresh generic lastError keeps the old errorPrefix line
  assert.equal(peerStatusInfo({ lastError: 'boom', lastErrorAt: NOW - 60 * 1000 }, NOW).labelKey, 'sync.errorPrefix')
  // no error at all: no label, offline dot
  assert.deepEqual(peerStatusInfo({}, NOW), { dot: 'sync-dot--off', labelKey: null, retryInSec: null })
})

test('peerDotClass: structured terminal/failure states are red regardless of the 5-min window', () => {
  const { peerDotClass } = pureFns(['peerDotClass'])
  for (const s of ['unpaired', 'oversized-segment', 'hibernating', 'flush-stalled']) {
    assert.equal(peerDotClass({ peerState: s, online: true }, NOW), 'sync-dot--err', `peerState=${s}`)
  }
})

test('SFC wiring: card dot + status line + unpair gating go through the structured mapper', () => {
  assert.match(src, /:class="peerStatusInfo\(p\)\.dot"/, 'dot class must come from the structured mapper')
  assert.match(src, /peerStatusLabel\(p\)/, 'status line must render via peerStatusLabel')
  assert.match(src, /isUnpairedByRemote \(p\) \{ return this\.peerStatusInfo\(p\)\.labelKey === 'sync\.unpairedByRemote' \}/,
    'unpair-button gating must use the structured state, not lastError regex alone')
  assert.match(src, /hibernatingNotice/, 'hibernating countdown copy must be wired')
})

test('flush quarantine stays READ-ONLY: no resolve/retry/apply action in the quarantine section', () => {
  const q = src.slice(src.indexOf('v-if="quarantineOpen"'), src.indexOf('Outbound pairing'))
  assert.ok(q.length > 0, 'quarantine section found in template')
  assert.doesNotMatch(q, /@click/, 'quarantine rows must not offer any action button (backend exposes no op)')
  assert.match(q, /quarantineHint/, 'quarantine hint must state the read-only nature')
})

test('i18n: new state keys exist in both locales (check-i18n parity safety net)', () => {
  const zh = read('renderer/js/i18n/zh-CN.js')
  const en = read('renderer/js/i18n/en-US.js')
  for (const k of ['oversizedSegmentNotice', 'hibernatingNotice']) {
    assert.ok(zh.includes(`"${k}"`), `zh-CN missing sync.${k}`)
    assert.ok(en.includes(`"${k}"`), `en-US missing sync.${k}`)
  }
})
