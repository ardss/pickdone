/**
 * Worker body for d-wave-relay-20261014.test.mjs (fix F4 wave 2026-10-14).
 *
 * Exercises the FULL relay loopback (real HTTP relay + real adapter + real
 * relay-sync-apply against a real temp db) — the same protocol shapes that trip the
 * win32 libuv teardown assert when run in the runner process (see relay-413-drain
 * header): every server/client handle dies with this worker thread.
 *
 * Regression under test — relay v2 pull channel materialized ONLY todo entities while
 * the cursor advanced, the client acked, and relay gc() deleted the envelopes: remote
 * settings/tomato/category/plan/filter/meta changes were silently and unrecoverably
 * lost on the relay channel (LAN channel was fine). Fix: the pull-side business apply
 * runs INSIDE the client's cursor gate; a batch containing frames the business layer
 * cannot materialize holds the cursor at the last vouched frame — the unmaterialized
 * envelopes are re-pulled every round (idempotent) instead of acked into GC, and the
 * round result carries a `warning`.
 */
import { parentPort } from 'node:worker_threads'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(import.meta.url)
const db = require(path.join(ROOT, 'src/main/db.js'))
const { applyPulledEnvelopes } = require(path.join(ROOT, 'src/main/relay-sync-apply.js'))
const { createRelayAdapter } = require(path.join(ROOT, 'src/main/relay-sync-adapter.js'))
const { memoryStore, createRelay, startRelayServer } = await import(pathToFileURL(path.join(ROOT, 'server/sync-relay.mjs')))
const { createRelayClient } = await import(pathToFileURL(path.join(ROOT, 'shared/sync-transport/https/relay-client.mjs')))
const { createRevisionStore } = await import(pathToFileURL(path.join(ROOT, 'shared/sync-core/causality/merge.mjs')))
const e2e = await import(pathToFileURL(path.join(ROOT, 'shared/sync-crypto/e2e.mjs')))

const failures = []
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-dwave-'))
db.init(tmp)

const relay = createRelay(memoryStore())
const server = await startRelayServer(relay, { port: 0, host: '127.0.0.1' })
const base = `http://127.0.0.1:${server.address().port}`
const account = 'dwave-acc-20261014'
const rootKey = 'ab'.repeat(32)
const dataKey = e2e.deriveDataKey(rootKey)

