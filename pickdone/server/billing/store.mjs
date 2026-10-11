/**
 * PickDone billing — account/order/event/usage store (sandbox vertical).
 *
 * Storage mirrors the sync-relay convention: in-memory by default (tests,
 * sandbox), JSON-file write-through for a self-host-ish deployment of the
 * slice. The money ledger gets its own append-only JSONL via ledger.mjs; the
 * mutable state (accounts/orders/events/subscriptions/usage) is a durable JSON
 * snapshot rewritten on every mutation via writeFileDurable (tmp+fsync+rename,
 * same primitive the relay uses).
 *
 * SECURITY NOTE: account API keys are stored HASHED (sha256) — plaintext keys
 * exist only in the create-account response, like the relay's device secrets.
 * No real payment credentials ever live in this store: provider secrets arrive
 * via env/args at boot and are never persisted here.
 */

import { mkdirSync, readFileSync, existsSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createLedger, verifyChain } from './ledger.mjs'

const require = createRequire(import.meta.url)
let writeFileDurable
try {
  ({ writeFileDurable } = require('../../src/main/durable-fs.js'))
} catch {
  // standalone deployments without the app tree: plain atomic-enough write
  writeFileDurable = (file, data) => {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    require('node:fs').writeFileSync(tmp, data)
    renameSync(tmp, file)
  }
}

export const sha256hex = s => require('node:crypto').createHash('sha256').update(s).digest('hex')

const newId = prefix => `${prefix}_${randomBytes(9).toString('hex')}`
const nowIso = () => new Date().toISOString()

