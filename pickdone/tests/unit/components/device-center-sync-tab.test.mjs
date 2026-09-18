/**
 * Device Center (SettingsSyncTab rework, feature/device-center) — regression guards.
 * Pure logic is extracted verbatim from the .vue script block between the
 * "[component-fixes] pure-start/end" markers and exercised directly; template-level behavior
 * (peer card wiring, pair-request dialog, security strip) is locked in as structural source
 * assertions, following component-fixes-renderer.test.mjs.
 * Run: node --test tests/unit/components/device-center-sync-tab.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const SFC = 'renderer/js/components/settings/SettingsSyncTab.vue'
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')
const src = read(SFC)

function pureFns (names) {
  const m = src.match(/\/\/ \[component-fixes\] pure-start[^\n]*\n([\s\S]*?)\/\/ \[component-fixes\] pure-end/)
  assert.ok(m, `${SFC}: pure block markers missing`)
  const fn = new Function(m[1] + `\nreturn { ${names.join(', ')} }`)
  return fn()
}

/* ---------- peer card: online/offline dot ---------- */

test('peerDotClass: online peer is ok (green), offline peer is off (gray)', () => {
  const { peerDotClass } = pureFns(['peerDotClass'])
  const now = 1700000000000
  assert.equal(peerDotClass({ online: true }, now), 'sync-dot--ok')
  assert.equal(peerDotClass({ online: false }, now), 'sync-dot--off')
  assert.equal(peerDotClass({}, now), 'sync-dot--off') // defensive: missing fields render offline
})

test('peerDotClass: lastError within 5 minutes wins (red) regardless of online flag', () => {
  const { peerDotClass } = pureFns(['peerDotClass'])
  const now = 1700000000000
  assert.equal(peerDotClass({ online: true, lastError: 'boom', lastErrorAt: now - 60 * 1000 }, now), 'sync-dot--err')
  // stale error (older than 5min) falls back to online/offline coloring
  assert.equal(peerDotClass({ online: true, lastError: 'boom', lastErrorAt: now - 6 * 60 * 1000 }, now), 'sync-dot--ok')
  // error without lastErrorAt never marks red (cannot age out — conservative)
  assert.equal(peerDotClass({ online: false, lastError: 'boom' }, now), 'sync-dot--off')
})

/* ---------- peer card: pending badge ---------- */

test('peerPendingKind: pendingCount>0 → behind, 0 → synced, null/undefined → hidden', () => {
  const { peerPendingKind } = pureFns(['peerPendingKind'])
  assert.equal(peerPendingKind(3), 'behind')
  assert.equal(peerPendingKind(0), 'synced')
  assert.equal(peerPendingKind(null), null)
  assert.equal(peerPendingKind(undefined), null)
})

test('pending badge template wiring: behind renders 落后 N 条 i18n key, synced renders 已同步 key', () => {
  assert.match(src, /behindN/, 'component must use the sync.behindN i18n key for pendingCount>0')
  assert.match(src, /\$t\('sync\.synced'\)/, 'component must use the sync.synced i18n key for pendingCount=0')
  assert.match(src, /pendingBadge \(p\)/, 'peer card must render via pendingBadge method')
})

/* ---------- inbound pair-request dialog → syncPairRespond ---------- */

