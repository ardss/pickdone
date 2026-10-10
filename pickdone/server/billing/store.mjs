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

import { mkdirSync, readFileSync, existsSync, renameSync, unlinkSync } from 'node:fs'
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
  if (dataDir) {
    mkdirSync(dataDir, { recursive: true })
    statePath = join(dataDir, 'billing-state.json')
    ledgerPath = join(dataDir, 'ledger.jsonl')
    // appendLine: fsync-append one JSON line BEFORE the in-memory append —
    // the ledger is created ONCE here with the writer attached, so boot-load
    // and later appends share the same backing array.
    const { openSync, writeSync, fsyncSync } = require('node:fs')
    let fd = null
    appendLine = entry => {
      if (fd === null) fd = openSync(ledgerPath, 'a')
      writeSync(fd, JSON.stringify(entry) + '\n')
      fsyncSync(fd)
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

  // ---------- file boot / JSONL ledger wiring ----------
  if (dataDir) {
    if (existsSync(ledgerPath)) {
      const scanned = readFileSync(ledgerPath, 'utf8').split('\n')
        .filter(l => l.trim())
        .map(l => JSON.parse(l))
      // fail closed on tampered money history: quarantine + fresh boot, the
      // operator must investigate — we never serve billing on a broken chain.
      const v = verifyChain(scanned)
      if (!v.ok) {
        renameSync(ledgerPath, `${ledgerPath}.bad`)
        console.error(`[billing] ledger chain BROKEN at seq ${v.brokenAt} — quarantined to ledger.jsonl.bad, starting fresh (INVESTIGATE)`)
      } else {
        ledger.loadVerified(scanned)
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
        renameSync(statePath, `${statePath}.bad`)
        console.error(`[billing] state file unparseable — quarantined to billing-state.json.bad (${e.message})`)
      }
    }
  }

  const getOrder = orderId => state.orders.get(orderId) || null

  return {
    kind: dataDir ? 'file' : 'memory',
    ledger,
    now,
    // ---------- identity (mock, sandbox slice) ----------
    createAccount () {
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
    insertOrder (order) { state.orders.set(order.orderId, order); persist(); return order },
    getOrder,
    listAllOrders: () => [...state.orders.values()],
    listOrdersByAccount (accountId) {
      return [...state.orders.values()].filter(o => o.accountId === accountId)
    },
    patchOrder (orderId, patch) {
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
    setSubscription (accountId, sub) { state.subscriptions.set(accountId, sub); persist() },
    getUsage: accountId => state.usage.get(accountId) || { bytesUsed: 0, updatedAt: null },
    setUsage (accountId, bytesUsed) {
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
    close: () => {},
  }
}
