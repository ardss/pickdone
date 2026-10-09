/**
 * Tomato durability queues (ledger + snow), extracted from store/tomato.js (structure-size
 * ratchet): the crash-proof per-entry LS mirror (TQ-2), quarantine-first degradation (TQ-5),
 * the shared one-settlement-contract retirement policy (TQ-4) and loud durability writes
 * (TQ-6). Entry points: ledgerWrite / snowWrite (called by the store's mutations) and
 * purgePendingAppends (delete-supersedes replay hygiene). Hydrate runs at module load —
 * importing this module restores the exact boot behavior tomato.js had before the split.
 */
import { preserveCorrupt } from '../../utils/corrupt-quarantine.js'
import { commit as commitCommand } from '../../utils/commandBus.js'

const _pendingLedger = []
/** maint/d11-r4: _pendingSnow lives here (next to _pendingLedger) instead of further down — the
 *  module-top-level hydratePendingQueue(PENDING_SNOW_KEY) revive closure pushes into it, and with
 *  the const below its use site the closure hit the TDZ and the ReferenceError was swallowed by
 *  the "corrupt blob" catch, so snow entries persisted before a crash never replayed. */
const _pendingSnow = []
let _flushHooked = false

/** maint/d11-r3: the retry queues are now crash-proof. They used to be pure memory arrays — a quit
 *  flush that still failed (main-process quit-ack caps at 2s then closes the db, so the in-flight
 *  dbCall rejects) or a renderer crash dropped every queued entry with the process, and the
 *  "replayed on the next ledger write" promise could never be kept. Both queues mirror to
 *  localStorage, hydrate at module load, and replay on the next write or quit-flush exactly as
 *  before. TQ-2 (2026-10-03) root fix: the mirror is PER-ENTRY (`<prefix><uid>` keys), not two
 *  whole blobs. The old savePendingQueues rewrote the ENTIRE blob from the calling process's
 *  private array — last-writer-wins — and this module loads in TWO same-origin renderer processes
 *  (main window + float window) with no re-sync after hydrate, so each writer's save erased every
 *  peer entry it didn't hold: a float-enqueued entry died with the float's crash even though the
 *  "crash-proof" mirror still held the main window's blob. Per-entry keys make every write
 *  put-own-key and every settlement delete-own-key; a peer can no longer erase what it never
 *  saw. The uid is a random suffix, deliberately NOT the process-local nextPendingSeq — a fresh
 *  process allocating the same seq would recreate the collision in narrower form. LS keys need no
 *  ordering; hydrate revives entries and replay order follows seq/ts as before. */
const PENDING_LEDGER_PREFIX = 'tomatoPendingLedger.'
const PENDING_SNOW_PREFIX = 'tomatoPendingSnow.'
// Legacy whole-blob keys (pre per-entry mirror): read once at hydrate, migrated, then removed.
const LEGACY_LEDGER_KEY = 'tomatoPendingLedger'
const LEGACY_SNOW_KEY = 'tomatoPendingSnow'
const PENDING_QUEUE_V = 1
let _pendingSeq = 0
function nextPendingSeq () { _pendingSeq += 1; return _pendingSeq }
function newPendingUid () {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}
/** TQ-5 (2026-10-03): the codebase's quarantine-first contract (config-store's config.json.bad,
 *  sync layer's sync.flushQuarantine.<op> per-op cap) applied to the durable queues. A corrupt
 *  payload's RAW BYTES are parked under a capped quarantine key BEFORE the queue degrades —
 *  degradation may stop replay but must never destroy the bytes, because the next save/hydrate
 *  would otherwise overwrite the only copy of data the mirror exists to protect. Single primitive
 *  for every quarantine in this module (ledger rejections, snow refusals, corrupt blobs): append
 *  + cap (newest kept) + RAW throwing setItem (TQ-6: durability writes are loud). Callers in
 *  degradation contexts (module-load hydrate) wrap it in their own loud catch; settlement callers
 *  let it propagate so the entry stays pending (retirement requires the data to exist somewhere). */
