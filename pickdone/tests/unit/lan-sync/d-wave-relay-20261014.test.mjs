/**
 * Fix wave F4 (relay sync domain), 2026-10-14 — regression tests:
 *
 *   1. [P1] relay v2 pull channel materialized ONLY todo entities while the cursor
 *      advanced / client acked / relay gc() deleted the envelopes → remote
 *      settings/tomato/... changes were silently and unrecoverably lost on the relay
 *      channel. Fix: the business apply runs inside the client's cursor gate — the
 *      cursor holds at the last materialized envelope, the batch is re-pulled
 *      (idempotent), and the round result carries a `warning`. Protocol exercise lives
 *      in d-wave-relay-20261014.worker.mjs (worker isolation — see relay-413-drain
 *      header for the win32 libuv teardown rationale).
 *
 *   2. relay putSnapshot accepted a LOWER-generation snapshot's content while keeping
 *      the highest generation (max() clamp on the label, unconditional overwrite of
 *      coversSeq/data) — stale content rebranded as newest for bootstrapping peers.
 *      Fix: a regressing PUT is refused (coded 409); equal generation stays idempotent.
 *      Pinned for BOTH backends (memory here, sqlite via a node:sqlite-backed shim so
 *      the test runs on plain node without better-sqlite3).
 *
 *   3. relay client fetch had no timeout: a half-dead relay hung every POST on
 *      undici's ~300s default × retries × both round steps. Fix: per-request
 *      AbortSignal.timeout (caller-configurable fetchTimeoutMs, default 30s); the
 *      timeout error is coded 'RELAY_FETCH_TIMEOUT' with no .status → classified
 *      RETRYABLE by the adapter (transport-level uncertainty, like a network throw).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

test('relay v2: unmaterializable envelopes hold the cursor and stay re-pullable (no silent ack+GC loss)', async () => {
  const { failures } = await new Promise((resolve, reject) => {
    const worker = new Worker(path.join(path.dirname(fileURLToPath(import.meta.url)), 'd-wave-relay-20261014.worker.mjs'), { stderr: true })
    let errTail = ''
    let got = false
    worker.stderr.on('data', d => { errTail = (errTail + d).slice(-800) })
    worker.on('message', msg => { got = true; resolve(msg) })
    worker.on('error', reject)
    worker.on('exit', code => { if (!got && code !== 0) reject(new Error(`d-wave worker exited ${code}\nstderr: ${errTail}`)) })
  })
  assert.deepEqual(failures, [], 'worker-reported failures')
})

test('relay putSnapshot: a lower-generation PUT is refused (409) and latest keeps the higher generation', async () => {
  const { memoryStore, createRelay } = await import(pathToFileURL(path.join(ROOT, 'server/sync-relay.mjs')))
  const relay = createRelay(memoryStore())
  const gen3 = {
    snapshotId: 'snap-3-devA', generation: 3, coversSeq: 30, authorDeviceId: 'devA',
    createdAt: 1000, entities: [{ revisionId: 'r3', payload: 'content-of-gen-3' }],
  }
  relay.putSnapshot('acc', gen3)
  assert.throws(() => relay.putSnapshot('acc', {
    snapshotId: 'snap-2-devB', generation: 2, coversSeq: 20, authorDeviceId: 'devB',
    createdAt: 900, entities: [{ revisionId: 'r2', payload: 'STALE-content-of-gen-2' }],
  }), e => e.status === 409 && /generation regression/.test(e.message), 'a gen-2 PUT after gen-3 must be a coded 409')
  const latest = relay.latestSnapshot('acc')
  assert.equal(latest.generation, 3, 'latest generation unchanged')
  assert.equal(latest.snapshotId, 'snap-3-devA', 'latest content is still gen-3 (not overwritten by the stale PUT)')
  assert.equal(latest.entities[0].payload, 'content-of-gen-3')
  // equal generation: idempotent re-put of the SAME snapshot is accepted
  relay.putSnapshot('acc', { ...gen3, createdAt: 1001 })
  assert.equal(relay.latestSnapshot('acc').generation, 3)
})

test('relay putSnapshot (sqlite backend): same refusal via a node:sqlite-backed driver shim', async t => {
  const { sqliteStore } = await import(pathToFileURL(path.join(ROOT, 'server/sync-relay-sqlite.mjs')))
  const { mkdtempSync, rmSync } = await import('node:fs')
  const os = await import('node:os')
  // better-sqlite3 only loads under the app's node; sqliteStore accepts an injected
  // Database — shim node:sqlite's DatabaseSync with the better-sqlite3-ish surface.
  class DatabaseShim {
    constructor(p) { this.db = new DatabaseSync(p) }
    pragma(s) { return this.db.exec(`PRAGMA ${s}`) }
    prepare(s) { return this.db.prepare(s) }
    exec(s) { return this.db.exec(s) }
    close() { return this.db.close() }
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay-dwave-sql-'))
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ } })
  const store = sqliteStore(path.join(dir, 'relay.db'), { Database: DatabaseShim })
  store.putSnapshot('acc', { snapshotId: 'snap-3', generation: 3, coversSeq: 30, data: 'gen-3-data' })
  assert.throws(() => store.putSnapshot('acc', { snapshotId: 'snap-2', generation: 2, coversSeq: 20, data: 'STALE' }),
    e => e.status === 409 && /generation regression/.test(e.message))
  const latest = store.latestSnapshot('acc')
  assert.equal(latest.generation, 3)
  assert.equal(latest.data, 'gen-3-data', 'sqlite latest still holds gen-3 content')
  store.close()
})

test('relay client: a hung relay POST fails fast via AbortSignal.timeout and is classified retryable', async () => {
  const { createRelayClient } = await import(pathToFileURL(path.join(ROOT, 'shared/sync-transport/https/relay-client.mjs')))
  const { isRetryable } = require(path.join(ROOT, 'src/main/relay-sync-adapter.js'))
  const TIMEOUT_MS = 80
  // Stub fetch that HONORS the abort signal and then hangs forever — exactly the
  // half-dead-relay shape (socket open, no response) that used to ride undici's
  // ~300s default per request.
  const hangingFetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const e = new Error('This operation was aborted')
      e.name = 'TimeoutError' // AbortSignal.timeout aborts with a TimeoutError reason
      reject(e)
    })
    // never resolves on its own
  })
  const client = createRelayClient({
    nodeId: 'devT', account: 'acc', baseUrl: 'http://127.0.0.1:1', // unreachable by construction
    fetchImpl: hangingFetch, fetchTimeoutMs: TIMEOUT_MS,
  })
  // AbortSignal.timeout uses an unref'd timer in Node. A synthetic fetch that
  // never opens a socket leaves no ref'd handles, so node:test cancels the test
  // before the timeout can fire. Keep a socket-equivalent handle alive only
  // while exercising the hung request; real fetch sockets provide this handle.
  const keepAlive = setTimeout(() => {}, TIMEOUT_MS + 3000)
  const started = Date.now()
  try {
    await assert.rejects(client.register(), e => {
      assert.equal(e.code, 'RELAY_FETCH_TIMEOUT', 'timeout failure must carry the coded marker')
      assert.equal(e.status, undefined, 'no HTTP status → transport-level uncertainty')
      return true
    })
  } finally {
    clearTimeout(keepAlive)
  }
  const elapsed = Date.now() - started
  assert.ok(elapsed < TIMEOUT_MS + 2000, `hung request must fail fast (~${TIMEOUT_MS}ms), took ${elapsed}ms`)
  // and the adapter classifies the coded timeout as retryable (network-throw bucket)
  const err = Object.assign(new Error('relay /v1/device/register timed out after 80ms'), { code: 'RELAY_FETCH_TIMEOUT' })
  assert.equal(isRetryable(err), true, 'timeout must be retryable')
  assert.equal(isRetryable(Object.assign(new Error('nope'), { noRetry: true })), false, 'noRetry (deterministic apply failure) must not retry')
})
