/**
 * SettingsSyncTab pure helpers — extracted verbatim from the SFC (2026-10-10, size ratchet:
 * the tab had blown its baseline). Keep pure & framework-free; the [component-fixes] markers
 * are load-bearing: tests/unit/components evals the block between them.
 */

// [component-fixes] pure-start (extracted verbatim by tests/unit/components) — keep pure & framework-free
/** Online/offline/error dot class for a peer card: red when lastError is fresh (< 5min),
 *  green when online, gray otherwise. */
function peerDotClass (peer, now = null) {
  const nowMs = now || Date.now()
  // 2026-09-27 sync wave: a 'flush-stalled' peer is a persistent fault (budget of consecutive // flush-failed rounds, not a transient lastError) — the dot stays red until main clears the // state; it must NOT age out via the 5min lastError window.
  // 2026-10-10 work-package C: structured peerState wins where it exists (see peerStatusInfo).
  if (peer && peer.peerState) {
    const s = String(peer.peerState)
    if (s === 'unpaired' || s === 'oversized-segment' || s === 'hibernating' || s === 'flush-stalled') return 'sync-dot--err'
  }
  if (peer && peer.lastError && peer.lastErrorAt && (nowMs - peer.lastErrorAt) < 5 * 60 * 1000) return 'sync-dot--err'
  return peer && peer.online ? 'sync-dot--ok' : 'sync-dot--off'
}
/** Pending badge text decision: 'behind' when pendingCount > 0, 'synced' when exactly 0,
 *  null when unknown (hide the badge entirely). */
function peerPendingKind (pendingCount) {
  if (pendingCount == null) return null
  return pendingCount > 0 ? 'behind' : 'synced'
}
/** Cap a status.recent list (already newest-first from main) for display. */
function capFeed (recent, cap) {
  return (Array.isArray(recent) ? recent : []).slice(0, cap || 20)
}
/** Map a feed kind to a display icon (plain symbols, no emoji, token-colorable). */
function feedIcon (kind) {
  return { push: '↑', pull: '↓', error: '!', pair: '∞', snapshot: '⇄' }[kind] || '·'
}
/** D2-b/c (pair-by-IP fallback): parse the add-device field — accepts a bare host OR
 *  "host:port" (TODO_SYNC_PORT legitimately moves peers off 58471; the old code sent the
 *  combined string verbatim as the hostname → getaddrinfo ENOTFOUND). Returns
 *  { host, port } where port is null for a bare host (main then applies DEFAULT_PORT).
 *  Only ONE colon is treated as a separator, so raw IPv6 literals pass through untouched. */
function parseConnectAddress (input) {
  const s = String(input || '').trim()
  if (!s) return null
  const m = s.match(/^([^:]+):(\d{1,5})$/)
  if (m) {
    const port = Number(m[2])
    if (port >= 1 && port <= 65535) return { host: m[1], port }
    return null
  }
  // A colon that is NOT a valid host:port separator (e.g. "1.2.3.4:abc") must not be dialed // verbatim — that is the old bug shape (ENOTFOUND '1.2.3.4:abc'). Only multi-colon IPv6
  // literals pass through untouched.
  if ((s.match(/:/g) || []).length === 1) return null
  return { host: s, port: null }
}
/** Map a pairing failure (err.reason/err.message from the main process) to an i18n key;
 *  '' means "no specific reason known" → the caller shows the generic confirm-flow message. */
function pairFailureKey (err) {
  const r = String((err && (err.reason || err.message)) || '')
  if (/reject/i.test(r)) return 'sync.pairRejectedMsg'
  if (/time[- ]?out|timed/i.test(r)) return 'sync.pairTimeoutMsg'
  if (/throttl/i.test(r)) return 'sync.pairThrottledMsg'
  // D2-c: DNS lookup failure on the dialed address — say the FORMAT is wrong instead of the
  // generic retry toast (the old host:port-verbatim bug surfaced exactly here).
  if (/getaddrinfo|ENOTFOUND|EAI_AGAIN/i.test(r)) return 'sync.pairBadAddrMsg'
  return ''
}
/** Relative-time bucketing shared by peer cards and the feed: {n, unit} with unit in
 *  'now'|'min'|'hour'|'day'. */