const CORRUPT_BLOB_CAP = 10 // quarantined corrupt blobs per queue: newest kept, manual recovery surface
/** Self-load of the quarantine file honors the same invariant it enforces: a parse failure may
 *  start a fresh quarantine but must first park the OLD file's raw bytes (corruptQuarantine.
 *  tomato.quarantine) — the old `catch { parked = [] }` then setItem-overwrite destroyed up to
 *  cap previously quarantined payloads in one stroke, the exact destruction the quarantine
 *  exists to prevent. */
function quarantineAppend (key, cap, item) {
  let parked = []
  let existing = null
  try { existing = localStorage.getItem(key) } catch (e) { existing = null }
  if (existing != null) {
    try { parked = JSON.parse(existing) } catch (e) {
      preserveCorrupt('tomato.quarantine', key, existing)
      parked = []
    }
  }
  if (!Array.isArray(parked)) {
    if (existing != null) preserveCorrupt('tomato.quarantine', key, existing)
    parked = []
  }
  parked.push(item)
  localStorage.setItem(key, JSON.stringify(parked.slice(-cap)))
}
const packLedgerEntry = e => ({ uid: e.uid, seq: e.seq, ts: e.ts, op: e.op, params: e.params })
const packSnowEntry = e => ({ uid: e.uid, seq: e.seq, ts: e.ts, params: e.params })
/** Put-own-key write: writes ONLY this entry's key (TQ-2) through the RAW, throwing primitive —
 *  the mirror is a durability asset, so a storage failure must be loud, never a swallowed boolean
 *  (TQ-6; the old safeSet's return value had zero consumers, so a failed mirror write retired
 *  entries that existed nowhere). */
function savePendingEntry (entry, prefix, pack) {
  localStorage.setItem(prefix + entry.uid, JSON.stringify({ v: PENDING_QUEUE_V, entry: pack(entry) }))
}
/** Delete-own-key settlement. Failure here is benign-by-construction: an orphan blob revives an
 *  entry whose op already landed in the DB, and every ledger/snow op is idempotent (deterministic
 *  tomatoId / dedupKey), so the replay converges instead of double-writing. Loud, not silent. */
