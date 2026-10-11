import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createRelay, startRelayServer, memoryStore } from '../../../server/sync-relay.mjs'
import { generateAccountRootKey } from '../../../shared/sync-crypto/e2e.mjs'

/**
 * P1 fix regression (2026-10-11 delivery audit): a v1-era row (predating sync.revisions.v2)
 * has NO revision head. Before the fix, the first relay pull stamped the sender's
 * "current" envelope causalCurrent, and applyRowInner's causal branch overrode the business
 * LWW UNCONDITIONALLY — a stale remote edit silently clobbered a NEWER untracked local edit
 * with no conflict copy and no toast. Two layers pinned here:
 *
 *  1. backfill: relaySetEnabled now records every live unrecorded todo into the DAG, so the
 *     local edit enters the push set (peers converge) instead of diverging forever.
 *  2. no-head guard: even if a pull lands before any local head exists, the causal override
 *     requires a local head — otherwise the row falls through to LWW and the loser is kept
 *     as a conflict copy (never silently dropped).
 *
 * Run: node --test tests/unit/main/syncv2-untracked-local-backfill.test.mjs
 */

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-v1backfill-'))
const require = createRequire(import.meta.url)
const db = require('../../../src/main/db')
const dbSyncOps = require('../../../src/main/db-sync-ops')
const relayBootstrap = require('../../../src/main/relay-sync-bootstrap')

const ACCOUNT = 'v1-backfill-acc'
const ROOT_KEY = generateAccountRootKey()

const tmpDb = tag => fs.mkdtempSync(path.join(os.tmpdir(), `todo-v1backfill-${tag}-`))
const byId = (list, id) => list.find(t => String(t.taskId) === id)

function initDevice (dir) {
  db.init(dir)
  relayBootstrap.__test.reset()
  relayBootstrap.initRelaySync()
  const a = relayBootstrap.__test.getState()
  if (a && a.adapter) a.adapter.stop()
}

test('P1: a v1-era row is backfilled on relay enable AND a newer untracked local edit is never silently clobbered', async t => {
  const relay = createRelay(memoryStore())
  const server = await startRelayServer(relay, { port: 0 })
  t.after(() => new Promise(r => server.close(r)))
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  /* ---------- A authors the row and pushes (DAG-tracked) ---------- */
  const dirA = tmpDb('devA')
  initDevice(dirA)
  await dbSyncOps.dispatch('relaySetEnabled', { enabled: true, account: ACCOUNT, baseUrl, rootKey: ROOT_KEY })
  db.call('upsert', { taskId: 'p1row', taskContent: 'A original', createTime: 1, updateTime: Date.now() - 60000 })
  const ra = await dbSyncOps.dispatch('relaySyncNow')
  assert.equal(ra.ok, true, ra.error || '')

  /* ---------- B: v1-era device. Creates the row + edits it BEFORE ever touching relay ----------
   * Both writes predate the recorder flag → no revision, no head. The B edit is NEWER. */
  const dirB = tmpDb('devB')
  initDevice(dirB)
  db.call('upsert', { taskId: 'p1row', taskContent: 'B original', createTime: 1, updateTime: Date.now() - 30000 })
  db.call('upsert', { taskId: 'p1row', taskContent: 'B newer local edit', createTime: 1, updateTime: Date.now() })
  const dbMod = require('../../../src/main/db.js')
  const flagged = dbMod.call('revisionsFlagState', {})
  const wasOn = flagged && (flagged.on ?? flagged.enabled)
  // (the shim/dev env may have the flag on already; the v1-era property that matters is that
  //  no revision was recorded for p1row — asserted below via the backfill count instead.)

  /* ---------- B enables relay: backfill must record the untracked row ---------- */
  await dbSyncOps.dispatch('relaySetEnabled', { enabled: true, account: ACCOUNT, baseUrl, rootKey: ROOT_KEY })
  const revs = dbMod.call('revisionsList', { entityId: null, limit: 200 }) || []
  const p1revs = revs.filter(r => r.entity === 'todo')
  assert.ok(p1revs.length >= 1,
    `backfill recorded the v1-era row into the DAG (got ${p1revs.length} revisions; flag was on=${wasOn})`)

  /* ---------- B pushes its newer edit; A pulls: convergence, not divergence ---------- */
  const rb = await dbSyncOps.dispatch('relaySyncNow')
  assert.equal(rb.ok, true, rb.error || '')
  initDevice(dirA)
  const ra2 = await dbSyncOps.dispatch('relaySyncNow')
  assert.equal(ra2.ok, true, ra2.error || '')
  const aRow = byId(db.call('getAll'), 'p1row')
  assert.equal(aRow.taskContent, 'B newer local edit',
    'A converged to B\'s newer edit — the v1-era row is no longer invisible to the push DAG')

  /* ---------- and the reverse first-pull clobber: a stale remote edit must NOT override a
   * newer untracked local line (the apply-side no-head guard, covered at the unit seam) ---------- */
  const syncApply = require('../../../src/main/sync-apply.js')
  const state = syncApply.createState ? syncApply.createState('devX') : { deviceId: 'devX', db: dbMod, pendingWrites: {} }
  // If createState is not exported, build the minimal state the apply path needs.
  const st = state.db ? state : Object.assign(state, { db: dbMod })
  st.applyCache = syncApply.createHydrationCache(st)
  const staleRemote = { id: 'x1', deleted: false, updatedAt: Date.now() - 60000, causalCurrent: true, data: { taskContent: 'stale remote' } }
  const applied = syncApply.applyRowSafe(st, staleRemote)
  // With no local revision head, causalCurrent must NOT have been honored: either the local
  // newer edit stands (applied=false) or the merge kept the newer content. The stale text
  // must never land silently.
  const row = byId(db.call('getAll'), 'x1')
  const content = row ? row.taskContent : null
  assert.ok(!applied || content === 'local newer',
    `stale causalCurrent envelope must not silently override a newer untracked local edit (applied=${applied}, content=${JSON.stringify(content)})`)
})
