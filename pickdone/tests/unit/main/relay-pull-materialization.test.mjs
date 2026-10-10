import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createRelay, startRelayServer, memoryStore } from '../../../server/sync-relay.mjs'
import { generateAccountRootKey } from '../../../shared/sync-crypto/e2e.mjs'

/**
 * E2E regression — relay pull must MATERIALIZE into the business todos table.
 *
 * Red before the fix (business gap, 2026-10-10): device B's pull decrypted + merged
 * envelopes into an EPHEMERAL in-memory store only. The cursor advanced and acked, so
 * the frames never re-arrive — while B's sync_revisions DAG and B's todos table never
 * saw the content. Restart rebuilt the store from the DB: the pulled data was gone
 * forever (silent loss behind a green cursor).
 *
 * Green contract under test (loopback relay, default-off adapter, shared root key = the
 * documented simulated pairing; production gates unchanged and NOT under test here):
 *   1. B's pull lands A's todos in B's REAL todos table (via the sanctioned v1 apply
 *      pipeline — LWW guards, never raw SQL of unverified remote content).
 *   2. Repeated rounds are idempotent (no duplicate rows).
 *   3. delete-vs-edit: B's newer edit survives A's concurrent tombstone; a plain A
 *      delete (B has no newer edit) lands as a tombstone on B.
 *   4. Restart: rows survive the db re-open, the cursor stays durable, nothing dupes.
 *   5. Two-way convergence: A pulls B's edit revision and matches.
 *   6. The v1 default path (relay never enabled, v2 flag off) is untouched.
 *
 * Run: node --test tests/unit/main/relay-pull-materialization.test.mjs
 */

// Module-load safety for log-isolation etc. — the real per-device dirs are created below.
process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-relay-pull-'))
const require = createRequire(import.meta.url)
const db = require('../../../src/main/db')
const dbSyncOps = require('../../../src/main/db-sync-ops')
const relayBootstrap = require('../../../src/main/relay-sync-bootstrap')

const ACCOUNT = 'pull-mat-acc'
// Simulated cross-device pairing (loopback only): a manually shared root key stands in
// for the account key-pairing service that does not exist yet (adapter header, Step 14+).
const ROOT_KEY = generateAccountRootKey()

const tmpDb = tag => fs.mkdtempSync(path.join(os.tmpdir(), `todo-relay-pull-${tag}-`))
const allTodos = () => db.call('getAll')
const liveTodos = () => allTodos().filter(t => !t.delete)
const byId = (list, id) => list.find(t => String(t.taskId) === id)

/** Point the db singleton + relay bootstrap at one device dir; stop polling so every
 *  round is deterministic (explicit relaySyncNow only). Config/secrets persist per dir. */
function initDevice (dir) {
  db.init(dir)
  relayBootstrap.__test.reset()
  relayBootstrap.initRelaySync()
  const a = relayBootstrap.__test.getState()
  if (a && a.adapter) a.adapter.stop()
}

async function enableRelay (baseUrl) {
  const st = await dbSyncOps.dispatch('relaySetEnabled', { enabled: true, account: ACCOUNT, baseUrl, rootKey: ROOT_KEY })
  assert.equal(st.enabled, true)
  return st
}