function removePendingEntry (entry, prefix) {
  try { localStorage.removeItem(prefix + entry.uid) } catch (e) {
    console.error('[tomato] failed to clear the LS mirror of a settled queue entry:', prefix + entry.uid, e)
  }
}
function listPrefixKeys (prefix) {
  const keys = []
  const corruptKey = prefix + 'corrupt'
  try {
    const n = localStorage.length
    for (let i = 0; i < n; i++) {
      const k = localStorage.key(i)
      // The quarantine key shares the prefix by design — it is NOT an entry and must never be
      // re-hydrated (otherwise hydrate would quarantine itself and grow the cap every boot).
      if (k && k.indexOf(prefix) === 0 && k !== corruptKey) keys.push(k)
    }
  } catch (e) { /* no storage: nothing to hydrate */ }
  return keys
}
function hydratePendingQueue (prefix, legacyKey, revive, pack) {
  // Per-entry hydrate: each key carries exactly one entry; a corrupt/unknown entry degrades to
  // dropping THAT key (logged) without poisoning the peer entries. maint/d11-r4 contract kept:
  // parse/shape failures log, revive failures propagate (a code bug must not masquerade as rot).
  for (const k of listPrefixKeys(prefix)) {
    let raw = null
    try { raw = localStorage.getItem(k) } catch (e) { /* unreadable key: skip, keep bytes */ continue }
    let v = null
    let corrupt = false
    try { v = JSON.parse(raw) } catch (e) { corrupt = true }
    if (!corrupt && (!v || typeof v !== 'object' || v.v !== PENDING_QUEUE_V || !v.entry || typeof v.entry !== 'object')) corrupt = true
    if (corrupt) {
      console.error('[tomato] pending queue entry "' + k + '" is corrupt, starting without it')
      // TQ-5: quarantine the raw bytes BEFORE dropping the key — a parse failure must not
      // destroy the durability payload the mirror exists to protect.
      try {
        quarantineAppend(prefix + 'corrupt', CORRUPT_BLOB_CAP, { key: k, ts: Date.now(), raw })
      } catch (e) { console.error('[tomato] corrupt-entry quarantine failed (bytes left in place):', e) }
      try { localStorage.removeItem(k) } catch { /* bytes stay; re-logged next boot */ }
      continue
    }
    const e = revive(v.entry)
    if (!e) { try { localStorage.removeItem(k) } catch { /* unusable payload stays for inspection */ } }
  }
  // One-time migration of the legacy whole-blob mirror: split into per-entry keys, then drop the
  // blob key. A blob that fails to parse is removed as part of the degrade (logged) so it cannot
  // resurrect stale entries after its entries were migrated by an earlier boot.
  let legacyRaw = null
  try { legacyRaw = localStorage.getItem(legacyKey) } catch (e) { return }
  if (legacyRaw == null) return
  let v = null
  try { v = JSON.parse(legacyRaw) } catch (e) {
    console.error('[tomato] pending queue "' + legacyKey + '" is corrupt, starting empty:', e)
    // TQ-5: quarantine the corrupt legacy blob before dropping it (same preserve-then-degrade).
    try {
      quarantineAppend(prefix + 'corrupt', CORRUPT_BLOB_CAP, { key: legacyKey, ts: Date.now(), raw: legacyRaw })
    } catch (e2) { console.error('[tomato] corrupt-blob quarantine failed (bytes left in place):', e2) }
    try { localStorage.removeItem(legacyKey) } catch { /* keep bytes */ }
    return
  }
  try { localStorage.removeItem(legacyKey) } catch { /* leave; migration is idempotent */ }
  if (!v || typeof v !== 'object' || v.v !== PENDING_QUEUE_V || !Array.isArray(v.entries)) return
  for (const rawEntry of v.entries) {
    const withUid = Object.assign({}, rawEntry, { uid: rawEntry && typeof rawEntry.uid === 'string' && rawEntry.uid ? rawEntry.uid : newPendingUid() })
    const e = revive(withUid)
    if (e) savePendingEntry(e, prefix, pack)
  }
}
/** Startup hydration: entries queued in a previous process life come back (seq/ts stamped at enqueue
 *  time), then replay through the normal ledgerWrite/snowWrite paths. Invoked by the store module
 *  at ITS load (not here) — tests instantiate fresh store modules via query strings and each must
 *  re-hydrate, while this helper module stays cached. */
function hydratePendingQueues () {
  // A fresh store instance starts from empty arrays (pre-split semantics: the arrays lived in
  // tomato.js, so every new module instance hydrated from scratch). Reset before hydrating so a
  // re-invocation can never double-count entries the LS mirror already holds.
  _pendingLedger.length = 0
  _pendingSnow.length = 0
  hydratePendingQueue(PENDING_LEDGER_PREFIX, LEGACY_LEDGER_KEY, raw => {
    if (!raw || typeof raw !== 'object' || typeof raw.op !== 'string' || !raw.params) return null
    if (typeof raw.seq === 'number' && raw.seq > _pendingSeq) _pendingSeq = raw.seq // seq stays monotonic across restarts
    _pendingLedger.push({ op: raw.op, params: raw.params, seq: typeof raw.seq === 'number' ? raw.seq : nextPendingSeq(), ts: typeof raw.ts === 'number' ? raw.ts : Date.now(), uid: typeof raw.uid === 'string' && raw.uid ? raw.uid : newPendingUid() })
    return _pendingLedger[_pendingLedger.length - 1]
  }, packLedgerEntry)
  hydratePendingQueue(PENDING_SNOW_PREFIX, LEGACY_SNOW_KEY, raw => {
    if (!raw || typeof raw !== 'object' || !raw.params) return null
    if (typeof raw.seq === 'number' && raw.seq > _pendingSeq) _pendingSeq = raw.seq
    _pendingSnow.push({ params: raw.params, seq: typeof raw.seq === 'number' ? raw.seq : nextPendingSeq(), ts: typeof raw.ts === 'number' ? raw.ts : Date.now(), uid: typeof raw.uid === 'string' && raw.uid ? raw.uid : newPendingUid() })
    return _pendingSnow[_pendingSnow.length - 1]
  }, packSnowEntry)
}
/** H1 (2026-09-16): the db layer's tomatoAppendMany now returns a row-tolerant {accepted,rejected}
 *  result; rejected rows (missing tomatoId/endTime etc.) used to vanish silently — report each per contract. */
