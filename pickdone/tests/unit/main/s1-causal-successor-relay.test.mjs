import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createRelay, startRelayServer, memoryStore } from '../../../server/sync-relay.mjs'
import { generateAccountRootKey } from '../../../shared/sync-crypto/e2e.mjs'

/**
 * S1 acceptance, Sync v2 runtime — a slow-clock CAUSAL SUCCESSOR must beat a fast-clock
 * ANCESTOR in the BUSINESS table (not only in the revision DAG).
 *
 * Shape (the drill S1 scenario replayed over the REAL relay runtime entry):
 *   A (fast business clock) authors the row  → updateTime = now + 1 year.
 *   B pulls it, then edits LATER with a sane updateTime (its revision parents onto A's
 *   head, so B's revision is a causal CHILD of A's — ingestRemote sets the current).
 *   A pulls B's child: the DAG rules it descendant/current, but the business
 *   materialization ran the v1 LWW — the year-future stamp won and B's edit was dropped
 *   from A's todos table. v2 bar: the DAG's causal ruling must carry into the business
 *   apply for DAG-current envelopes (opt-in by construction: only the relay pull path
 *   stamps it; LAN sync and the v1 default path stay byte-identical).
 *
 * RED first (failure-first discipline): the convergence assert below failed while the
 * business apply was pure LWW — this file pins the fix, it does not loosen v1.
 *
 * Run: node --test tests/unit/main/s1-causal-successor-relay.test.mjs
 */

// Module-load safety for log-isolation etc. — the real per-device dirs are created below.
process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-s1-causal-'))
const require = createRequire(import.meta.url)
const db = require('../../../src/main/db')
const dbSyncOps = require('../../../src/main/db-sync-ops')
const relayBootstrap = require('../../../src/main/relay-sync-bootstrap')

const ACCOUNT = 's1-causal-acc'
const ROOT_KEY = generateAccountRootKey()

const tmpDb = tag => fs.mkdtempSync(path.join(os.tmpdir(), `todo-s1-causal-${tag}-`))
const byId = (list, id) => list.find(t => String(t.taskId) === id)
const skew = () => Date.now() + 365 * 24 * 3600 * 1000 // A's clock: one year fast

function initDevice (dir) {
  db.init(dir)
  relayBootstrap.__test.reset()
  relayBootstrap.initRelaySync()
  const a = relayBootstrap.__test.getState()
  if (a && a.adapter) a.adapter.stop() // deterministic rounds only
}

async function enableRelay (baseUrl) {
  const st = await dbSyncOps.dispatch('relaySetEnabled', { enabled: true, account: ACCOUNT, baseUrl, rootKey: ROOT_KEY })
  assert.equal(st.enabled, true)
  return st
}

test('S1 v2: slow-clock causal successor beats fast-clock ancestor in the business table', async t => {
  const relay = createRelay(memoryStore())
  const server = await startRelayServer(relay, { port: 0 })
  t.after(() => new Promise(r => server.close(r)))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const dirA = tmpDb('devA')
  const dirB = tmpDb('devB')

  /* ---------- A (skewed clock) authors the ancestor and pushes ---------- */
  initDevice(dirA)
  await enableRelay(baseUrl)
  db.call('upsert', { taskId: 'skew1', taskContent: 'written by skewed A', createTime: 1, updateTime: skew() })
  const ra = await dbSyncOps.dispatch('relaySyncNow')
  assert.equal(ra.ok, true, ra.error || '')
  assert.equal(ra.pushed >= 1, true, 'A pushed its ancestor revision')

  /* ---------- B pulls the ancestor, then edits LATER with a sane clock ---------- */
  initDevice(dirB)
  await enableRelay(baseUrl)
  const rb0 = await dbSyncOps.dispatch('relaySyncNow')
  assert.equal(rb0.ok, true, rb0.error || '')
  assert.equal(byId(db.call('getAll'), 'skew1').taskContent, 'written by skewed A', 'B materialized the ancestor first')
  // B's edit is causally AFTER A's head (its revision parents onto the pulled current),
  // yet its business stamp is a year OLDER than A's — the exact S1 trap.
  db.call('upsert', { taskId: 'skew1', taskContent: 'edited later on B, correct clock', createTime: 1, updateTime: Date.now() })
  const rb = await dbSyncOps.dispatch('relaySyncNow')
  assert.equal(rb.ok, true, rb.error || '')

  /* ---------- A pulls B's causal child: business table MUST follow the DAG ruling ---------- */
  initDevice(dirA)
  const ra2 = await dbSyncOps.dispatch('relaySyncNow')
  assert.equal(ra2.ok, true, ra2.error || '')
  assert.ok(ra2.pulled >= 1, 'A pulled the child revision')
  const s1a = byId(db.call('getAll'), 'skew1')
  assert.ok(s1a, 'row exists on A')
  assert.equal(s1a.taskContent, 'edited later on B, correct clock',
    'S1 v2 bar: the slow-clock causal successor wins the BUSINESS table over the fast-clock ancestor ' +
    `(got: "${s1a && s1a.taskContent}")`)

  /* ---------- round-trip convergence + idempotence (no duplicate/conflict churn) ---------- */
  const rowsBefore = db.call('getAll').length
  const ra3 = await dbSyncOps.dispatch('relaySyncNow')
  assert.equal(ra3.ok, true, ra3.error || '')
  assert.equal(db.call('getAll').length, rowsBefore, 'repeated rounds add no rows (no conflict-copy churn)')
  assert.equal(byId(db.call('getAll'), 'skew1').taskContent, 'edited later on B, correct clock', 'content stable across a repeated round')

  initDevice(dirB)
  const rb2 = await dbSyncOps.dispatch('relaySyncNow')
  assert.equal(rb2.ok, true, rb2.error || '')
  assert.equal(byId(db.call('getAll'), 'skew1').taskContent, 'edited later on B, correct clock', 'B converged (already the winner, unchanged)')
  assert.equal(db.call('getAll').filter(x => /skew1/.test(String(x.taskId))).length, 1, 'no conflict copies minted on B')
})
