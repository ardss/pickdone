/**
 * PickDone billing — append-only, hash-charged money ledger.
 *
 * Every money event that the SERVER verified (charge / refund / chargeback)
 * lands here exactly once, in arrival order, and is never updated or deleted.
 * Each entry commits to the previous entry's hash, so any retroactive edit or
 * silent deletion breaks verifyChain() — that is the tamper-evidence story for
 * reconciliation and audits.
 *
 * This is an AUDIT ledger, NOT a stored-value wallet: entries record what the
 * provider reported and what the server granted (subscription entitlements).
 * No user-spendable balance exists, on purpose — stored-value wallets raise
 * prepaid/escrow compliance questions this slice deliberately avoids.
 */

import { createHash } from 'node:crypto'

export const sha256hex = s => createHash('sha256').update(s).digest('hex')

export const LEDGER_TYPES = new Set(['charge', 'refund', 'chargeback'])

function entryHash (e) {
  return sha256hex([
    e.seq, e.ts, e.type, e.accountId ?? '', e.orderId ?? '',
    e.amountMinor ?? '', e.currency ?? '', e.provider ?? '', e.providerRef ?? '',
    e.eventId ?? '', e.prevHash,
  ].join('|'))
}

/** Build (but do not store) the next entry for `tail`. Pure so the store owns
 *  sequencing; also reused by verifyChain to recompute hashes identically. */
export function buildEntry (tail, fields) {
  const type = fields.type
  if (!LEDGER_TYPES.has(type)) throw new Error(`ledger: unknown entry type "${type}"`)
  if (fields.amountMinor !== undefined) {
    if (!Number.isSafeInteger(fields.amountMinor) || fields.amountMinor <= 0) {
      throw new Error('ledger: amountMinor must be a positive safe integer')
    }
  }
  const entry = {
    seq: (tail ? tail.seq : 0) + 1,
    ts: fields.ts ?? Date.now(),
    type,
    accountId: fields.accountId ?? null,
    orderId: fields.orderId ?? null,
    amountMinor: fields.amountMinor ?? null,
    currency: fields.currency ?? null,
    provider: fields.provider ?? null,
    providerRef: fields.providerRef ?? null,
    eventId: fields.eventId ?? null,
    prevHash: tail ? tail.hash : 'GENESIS',
  }
  entry.hash = entryHash(entry)
  return entry
}

/** Verify the whole chain (genesis → tail). Returns { ok, brokenAt? } —
 *  brokenAt is the seq of the first entry whose stored hash no longer matches
 *  its contents/lineage (retro-edit, deletion, or reordering). */
export function verifyChain (entries) {
  let tail = null
  for (const e of entries) {
    if (e.seq !== (tail ? tail.seq + 1 : 1)) return { ok: false, brokenAt: e.seq }
    if (e.prevHash !== (tail ? tail.hash : 'GENESIS')) return { ok: false, brokenAt: e.seq }
    if (entryHash(e) !== e.hash) return { ok: false, brokenAt: e.seq }
    tail = e
  }
  return { ok: true }
}

/** Append-only view over an in-memory array + optional JSONL write-through.
 *  The array is the source of truth in-process; when `ledgerPath` is given,
 *  every append is fsynced to disk (JSONL, one entry per line) BEFORE the
 *  in-memory append resolves — a crash can lose nothing already acked.
 *
 *  Fail-closed isolation: after boot loads a damaged-ledger VERIFIED PREFIX
 *  via loadReadOnly(), the ledger flips read-only and EVERY append is
 *  refused — money history must never silently continue on a fresh chain
 *  while the broken segment sits unexplained. */
export function createLedger ({ ledgerPath = null, appendLine = null } = {}) {
  const entries = []
  let readOnly = false
  return {
    kind: appendLine ? 'file' : 'memory',
    isReadOnly: () => readOnly,
    tail: () => (entries.length ? entries[entries.length - 1] : null),
    all: () => entries.slice(),
    append (fields) {
      if (readOnly) {
        const err = new Error('billing ledger is READ-ONLY (unhealthy isolation) — append refused')
        err.code = 'LEDGER_READONLY'
        throw err
      }
      const entry = buildEntry(this.tail(), fields)
      if (appendLine) appendLine(entry) // throws → nothing enters memory (fail closed)
      entries.push(entry)
      return entry
    },
    verify: () => verifyChain(entries),
    /** Restore from a JSONL boot scan; verifies BEFORE accepting (quarantine
     *  is the caller's job — see store.mjs file boot). Returns read-write. */
    loadVerified (scanned) {
      const v = verifyChain(scanned)
      if (!v.ok) {
        const err = new Error(`billing ledger chain broken at seq ${v.brokenAt} — refusing to boot on tampered money history`)
        err.code = 'LEDGER_CHAIN_BROKEN'
        throw err
      }
      entries.length = 0
      entries.push(...scanned)
      readOnly = false
      return entries.length
    },
    /** Read-only isolation boot: load the cryptographically-intact PREFIX of
     *  a damaged ledger so operators can reconcile what is provably theirs,
     *  while appends stay refused until an operator resolves the damage. */
    loadReadOnly (prefix) {
      const v = verifyChain(prefix)
      if (!v.ok) {
        const err = new Error(`billing ledger: read-only prefix fails verification at seq ${v.brokenAt}`)
        err.code = 'LEDGER_CHAIN_BROKEN'
        throw err
      }
      entries.length = 0
      entries.push(...prefix)
      readOnly = true
      return entries.length
    },
  }
}