function logRejectedRows (res, params) {
  if (!res || !Array.isArray(res.rejected) || !res.rejected.length) return
  const list = Array.isArray(params) ? params : [params]
  for (const r of res.rejected) {
    let row
    try { row = JSON.stringify(list[r && r.index]) } catch (e) { row = String(list[r && r.index]) }
    console.error('[tomato] ledger row rejected:', r && r.reason, 'row:', row)
  }
}

/** H1 (2026-09-16): after a remove persists, drop pending appends for the same tomatoIds — the db
 *  layer's ON CONFLICT DO UPDATE SET deleted=0 would resurrect the deleted row, so replaying the old
 *  append equals undoing the delete. params is the tomatoRemoveByIds id array. */
function purgePendingAppends (ids) {
  const dead = new Set(ids || [])
  if (!dead.size) return
  for (let i = _pendingLedger.length - 1; i >= 0; i--) {
    const e = _pendingLedger[i]
    if (!e || e.op !== 'tomatoAppendMany') continue
    const recs = Array.isArray(e.params) ? e.params : [e.params]
    if (recs.some(r => r && dead.has(r.tomatoId))) {
      _pendingLedger.splice(i, 1)
      removePendingEntry(e, PENDING_LEDGER_PREFIX) // TQ-2: delete-own-key (a peer's entries are untouched)
    }
  }
}

/** D14-C1 (2026-10-01): a resolved dbCall is NOT the same as "the entry landed". Two shapes used to
 *  splice the entry and erase its LS mirror anyway, permanently dropping user-earned ledger rows:
 *    - falsy resolution (no todoAPI bridge) — the old `window.todoAPI && dbCall(...)` chain resolved
 *      `false`/`undefined`, indistinguishable from success;
 *    - tomatoAppendMany's row-tolerant {accepted, rejected} result with a NON-EMPTY rejected list —
 *      the accepted rows landed but the rejected rows existed nowhere else; logRejectedRows only
 *      console.error'ed them ("账本是核心资产" violation).
 *  Shared handler for both replay sites (replayPendingLedger + quit-flush flushPendingLedger):
 *    - falsy result → entry KEPT (still pending);
 *    - rejected rows → they are quarantined DURABLY in LS (tomatoRejectedLedgerRows, capped) with a
 *      per-row console.error surface, and the entry is retired (retrying a malformed row can never
 *      succeed — an unbounded replay loop would spin on every later ledger write instead);
 *    - fully accepted → entry removed. tomatoRemoveByIds/TomatoUpdateById never carry `rejected`,
 *      so they retire here exactly as before. */