try {
  // --- Device A: push a MIXED batch — one todo envelope then one settings envelope.
  const clientA = createRelayClient({ nodeId: 'devA', account, baseUrl: base, dataKey })
  const now = Date.now()
  await clientA.commit('todo-dw1', {
    id: 'todo-dw1', userId: 'u1', content: 'dwave regression todo', deleted: 0,
    createdAt: now, updatedAt: now, sort: 0,
  }, 'todo')
  await clientA.commit('setting-dw1', { key: 'sync.dwave.probe', value: 'v1' }, 'settings')
  const pushRound = await clientA.round()
  if (pushRound.pushed !== 2) failures.push(`device A push: expected 2 envelopes pushed, got ${pushRound.pushed}`)

  // --- Device B: the real adapter with the REAL pull-side apply bridge (temp db).
  const mem = new Map()
  const settingsGet = k => (mem.has(k) ? mem.get(k) : null)
  const settingsPut = (k, v) => { if (v === '') mem.delete(k); else mem.set(k, String(v)) }
  const adapter = createRelayAdapter({
    nodeId: 'devB', settingsGet, settingsPut,
    loadStore: async () => createRevisionStore('devB'),
    applyPulled: (received, store, nodeId) => applyPulledEnvelopes(received, store, nodeId),
    fetchImpl: fetch,
  })
  const en = await adapter.enable({ account, baseUrl: base, rootKey })
  if (!en.firstRound || en.firstRound.ok !== true) failures.push('enable first round not ok: ' + JSON.stringify(en.firstRound))
  // The FIRST round (enable's) already pulled the mixed batch: the todo materialized,
  // the cursor stopped at the todo's seq instead of crossing the settings envelope.
  if (en.firstRound.businessApplied !== 1) failures.push(`first round: expected the todo materialized (businessApplied=1), got ${en.firstRound.businessApplied}`)
  if (en.firstRound.cursor !== 1) failures.push(`first round: cursor must stop at the last materialized todo (seq 1), got ${en.firstRound.cursor} — it crossed the unmaterialized settings envelope`)
  if (!en.firstRound.warning) failures.push('first round: expected a warning field on the cursor-holding round, got none')
  const persisted = JSON.parse(mem.get('state') || '{}')
  if (persisted.cursor !== 1) failures.push(`first round: durable cursor persisted as ${persisted.cursor}, expected 1`)

  const round1 = await adapter.round()
  if (!round1.ok) failures.push('round1 failed: ' + JSON.stringify(round1))
  if (round1.cursor !== 1) failures.push(`round1: cursor still pinned at 1 expected, got ${round1.cursor}`)
  if (round1.pulled < 1) failures.push(`round1: expected the settings envelope to be re-pulled (pulled=${round1.pulled})`)
  if (!round1.warning) failures.push('round1: expected the warning field to persist while the cursor is held, got none')

  // The todo actually landed in the business table (not just the ephemeral DAG).
  const todos = db.queryTodos({ deleted: 0 })
  const hit = todos.find(t => (t.taskId || t.id) === 'todo-dw1')
  if (!hit) failures.push('round1: the pulled todo row never reached the business table (rows: ' + todos.length + ')')

  // --- Round 2: the settings envelope MUST still be delivered (never acked into GC).
  const round2 = await adapter.round()
  if (!round2.ok) failures.push('round2 failed: ' + JSON.stringify(round2))
  if (round2.cursor !== 1) failures.push(`round2: cursor still pinned at 1 expected, got ${round2.cursor}`)
  if (round2.pulled < 1) failures.push(`round2: expected the settings envelope to be re-pulled (pulled=${round2.pulled})`)

  // And directly from the relay: the envelope survives ack + gc attempt. Envelopes are
  // sealed (E2E data key) — open before inspecting.
  const replay = relay.pull(account, 1, 8 * 1024 * 1024)
  if (!replay.items.length) failures.push('relay lost the unmaterialized envelope: pull after seq 1 returned nothing (acked/GC-ed)')
  else {
    const stillThere = replay.items.some(it => {
      try { return e2e.open(dataKey, it.envelope).entityId === 'setting-dw1' } catch { return false }
    })
    if (!stillThere) failures.push('relay pull after seq 1 no longer contains the settings envelope')
  }

  // Own-device frames must NEVER hold the cursor (the app's recorder mints bookkeeping
  // settings/meta revisions on every write): an OWN settings envelope applies as a no-op
  // with verdict 'ok', while the SAME entity from a peer is 'blocked'.
  const mkEnv = (entity, entityId, dev) => ({
    revisionId: `rt-dbg-${entityId}-${dev}`, entity, entityId,
    authorDeviceId: dev, hlc: { physical: Date.now(), logical: 0, nodeId: dev },
    payload: { id: entityId, key: entityId },
  })
  const own = applyPulledEnvelopes(
    [{ envelope: mkEnv('settings', 'own-bookkeeping', 'devB'), status: 'applied' }], createRevisionStore('devB'), 'devB')
  if (!(own.verdicts.get('rt-dbg-own-bookkeeping-devB') === 'ok') || own.businessSkipped < 1) {
    failures.push('own-device non-todo envelope must classify ok (cursor never held on own frames): ' + JSON.stringify([...own.verdicts]))
  }
  const peer = applyPulledEnvelopes(
    [{ envelope: mkEnv('settings', 'peer-bookkeeping', 'devA'), status: 'applied' }], createRevisionStore('devB'), 'devB')
  if (peer.verdicts.get('rt-dbg-peer-bookkeeping-devA') !== 'blocked') {
    failures.push('peer non-todo envelope must classify blocked: ' + JSON.stringify([...peer.verdicts]))
  }
} catch (e) {
  failures.push('unexpected: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e)))
} finally {
  server.closeIdleConnections?.()
  server.closeAllConnections?.()
  await new Promise(resolve => server.close(resolve))
  try { db.close() } catch { /* temp db teardown best-effort */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* temp dir best-effort */ }
}
parentPort.postMessage({ failures })
setTimeout(() => process.exit(failures.length ? 1 : 0), 150)