export function createBillingStore ({ dataDir = null, now = Date.now } = {}) {
  const state = {
    accounts: new Map(), // accountId -> { accountId, apiKeyHash, createdAt }
    orders: new Map(), // orderId -> order
    events: new Map(), // `${provider}~${eventId}` -> recorded webhook event
    subscriptions: new Map(), // accountId -> subscription record (or null)
    usage: new Map(), // accountId -> { bytesUsed, updatedAt }
    eventSeq: 0,
  }
  let statePath = null
  let ledgerPath = null
  let appendLine = null
  // Fail-closed health (billing-hardening): when boot finds damaged money
  // history or an unparseable state snapshot, the store comes up in an
  // explicit READ-ONLY unhealthy state instead of quarantining the evidence
  // and silently rebuilding an empty ledger. Reasons:
  //   'ledger-chain-broken' | 'ledger-corrupt-line' | 'ledger-torn-tail'
  //   | 'state-corrupt' | 'ledger-unreadable'
  let health = { healthy: true, reason: null, detail: null }
  let closeLedgerFd = null
  if (dataDir) {
    mkdirSync(dataDir, { recursive: true })
    statePath = join(dataDir, 'billing-state.json')
    ledgerPath = join(dataDir, 'ledger.jsonl')
    // appendLine: fsync-append one JSON line BEFORE the in-memory append —
    // the ledger is created ONCE here with the writer attached, so boot-load
    // and later appends share the same backing array.
    const { openSync, writeSync, fsyncSync, closeSync } = require('node:fs')
    let fd = null
    appendLine = entry => {
      if (fd === null) fd = openSync(ledgerPath, 'a')
      writeSync(fd, JSON.stringify(entry) + '\n')
      fsyncSync(fd)
    }
    // Release the append fd: an open handle would block atomic renames over
    // ledger.jsonl on Windows (recoverLedger + the next writeFileDurable
    // state persist), and it leaks a descriptor per store instance.
    closeLedgerFd = () => {
      if (fd !== null) {
        try { closeSync(fd) } finally { fd = null }
      }
    }
  }
  const ledger = createLedger({ appendLine })

  const persist = () => {
    if (!statePath) return
    writeFileDurable(statePath, Buffer.from(JSON.stringify({
      accounts: [...state.accounts.values()],
      orders: [...state.orders.values()],
      events: [...state.events.values()],
      subscriptions: [...state.subscriptions.entries()],
      usage: [...state.usage.entries()],
      eventSeq: state.eventSeq,
    }, null, 1)))
  }

  // ---------- ledger scan (classification only — bytes never touched) ------
  /** Classify the ledger file into (verified prefix, anomaly) WITHOUT ever
   *  touching the bytes on disk. Anomaly kinds:
   *    - 'ledger-torn-tail': last line unterminated or unparseable — the
   *      signature of a crash mid-append. appendLine fsyncs the WHOLE line
   *      (terminator included) before the entry is ever acknowledged, so a
   *      torn tail was never acked; explicit recovery may drop it.
   *    - 'ledger-corrupt-line': unparseable/blank line anywhere else —
   *      external corruption, manual reconciliation only.
   *    - 'ledger-chain-broken': entries parse but the hash chain does not —
   *      retro-edit/deletion/reorder (tamper), manual reconciliation only.
   *  `prefix` is everything cryptographically intact BEFORE the anomaly. */
  const scanLedgerFile = () => {
    const raw = readFileSync(ledgerPath, 'utf8')
    const lines = raw.split('\n')
    const unterminatedTail = raw.length > 0 && !raw.endsWith('\n')
    const entries = []
    let anomaly = null
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const isLast = i === lines.length - 1
      if (!line.trim()) {
        if (isLast) continue // artifact of the trailing newline
        anomaly = { kind: 'ledger-corrupt-line', line: i + 1, detail: 'blank line mid-file' }
        break
      }
      let parsed
      try {
        parsed = JSON.parse(line)
      } catch (e) {
        anomaly = (isLast && unterminatedTail)
          ? { kind: 'ledger-torn-tail', line: i + 1, detail: e.message }
          : { kind: 'ledger-corrupt-line', line: i + 1, detail: e.message }
        break
      }
      if (isLast && unterminatedTail) {
        // complete JSON but no newline: a fsync'd append always writes the
        // terminator, so this file was hand-touched or externally modified —
        // never acknowledged in this shape. Treat as torn; recovery keeps the
        // tail entry ONLY if it chain-extends the prefix (same trust level as
        // any booted entry), else drops it. Either way bytes are archived.
        anomaly = { kind: 'ledger-torn-tail', line: i + 1, detail: 'missing trailing newline', tailEntry: parsed }
        break
      }
      entries.push(parsed)
    }
    const v = verifyChain(entries)
    if (!v.ok) {
      // chain evidence wins over parse-phase kinds; keep only the intact prefix
      const brokenIdx = entries.findIndex(e => e.seq === v.brokenAt)
      return {
        raw,
        prefix: brokenIdx >= 0 ? entries.slice(0, brokenIdx) : [],
        anomaly: { kind: 'ledger-chain-broken', brokenAt: v.brokenAt, line: brokenIdx + 1 },
      }
    }
    return { raw, prefix: entries, anomaly }
  }

  // ---------- file boot / JSONL ledger wiring ----------
  if (dataDir) {
    if (existsSync(ledgerPath)) {
      let scan = null
      try {
        scan = scanLedgerFile()
      } catch (e) {
        health = { healthy: false, reason: 'ledger-unreadable', detail: { error: e.message } }
      }
      if (scan) {
        if (scan.anomaly) {
          // FAIL CLOSED: never rename/quarantine, never rebuild. Boot with
          // the intact prefix loaded READ-ONLY and refuse every write until
          // an operator resolves the damage (torn tails may use the explicit
          // recoverLedger() entry; everything else is manual, out of band).
          health = { healthy: false, reason: scan.anomaly.kind, detail: scan.anomaly }
          ledger.loadReadOnly(scan.prefix)
        } else {
          ledger.loadVerified(scan.prefix)
        }
      }
    }
    // rebuild mutable state from the durable snapshot
    if (existsSync(statePath)) {
      try {
        const raw = JSON.parse(readFileSync(statePath, 'utf8'))
        for (const a of raw.accounts || []) state.accounts.set(a.accountId, a)
        for (const o of raw.orders || []) state.orders.set(o.orderId, o)
        for (const e of raw.events || []) state.events.set(`${e.provider}~${e.eventId}`, e)
        for (const [k, v] of raw.subscriptions || []) state.subscriptions.set(k, v)
        for (const [k, v] of raw.usage || []) state.usage.set(k, v)
        state.eventSeq = raw.eventSeq || 0
      } catch (e) {
        // FAIL CLOSED: an unparseable state snapshot means entitlement state
        // cannot be trusted — read-only isolation instead of booting on
        // defaults (the old behavior quarantined the file and served, which
        // silently wiped every account/subscription).
        health = { healthy: false, reason: 'state-corrupt', detail: { error: e.message } }
      }
    }
    if (!health.healthy && !ledger.isReadOnly()) ledger.loadReadOnly(ledger.all())
  }

  const assertWritable = () => {
    if (!health.healthy) {
      const err = new Error(`billing store READ-ONLY (${health.reason}) — write refused until operator resolution`)
      err.code = 'BILLING_READONLY'
      throw err
    }
  }

  const getOrder = orderId => state.orders.get(orderId) || null

  return {
    kind: dataDir ? 'file' : 'memory',
    ledger,
    now,
    /** Fail-closed gate: false ⇒ every mutating path (store methods, webhook
     *  processing, entitlement grants) must refuse. */
    isWritable: () => health.healthy,
    getLedgerHealth: () => ({ ...health }),
    /** Explicit operator recovery — the ONLY write path while unhealthy, and
     *  offered EXCLUSIVELY for a torn tail (crash mid-append: the tail line
     *  was never fsync-acked, so dropping it loses no acknowledged fact).
     *  Every original byte is archived to `<ledger>.torn-<ts>` first; files
     *  are never deleted. Tampering/corruption/state damage is NEVER
     *  auto-repaired — reconcile manually out of band, fix the file, restart. */
    recoverLedger () {
      if (!dataDir) return { recovered: false, reason: 'memory-mode-nothing-to-recover' }
      if (health.healthy) return { recovered: false, reason: 'already-healthy' }
      if (health.reason !== 'ledger-torn-tail') {
        return { recovered: false, reason: 'manual-reconciliation-required', detail: health.detail }
      }
      // Re-scan from disk: the store refused all writes while unhealthy, so
      // the bytes are exactly what boot saw. The append fd is necessarily
      // closed here (no append ever succeeded in this process), so the
      // atomic rewrite below cannot hit a Windows rename lock.
      const scan = scanLedgerFile()
      if (!scan.anomaly || scan.anomaly.kind !== 'ledger-torn-tail') {
        return { recovered: false, reason: 'state-changed-since-boot', detail: scan.anomaly }
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const archivePath = `${ledgerPath}.torn-${stamp}`
      writeFileSync(archivePath, scan.raw, 'utf8') // byte-exact evidence copy
      // Keep the prefix; an unterminated PARSEABLE tail entry re-joins only
      // when it chain-extends (verified identically to a boot load), else it
      // is dropped as unacked — the provider redelivers those events.
      let restored = scan.prefix
      if (scan.anomaly.tailEntry) {
        const withTail = [...scan.prefix, scan.anomaly.tailEntry]
        if (verifyChain(withTail).ok) restored = withTail
      }
      const kept = restored.length
        ? restored.map(e => JSON.stringify(e)).join('\n') + '\n'
        : ''
      writeFileDurable(ledgerPath, Buffer.from(kept, 'utf8'))
      const rescan = scanLedgerFile()
      if (rescan.anomaly) { // cannot happen; refuse rather than guess
        health = { healthy: false, reason: rescan.anomaly.kind, detail: rescan.anomaly }
        ledger.loadReadOnly(rescan.prefix)
        return { recovered: false, reason: rescan.anomaly.kind, detail: rescan.anomaly }
      }
      ledger.loadVerified(rescan.prefix)
      health = { healthy: true, reason: null, detail: null }
      return { recovered: true, archivedTo: archivePath, restoredEntries: rescan.prefix.length }
    },

    // ---------- identity (mock, sandbox slice) ----------
    createAccount () {
      assertWritable()
      const accountId = newId('acct')
      const apiKey = `pd_sk_${randomBytes(24).toString('hex')}`
      state.accounts.set(accountId, { accountId, apiKeyHash: sha256hex(apiKey), createdAt: nowIso() })
      persist()
      return { accountId, apiKey }
    },
    /** Resolve an account from a Bearer credential. Constant-ish compare via
     *  hash lookup: unknown hash and known hash take the same code path. */
    accountByApiKey (apiKey) {
      if (typeof apiKey !== 'string' || !apiKey) return null
      const hash = sha256hex(apiKey)
      for (const a of state.accounts.values()) {
        if (a.apiKeyHash === hash) return a
      }
      return null
    },
    getAccount: accountId => state.accounts.get(accountId) || null,

    // ---------- orders ----------
    insertOrder (order) { assertWritable(); state.orders.set(order.orderId, order); persist(); return order },
    getOrder,
    listAllOrders: () => [...state.orders.values()],
    listOrdersByAccount (accountId) {
      return [...state.orders.values()].filter(o => o.accountId === accountId)
    },
    patchOrder (orderId, patch) {
      assertWritable()
      const o = state.orders.get(orderId)
      if (!o) return null
      Object.assign(o, patch)
      persist()
      return o
    },

    // ---------- webhook events (raw, deduped) ----------
    /** Unique on (provider, eventId). Returns the existing record on a repeat —
     *  the caller treats that as `duplicate` and applies NO effects. */
    findEvent (provider, eventId) {
      return state.events.get(`${provider}~${eventId}`) || null
    },
    recordEvent (event) {
      assertWritable()
      const key = `${event.provider}~${event.eventId}`
      if (state.events.has(key)) return { duplicate: true, event: state.events.get(key) }
      state.eventSeq += 1
      const record = { ...event, seq: state.eventSeq, recordedAt: nowIso() }
      state.events.set(key, record)
      persist()
      return { duplicate: false, event: record }
    },
    /** Deferred (received-out-of-order) events for an order, arrival order. */
    deferredEvents (orderId) {
      return [...state.events.values()]
        .filter(e => e.orderId === orderId && e.deferred)
        .sort((a, b) => a.seq - b.seq)
    },
    patchEvent (provider, eventId, patch) {
      assertWritable()
      const key = `${provider}~${eventId}`
      const e = state.events.get(key)
      if (!e) return null
      Object.assign(e, patch)
      persist()
      return e
    },
    listEvents: () => [...state.events.values()].sort((a, b) => a.seq - b.seq),

    // ---------- subscription + usage ----------
    getSubscription: accountId => state.subscriptions.get(accountId) || null,
    setSubscription (accountId, sub) { assertWritable(); state.subscriptions.set(accountId, sub); persist() },
    getUsage: accountId => state.usage.get(accountId) || { bytesUsed: 0, updatedAt: null },
    setUsage (accountId, bytesUsed) {
      assertWritable()
      state.usage.set(accountId, { bytesUsed, updatedAt: nowIso() })
      persist()
    },

    // ---------- test/admin introspection ----------
    counts: () => ({
      accounts: state.accounts.size,
      orders: state.orders.size,
      events: state.events.size,
    }),
    flush: () => {},
    close: () => { if (closeLedgerFd) closeLedgerFd() },
  }
}