const REJECTED_LEDGER_KEY = 'tomatoRejectedLedgerRows'
const REJECTED_LEDGER_CAP = 100
// TQ-4 (2026-10-03): same capped-quarantine policy for the snow queue's structurally-terminal
// bumpSnow refusals ({ok:false, reason:'deleted'|'missing'}) — one settlement contract.
const REJECTED_SNOW_KEY = 'tomatoRejectedSnowEntries'
const REJECTED_SNOW_CAP = 100
function quarantineRejectedRows (res, params) {
  if (!res || !Array.isArray(res.rejected) || !res.rejected.length) return
  logRejectedRows(res, params)
  const list = Array.isArray(params) ? params : [params]
  // TQ-6: this quarantine write uses the LOUD primitive (quarantineAppend → raw setItem) and
  // propagates its failure. settleLedgerEntry calls this BEFORE the entry splice, so a failed
  // quarantine leaves the entry pending — the invariant "no entry retired until it exists
  // durably somewhere" is structural, not caller discipline. The old safeSet boolean had zero
  // consumers: a silently failed quarantine retired rejected rows that existed NOWHERE.
  for (const r of res.rejected) {
    const row = list[r && r.index]
    if (row) quarantineAppend(REJECTED_LEDGER_KEY, REJECTED_LEDGER_CAP, { ts: Date.now(), reason: (r && r.reason) || 'unknown', row })
  }
}
function settleLedgerEntry (entry, res) {
  if (!res) return // not handed to a bridge / falsy resolution: still pending, keep for retry
  quarantineRejectedRows(res, entry.params)
  const i = _pendingLedger.indexOf(entry)
  if (i >= 0) {
    _pendingLedger.splice(i, 1)
    removePendingEntry(entry, PENDING_LEDGER_PREFIX) // TQ-2: delete-own-key
  }
  if (entry.op === 'tomatoRemoveByIds') purgePendingAppends(entry.params)
}
/** TQ-2 cross-window gap fix: both same-origin renderer processes (main + float window)
 *  hydrate the queue into a private array, but settle/purge only mutate the settling
 *  process's array + its LS delete-own-key. The OTHER window keeps a stale entry, and its
 *  next replay re-sends it — for ledger appends the db layer's ON CONFLICT DO UPDATE SET
 *  deleted=0 then RESURRECTS a row a peer's remove already deleted. At replay time the LS
 *  mirror is the shared source of truth: an entry whose per-entry key is gone was settled
 *  or purged by a peer, so the local copy is dropped without re-sending. (A mirror write
 *  that failed loudly at enqueue time already surfaced its error to the enqueueing caller —
 *  post-TQ-2 the durability asset is the LS mirror, never the private array.)
 *  Mirror-failed exemption (2026-10-09): the inference "LS key absent ⇒ peer settled it" has a
 *  second cause — OUR OWN savePendingEntry mirror write THREW at enqueue time, so the key never
 *  existed and no peer could have settled it. Treating that absence as settlement made
 *  peerSettled (and every replay/flush path's splice) drop the entry BEFORE any DB send, so an
 *  entry that existed only in the private array was lost permanently — a TQ-4/TQ-5 violation.
 *  Such entries are marked `mirrorFailed = true` at the enqueue catch and are EXEMPT from the
 *  drop: always dispatch. DB ledger/snow ops are idempotent (deterministic tomatoId / dedupKey),
 *  so the worst case of re-sending is a converged duplicate-free upsert, never data loss. */