test('e2e: relay pull materializes into business todos (idempotent, delete-aware, restart-safe)', async t => {
  const relay = createRelay(memoryStore())
  const server = await startRelayServer(relay, { port: 0 })
  t.after(() => new Promise(r => server.close(r)))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const dirA = tmpDb('devA')
  const dirB = tmpDb('devB')

  /* ---------- A authors two todos and pushes ---------- */
  initDevice(dirA)
  await enableRelay(baseUrl)
  db.call('upsert', { taskId: 's1', taskContent: 'alpha from A', createTime: 1, updateTime: 100 })
  db.call('upsert', { taskId: 's2', taskContent: 'beta from A', createTime: 2, updateTime: 110 })
  const ra = await dbSyncOps.dispatch('relaySyncNow')
  assert.equal(ra.ok, true, ra.error || '')
  assert.ok(ra.pushed >= 2, 'A pushed its recorded revisions')

  /* ---------- B pulls: business table MUST materialize (RED before the fix) ---------- */
  initDevice(dirB)
  await enableRelay(baseUrl)
  const rb = await dbSyncOps.dispatch('relaySyncNow')
  assert.equal(rb.ok, true, rb.error || '')
  assert.ok(rb.pulled >= 2, `B pulled A's frames (got ${rb.pulled})`)
  const bRows = allTodos()
  assert.equal(byId(bRows, 's1') && byId(bRows, 's1').taskContent, 'alpha from A', 's1 materialized into B todos table')
  assert.equal(byId(bRows, 's2') && byId(bRows, 's2').taskContent, 'beta from A', 's2 materialized into B todos table')

  /* ---------- repeated pull is idempotent: no duplicate rows ---------- */
  const rb2 = await dbSyncOps.dispatch('relaySyncNow')
  assert.equal(rb2.ok, true, rb2.error || '')
  assert.equal(byId(allTodos(), 's1').taskContent, 'alpha from A', 'repeated round: content stable')
  assert.equal(allTodos().length, 2, 'no duplicate rows after a repeated round')

  /* ---------- A deletes s1 AND s2 while B is "offline"; B edits s1 first ---------- */
  initDevice(dirA)
  db.call('hardDelete', 's1')
  db.call('hardDelete', 's2')
  const ra2 = await dbSyncOps.dispatch('relaySyncNow')
  assert.equal(ra2.ok, true, ra2.error || '')
  // B edits s1 BEFORE pulling A's delete (offline edit, causally after B's pull of s1)
  initDevice(dirB)
  db.call('upsert', { taskId: 's1', taskContent: 'alpha edited on B', createTime: 1, updateTime: Date.now() + 10 })
  const rb3 = await dbSyncOps.dispatch('relaySyncNow')
  assert.equal(rb3.ok, true, rb3.error || '')
  // delete-vs-edit: B's edit is causally newer → the edit survives the concurrent tombstone
  const s1b = byId(allTodos(), 's1')
  assert.ok(s1b && !s1b.delete, 'B keeps its newer live edit over A\'s concurrent delete')
  assert.equal(s1b.taskContent, 'alpha edited on B', 'the surviving edit carries B content')
  // plain delete (no newer B edit): s2 tombstones on B
  const s2b = byId(allTodos(), 's2')
  assert.ok(!s2b || s2b.delete, 'A\'s delete landed on B (tombstone or gone from live)')

  /* ---------- restart B: rows survive, cursor durable, nothing dupes ---------- */
  const rowsBeforeRestart = allTodos().length
  initDevice(dirB) // same dir re-opened: the durable restart path
  const st = dbSyncOps.dispatch('relayGetStatus')
  assert.equal(st.enabled, true, 'enabled flag survived the restart')
  const s1r = byId(allTodos(), 's1')
  assert.ok(s1r && !s1r.delete && s1r.taskContent === 'alpha edited on B', 'B edit survived the restart (was: pull-only data vanished)')
  const rb4 = await dbSyncOps.dispatch('relaySyncNow')
  assert.equal(rb4.ok, true, rb4.error || '')
  assert.equal(allTodos().length, rowsBeforeRestart, 'post-restart round adds no duplicate rows')

  /* ---------- convergence: A pulls B's edit and matches ---------- */
  initDevice(dirA)
  const ra3 = await dbSyncOps.dispatch('relaySyncNow')
  assert.equal(ra3.ok, true, ra3.error || '')
  assert.ok(ra3.pulled >= 1, 'A pulled B\'s edit revision')
  const s1a = byId(allTodos(), 's1')
  assert.ok(s1a && !s1a.delete && s1a.taskContent === 'alpha edited on B', 'A converged on B\'s newer edit (delete-vs-edit settled identically)')
})

test('v1 default path untouched: relay never enabled + v2 flag off → writes record nothing', async t => {
  const dirC = tmpDb('devC')
  initDevice(dirC)
  assert.equal(db.call('revisionsFlagState').on, false, 'v2 recorder default OFF')
  assert.equal(dbSyncOps.dispatch('relayGetStatus').enabled, false, 'relay default OFF')
  const before = db.call('revisionsList').length
  db.call('upsert', { taskId: 'c1', taskContent: 'local only', createTime: 3, updateTime: 120 })
  assert.equal(db.call('revisionsList').length, before, 'no revisions recorded on the v1 default path')
  assert.equal(byId(liveTodos(), 'c1').taskContent, 'local only', 'plain local write still lands')
})