test('pair-request dialog calls syncPairRespond with {accept:true|false} from the two buttons', () => {
  assert.match(src, /@click="respondPair\(true\)"/)
  assert.match(src, /@click="respondPair\(false\)"/)
  assert.match(src, /await syncPairRespond\(\{ accept: !!accept \}\)/)
  assert.match(src, /dbCallLoose\('syncPairRespond'/, 'syncPairRespond must go through the IPC dbCall contract op')
})

test('inbound pair-request auto-dismisses after 60s with countdown', () => {
  assert.match(src, /expiresAt: Date\.now\(\) \+ 60 \* 1000/)
  assert.match(src, /tickIncomingPair/, 'countdown ticker must be scheduled')
  assert.match(src, /pairCountdown/, 'dialog must render the countdown i18n key')
})

/* ---------- security strip ---------- */

test('security strip renders from status.security and pair-throttled event', () => {
  const { securityVisible } = pureFns(['securityVisible'])
  assert.equal(securityVisible([], false), false)
  assert.equal(securityVisible([{ at: 1, ip: '10.0.0.9', reason: 'bad-secret' }], false), true)
  assert.equal(securityVisible([], true), true)
  // template wiring: strip + detail popover + i18n copy
  assert.match(src, /securityStripVisible/)
  assert.match(src, /sync\.securityWarn/)
  assert.match(src, /role="alert"/)
  assert.match(src, /pair-throttled/, 'pair-throttled event must raise the alert')
})

/* ---------- activity feed ---------- */

test('capFeed: caps display at 20 and tolerates missing/undefined input', () => {
  const { capFeed } = pureFns(['capFeed'])
  assert.equal(capFeed(undefined, 20).length, 0)
  assert.equal(capFeed(Array.from({ length: 30 }, (_, i) => ({ at: i })), 20).length, 20)
  assert.deepEqual(capFeed([{ at: 2 }, { at: 1 }], 20), [{ at: 2 }, { at: 1 }]) // newest-first preserved
})

test('feed icon + relative time buckets are pure and total', () => {
  const { feedIcon, relTimeParts } = pureFns(['feedIcon', 'relTimeParts'])
  assert.equal(feedIcon('push'), '↑')
  assert.equal(feedIcon('pull'), '↓')
  assert.equal(feedIcon('error'), '!')
  assert.equal(feedIcon('pair'), '∞')
  assert.equal(feedIcon('???'), '·')
  const now = 1700000000000
  assert.deepEqual(relTimeParts(now - 30 * 1000, now), { n: 0, unit: 'now' })
  assert.deepEqual(relTimeParts(now - 5 * 60 * 1000, now), { n: 5, unit: 'min' })
  assert.deepEqual(relTimeParts(now - 3 * 3600 * 1000, now), { n: 3, unit: 'hour' })
  assert.deepEqual(relTimeParts(now - 2 * 86400 * 1000, now), { n: 2, unit: 'day' })
})

/* ---------- events + refresh + i18n symmetry ---------- */

test('component refreshes status on every syncEvent and on mount', () => {
  assert.match(src, /onSyncEvent \(evt\)[\s\S]*?this\.refresh\(\)/)
  assert.match(src, /mounted \(\) \{ this\.refresh\(\); this\.bindSyncEvents\(\) \}/)
  assert.match(src, /onSyncEvent/, 'must subscribe to the syncEvent channel')
})

test('sync i18n keys are symmetric across zh-CN and en-US shards', async () => {
  const zh = (await import(pathToFileURL(path.join(ROOT, 'renderer/js/i18n/zh-CN.js')))).default.sync
  const en = (await import(pathToFileURL(path.join(ROOT, 'renderer/js/i18n/en-US.js')))).default.sync
  const newKeys = ['devicesSection', 'thisDevice', 'portLabel', 'onlineTip', 'offlineTip', 'errTip',
    'synced', 'behindN', 'relJustNow', 'relMinutes', 'relHours', 'relDays', 'addDeviceLabel',
    'connectBtn', 'connectSent', 'pairRejectedMsg', 'pairRequestTitle', 'pairRequestFrom',
    'pairCountdown', 'acceptBtn', 'rejectBtn', 'manualPairLabel', 'activitySection', 'feedEmpty',
    'kindPush', 'kindPull', 'kindError', 'kindPair', 'securityWarn', 'securityDetail']
  for (const k of newKeys) {
    assert.ok(zh[k], `zh-CN sync.${k} missing`)
    assert.ok(en[k], `en-US sync.${k} missing`)
  }
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
})

test('outbound pairing uses syncPairRequest and keeps manual code pairing as collapsed fallback', () => {
  assert.match(src, /dbCallLoose\('syncPairRequest'/)
  assert.match(src, /manualOpen = !manualOpen/, 'manual section must be collapsible')
  assert.match(src, /manualPairLabel/)
  assert.match(src, /pairWithCode/, 'existing 6-digit code pairing must remain available')
})