function peerSettled (entry, prefix) {
  if (entry && entry.mirrorFailed) return false
  let present = null
  try { present = localStorage.getItem(prefix + entry.uid) } catch (e) { present = null }
  return present == null
}
function replayPendingLedger () {
  for (const entry of [..._pendingLedger]) {
    if (peerSettled(entry, PENDING_LEDGER_PREFIX)) {
      const i = _pendingLedger.indexOf(entry)
      if (i >= 0) _pendingLedger.splice(i, 1)
      continue
    }
    Promise.resolve(window.todoAPI && window.todoAPI.dbCall(entry.op, entry.params))
      .then(res => settleLedgerEntry(entry, res))
      .catch(e => console.error('[tomato] ledger DB write failed (queued for retry):', entry.op, e))
  }
}
function ledgerWrite (op, params) {
  const entry = { op, params, seq: nextPendingSeq(), ts: Date.now(), uid: newPendingUid() }
  _pendingLedger.push(entry)
  // TQ-2: put-own-key mirror. A throwing mirror write is loud (propagates) but the entry must
  // stay replayable: peerSettled infers "LS key absent ⇒ peer settled it", which would drop this
  // mirror-failed entry BEFORE any DB send. Mark it so the replay paths dispatch it anyway.
  try { savePendingEntry(entry, PENDING_LEDGER_PREFIX, packLedgerEntry) } catch (e) {
    entry.mirrorFailed = true
    throw e
  }
  // Retry queue: replay any still-pending entries (incl. this one) before/with the new write
  replayPendingLedger()
  hookQuitFlush()
}
function flushPendingLedger () {
  // maint-d7: failed entries NEVER leave the queue — splice happens per-entry only on success
  // (same keep-until-success shape as replayPendingLedger). The old splice-all-then-requeue-in-
  // Promise.all lost every failed entry when the process exited between the IPC dispatch and the
  // aggregate callback (quit-flush: the ack defer can outrun Promise.all), so a transient flush
  // failure permanently dropped the ledger write. Replaying an entry that actually landed is safe:
  // ledger ops are idempotent upserts.
  for (const entry of [..._pendingLedger]) {
    if (peerSettled(entry, PENDING_LEDGER_PREFIX)) { // peer settled/purged it — drop, don't re-send
      const i = _pendingLedger.indexOf(entry)
      if (i >= 0) _pendingLedger.splice(i, 1)
      continue
    }
    Promise.resolve(window.todoAPI && window.todoAPI.dbCall(entry.op, entry.params))
      .then(res => settleLedgerEntry(entry, res))
      .catch(e => console.error('[tomato] ledger flush failed at quit (kept for retry):', entry.op, e))
  }
}
function hookQuitFlush () {
  if (_flushHooked || !window.todoAPI || !window.todoAPI.onAppQuittingFlush) return
  _flushHooked = true
  window.todoAPI.onAppQuittingFlush(() => { flushPendingLedger(); flushPendingSnow() })
}

/** Task-side focus credit (bumpSnow) retry queue — same pending-retry pattern as _pendingLedger.
 *  The old fire-and-forget `commitCommand("todo", "bump", …).catch(() => {})` silently dropped the credit on
 *  a transient IPC/DB failure (lock screen, quit race): the ledger recorded the focus but the task's
 *  focusMinutes/snow never advanced. Entries are removed only on success (bumpSnow is idempotent
 *  per the db layer) and replayed on the next write or at quit-flush.
 *  D5 (2026-09-20): each entry carries `dedupKey = String(startedAt)` — the phase identity the
 *  completion was booked under. The db layer's bumpSnow honors an optional dedupKey so a replayed
 *  entry (retry queue OR quit-flush) cannot double-credit a focus that already landed. Quit-flush
 *  replays the same params object, so every replay path carries the same key. */
/** D14-C2 (2026-10-01): a resolved bump is NOT the same as a credited bump. db.bumpSnow resolves a
 *  STRUCTURED result and never throws on row-level refusal: { ok:false, reason:'deleted'|'missing' }
 *  for a dead task, and the old `window.todoAPI && commitCommand(...)` chain resolves `false` when
 *  no bridge exists. All three shapes used to splice the entry in `.then` (the promise RESOLVED),
 *  silently dropping the task-side focus credit. Now only ok:true retires the entry (ok:true with
 *  deduped:true = already credited on a previous replay — retiring is correct); every non-accepted
 *  result stays queued with its reason surfaced (replays are event-driven, not a timer, so a
 *  permanently dead task costs a bounded log line per future snowWrite, never a hot loop). */
