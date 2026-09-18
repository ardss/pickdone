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
  assert.equal(feedIcon('snapshot'), '⇄')
  assert.equal(feedIcon('???'), '·')
  const now = 1700000000000
  assert.deepEqual(relTimeParts(now - 30 * 1000, now), { n: 0, unit: 'now' })
  assert.deepEqual(relTimeParts(now - 5 * 60 * 1000, now), { n: 5, unit: 'min' })
  assert.deepEqual(relTimeParts(now - 3 * 3600 * 1000, now), { n: 3, unit: 'hour' })
  assert.deepEqual(relTimeParts(now - 2 * 86400 * 1000, now), { n: 2, unit: 'day' })
})

test('snapshot feed kind maps to the 快照同步 label (zh+en) in feedLine and the live-append path', async () => {
  const { feedIcon } = pureFns(['feedIcon'])
  assert.equal(feedIcon('snapshot'), '⇄')
  assert.match(src, /snapshot: 'sync\.kindSnapshot'/, 'feedLine kindKey map must cover snapshot')
  assert.match(src, /evt\.kind === 'snapshot' \? 'snapshot'/, 'live-append path must map snapshot events')
  const zh = (await import(pathToFileURL(path.join(ROOT, 'renderer/js/i18n/zh-CN.js')))).default.sync
  const en = (await import(pathToFileURL(path.join(ROOT, 'renderer/js/i18n/en-US.js')))).default.sync
  assert.equal(zh.kindSnapshot, '快照同步')
  assert.equal(en.kindSnapshot, 'Snapshot sync')
})

/* ---------- events + refresh + i18n symmetry ---------- */

test('component refreshes status on every syncEvent and on mount', () => {
  assert.match(src, /onSyncEvent \(evt\)[\s\S]*?this\.refresh\(\)/)
  assert.match(src, /mounted \(\) \{[\s\S]*?this\.refresh\(\)\.then\(\(\) => this\.checkPendingPair\(\)\)[\s\S]*?this\.bindSyncEvents\(\)[\s\S]*?\}/)
  assert.match(src, /onSyncEvent/, 'must subscribe to the syncEvent channel')
})

/* ---------- sync-hardening wave (2026-09-18) ---------- */

test('syncEvent listener disposer is kept and called in beforeUnmount (no stacked listeners across remounts)', () => {
  assert.match(src, /this\._syncEventDisposer = typeof off === 'function' \? off : null/,
    'bindSyncEvents must store the unsubscribe fn returned by onSyncEvent')
  const unmount = src.match(/beforeUnmount \(\) \{([\s\S]*?)\r?\n {2}\},\r?\n {2}mounted/)[1]
  assert.match(unmount, /this\._syncEventDisposer[\s\S]*?this\._syncEventDisposer\(\)/,
    'beforeUnmount must invoke the disposer (mount→unmount→mount leaves exactly one listener)')
  assert.match(unmount, /this\._relTimer/, 'beforeUnmount must clear the relative-time ticker too')
})

test('pendingPair from syncGetStatus is consumed on mount (recovers the dialog after reopening settings)', () => {
  assert.match(src, /checkPendingPair \(\) \{[\s\S]*?this\.status && this\.status\.pendingPair[\s\S]*?showIncomingPair/,
    'status.pendingPair must open the same confirm dialog on mount')
  assert.match(src, /if \(pp && !this\.incomingPair\)/, 'must not clobber a live dialog')
})

test('respondPair inspects the result: ok:false on accept toasts expiry, not success', () => {
  assert.match(src, /const r = \(await syncPairRespond\(\{ accept: !!accept \}\)\) as \{ ok\?: boolean \} \| null/)
  assert.match(src, /r && r\.ok === false\)[^\n]*pairExpiredMsg/, 'expired accept → 配对请求已过期 toast')
  assert.match(src, /pairOkMsg/, 'successful accept still toasts success')
})