function relTimeParts (ts, now = null) {
  const nowMs = now || Date.now()
  const diff = Math.max(0, nowMs - ts)
  if (diff < 60 * 1000) return { n: 0, unit: 'now' }
  if (diff < 3600 * 1000) return { n: Math.floor(diff / 60000), unit: 'min' }
  if (diff < 86400 * 1000) return { n: Math.floor(diff / 3600000), unit: 'hour' }
  return { n: Math.floor(diff / 86400000), unit: 'day' }
}
/** Security strip visibility: shown when any blocked attempt or a live throttled event exists. */
function securityVisible (list, throttled) {
  return !!(throttled || (Array.isArray(list) && list.length > 0))
}
/** P2c (2026-09-19 UX review round 2): a peer whose pairing secret was REVOKED on this side (or
 *  that unpaired us) fails authenticated hello forever — it shows as a zombie card. Map such
 *  lastError markers (agent-A field: `lastError`; defensive patterns incl. 'unpaired',
 *  'peer-unauthorized', auth-rejected, and the Chinese notice) to the dedicated "unpaired by the
 *  other device — pair again" state instead of a transient-looking red error. */
function peerUnpairedByRemote (lastError) {
  if (!lastError) return false
  return /unpair|peer-unauthorized|unauthorized|auth[^.]{0,16}reject/i.test(String(lastError))
}
/** 2026-09-27 sync wave: main stamps peerState 'flush-stalled' after FLUSH_STALL_BUDGET
 *  consecutive flush-failed rounds (lan-sync/index.js getStatus). Pure helper keeps the
 *  template line and the dot class in agreement. */
function peerFlushStalled (peer) {
  return !!(peer && peer.peerState === 'flush-stalled')
}
/** F1 (round-2 P1 2026-09-21): peer display name — machine-local alias wins, then the advertised
 *  deviceName (main now carries it on the status payload), then the raw record name/deviceId. */
function peerDisplayName (peer) {
  if (!peer) return ''
  return peer.alias || peer.deviceName || peer.name || peer.deviceId || ''
}
/** 2026-10-10 work-package C (device/conflict visibility): ONE structured state mapper for
 *  the Device Center peer card. Main stamps `peerState` ∈
 *  'unpaired'|'oversized-segment'|'flush-stalled'|'hibernating'|'error'|'ok' plus `nextDialAt`
 *  (earliest redial epoch, null = dialable now) — the card MUST read those fields, not
 *  reverse-engineer state from lastError text. The regex fallback below only covers older
 *  main builds without peerState (CLI test host) and can only DOWNGRADE to unpaired-looking
 *  copy, never invent a success state.
 *  Returns { dot, labelKey, retryInSec } — labelKey null = no status line (healthy peer). */
function peerStatusInfo (peer, now = null) {
  const nowMs = now || Date.now()
  const state = peer && peer.peerState ? String(peer.peerState) : null
  const retryInSec = (peer && peer.nextDialAt && peer.nextDialAt > nowMs)
    ? Math.ceil((peer.nextDialAt - nowMs) / 1000)
    : null
  if (state === 'unpaired') return { dot: 'sync-dot--err', labelKey: 'sync.unpairedByRemote', retryInSec }
  if (state === 'oversized-segment') return { dot: 'sync-dot--err', labelKey: 'sync.oversizedSegmentNotice', retryInSec }
  if (state === 'flush-stalled') return { dot: 'sync-dot--err', labelKey: 'sync.flushStalledNotice', retryInSec }
  // hibernating = past the dial-failure budget: FAILED, not offline-idle. Show the red dot plus
  // the honest backoff countdown derived from nextDialAt (main-owned, never a UI guess).
  if (state === 'hibernating') return { dot: 'sync-dot--err', labelKey: 'sync.hibernatingNotice', retryInSec }
  if (state === 'error') {
    // fresh structured error beats the legacy 5-min window: main already decayed it to 'error'
    // only while it is live. Legacy (no peerState) keeps the timestamp-window semantics.
    if (peer.lastErrorAt == null || (nowMs - peer.lastErrorAt) < 5 * 60 * 1000) {
      return { dot: 'sync-dot--err', labelKey: 'sync.errorPrefix', retryInSec }
    }
    return { dot: peer.online ? 'sync-dot--ok' : 'sync-dot--off', labelKey: null, retryInSec: null }
  }
  // legacy fallback: older main without peerState whose lastError markers read as unpaired
  if (!state && peerUnpairedByRemote(peer && peer.lastError)) return { dot: 'sync-dot--err', labelKey: 'sync.unpairedByRemote', retryInSec }
  // legacy fallback: older main without peerState — keep the old fresh-lastError status line
  if (!state && peer && peer.lastError && peer.lastErrorAt && (nowMs - peer.lastErrorAt) < 5 * 60 * 1000) {
    return { dot: 'sync-dot--err', labelKey: 'sync.errorPrefix', retryInSec }
  }
  return { dot: peerDotClass(peer, nowMs), labelKey: null, retryInSec }
}
// [component-fixes] pure-end
export {
  peerStatusInfo,
  peerDotClass,
  peerPendingKind,
  capFeed,
  feedIcon,
  parseConnectAddress,
  pairFailureKey,
  relTimeParts,
  securityVisible,
  peerUnpairedByRemote,
  peerFlushStalled,
  peerDisplayName
}