function settleSnowEntry (entry, res) {
  if (res && res.ok === true) {
    const i = _pendingSnow.indexOf(entry)
    if (i >= 0) {
      _pendingSnow.splice(i, 1)
      removePendingEntry(entry, PENDING_SNOW_PREFIX) // TQ-2: delete-own-key
    }
    return
  }
  // TQ-4 (2026-10-03): the two durable queues share ONE settlement contract. The ledger queue
  // already implemented "permanently-unacceptable → durable quarantine + retire"; the snow queue
  // retried everything except ok:true, so db.bumpSnow's STRUCTURALLY-TERMINAL refusals
  // ({ok:false, reason:'deleted'|'missing'} — the UPDATE runs WHERE id=@taskId AND deleted=0, so
  // a hard-deleted/missing task can NEVER accept the bump) replayed forever: monotonic queue
  // growth across restarts plus a dbCall round-trip + error line on every future snowWrite.
  // Terminal refusals are quarantined durably (same capped shape as tomatoRejectedLedgerRows,
  // through the same shared primitive) and retired; falsy/throw/unknown shapes stay retryable.
  if (res && res.ok === false && (res.reason === 'deleted' || res.reason === 'missing')) {
    // Quarantine BEFORE retirement (TQ-6 ordering): if the quarantine write throws, the entry
    // stays pending — retirement requires the data to exist durably somewhere.
    quarantineAppend(REJECTED_SNOW_KEY, REJECTED_SNOW_CAP, { ts: Date.now(), reason: res.reason, params: entry.params })
    const i = _pendingSnow.indexOf(entry)
    if (i >= 0) {
      _pendingSnow.splice(i, 1)
      removePendingEntry(entry, PENDING_SNOW_PREFIX)
    }
    console.error('[tomato] bumpSnow permanently refused (quarantined, retired):', res.reason, entry.params)
    return
  }
  console.error('[tomato] bumpSnow not credited (kept for retry):', (res && res.reason) || String(res), entry.params)
}
function replayPendingSnow () {
  for (const entry of [..._pendingSnow]) {
    if (peerSettled(entry, PENDING_SNOW_PREFIX)) {
      const i = _pendingSnow.indexOf(entry)
      if (i >= 0) _pendingSnow.splice(i, 1)
      continue
    }
    Promise.resolve(window.todoAPI && commitCommand("todo", "bump", entry.params))
      .then(res => settleSnowEntry(entry, res))
      .catch(e => console.error('[tomato] bumpSnow failed (queued for retry):', entry.params, e))
  }
}
function snowWrite (params) {
  const entry = { params, seq: nextPendingSeq(), ts: Date.now(), uid: newPendingUid() }
  _pendingSnow.push(entry)
  // Mirror-failed marking: same contract as ledgerWrite above (peerSettled must not drop an
  // entry whose mirror key never existed because OUR write threw — dispatch is idempotent).
  try { savePendingEntry(entry, PENDING_SNOW_PREFIX, packSnowEntry) } catch (e) { // TQ-2: put-own-key mirror
    entry.mirrorFailed = true
    throw e
  }
  replayPendingSnow()
  hookQuitFlush()
}
function flushPendingSnow () {
  // maint-d7: same keep-until-success shape as flushPendingLedger — a failed bump never leaves the
  // queue, so a quit-flush failure cannot permanently drop the task-side focus credit (bumpSnow is
  // idempotent and every replay carries the same dedupKey, so a double-send cannot double-credit).
  for (const entry of [..._pendingSnow]) {
    if (peerSettled(entry, PENDING_SNOW_PREFIX)) { // peer settled it — drop, don't re-send
      const i = _pendingSnow.indexOf(entry)
      if (i >= 0) _pendingSnow.splice(i, 1)
      continue
    }
    Promise.resolve(window.todoAPI && commitCommand("todo", "bump", entry.params))
      .then(res => settleSnowEntry(entry, res))
      .catch(e => console.error('[tomato] bumpSnow flush failed at quit (kept for retry):', entry.params, e))
  }
}

export { ledgerWrite, snowWrite, purgePendingAppends, hydratePendingQueues }