test('outbound connectPeer: connecting flag (disabled + inline hint) and reason-mapped failure toasts', () => {
  const { pairFailureKey } = pureFns(['pairFailureKey'])
  assert.equal(pairFailureKey({ reason: 'rejected' }), 'sync.pairRejectedMsg')
  assert.equal(pairFailureKey({ message: 'pair timeout after 60s' }), 'sync.pairTimeoutMsg')
  assert.equal(pairFailureKey({ reason: 'pair-throttled' }), 'sync.pairThrottledMsg')
  assert.equal(pairFailureKey({}), '')
  assert.equal(pairFailureKey(null), '')
  assert.match(src, /this\.connecting = true/, 'immediate waiting state on connectPeer start')
  assert.match(src, /:disabled="busy \|\| connecting \|\| !connectHost"/, 'button disabled while waiting')
  assert.match(src, /v-if="connecting"/, 'inline 正在等待对方确认 hint while waiting')
  assert.match(src, /pairFailureKey\(e\)/, 'failure reason mapping consulted before the generic toast')
  assert.match(src, /key \|\| 'sync\.pairFailGenericMsg'/, 'confirm-flow failures use the generic key, not the code-domain one')
})

test('relative times get a 30s ticker so they do not freeze', () => {
  assert.match(src, /startRelTicker \(\) \{[\s\S]*?30 \* 1000/)
  assert.match(src, /void this\.relTick/, 'relTime must depend on the ticker for re-render')
})

test('pair dialog a11y: focus trap, autofocus on reject, Esc rejects without bubbling, expiry hint', () => {
  assert.match(src, /@keydown="onPairKeydown"/)
  assert.match(src, /aria-modal="true"/)
  assert.match(src, /ref="pairRejectBtn"/, 'reject button must be ref-able for autofocus')
  assert.match(src, /btn\.focus\(\)/, 'focus moves into the dialog (safe default = 拒绝)')
  assert.match(src, /e\.stopPropagation\(\)[\s\S]*?this\.respondPair\(false\)/,
    'Esc = reject and must NOT bubble up to close the whole settings modal')
  assert.match(src, /focusables\[focusables\.length - 1\]/, 'Tab focus trap cycles inside the dialog')
  assert.match(src, /pairExpired = true/, 'countdown expiry shows the inline 请求已超时 hint state')
  assert.match(src, /sync\.pairExpiredHint/)
  assert.match(src, /_pairPrevFocus[\s\S]*?prev\.focus\(\)/, 'focus restored to the previously focused element on close')
})

test('feed session hint is always rendered under the feed', () => {
  assert.match(src, /sync-feed-hint[\s\S]*?\$t\('sync\.feedSessionHint'\)/)
})

test('sync i18n keys are symmetric across zh-CN and en-US shards', async () => {
  const zh = (await import(pathToFileURL(path.join(ROOT, 'renderer/js/i18n/zh-CN.js')))).default.sync
  const en = (await import(pathToFileURL(path.join(ROOT, 'renderer/js/i18n/en-US.js')))).default.sync
  const newKeys = ['devicesSection', 'thisDevice', 'portLabel', 'onlineTip', 'offlineTip', 'errTip',
    'synced', 'behindN', 'relJustNow', 'relMinutes', 'relHours', 'relDays', 'addDeviceLabel',
    'connectBtn', 'connectSent', 'pairRejectedMsg', 'pairRequestTitle', 'pairRequestFrom',
    'pairCountdown', 'acceptBtn', 'rejectBtn', 'manualPairLabel', 'activitySection', 'feedEmpty',
    'kindPush', 'kindPull', 'kindError', 'kindPair', 'securityWarn', 'securityDetail',
    'pairExpiredMsg', 'pairWaiting', 'pairTimeoutMsg', 'pairThrottledMsg', 'pairFailGenericMsg',
    'pairExpiredHint', 'kindSnapshot', 'feedSessionHint']
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
