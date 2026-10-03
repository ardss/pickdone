/**
 * D14 domain-2 (renderer store layer) regression batch — one test per finding, all red on the
 * pre-fix code:
 *   C1   tomato ledger retry queue: a resolved-but-REJECTED dbCall no longer drops the entry —
 *        row-rejected rows are quarantined durably (LS tomatoRejectedLedgerRows) with a surface;
 *        a falsy resolution (no bridge) keeps the entry queued
 *   C2   snow retry queue: bumpSnow's {ok:false} structured result keeps the entry (only ok:true
 *        retires it — including the deduped:true replay echo)
 *   B2   todayTomatoCount is recomputed inline on removeRecord/updateRecord (initiating window
 *        never receives the recordsReload broadcast)
 *   B3   dbMirror quit-flush: a rejection (or a missing bridge) on the quit path parks the blob
 *        DURABLY (dbMirror.unflushed.*) instead of dying with the in-memory retry timer
 *   B4   restoreSnapshot(taskId, toDay): a re-dating restore re-homes snapshot chips onto the new
 *        day (no ghost chips left on the old day); no-day restores stay verbatim
 *   C15  snapshotForDeleteMany: ONE planAll read for the whole batch, per-id snapshot+delete
 *   B6   settings initFromDb merges onboardingToursSeen per-key (never adopts the DB map wholesale)
 *   B7   ui renameUserTag/removeUserTag: failed meta put reverts the in-memory list and surfaces
 *   B9   category delete backs up doomed filters (catFiltersBak.<id>); recover restores them
 *   B10  restoreProjectMetaBackup merges milestones (live newer entries are never clobbered)
 *   B11  completed no-date tasks past completion day land in recent.expiredCompleted
 *   B15  habits applyExternal rejects TIES (prior writer wins, settings LWW doctrine)
 * Run: node --test tests/unit/renderer/d14-domain2-store-fixes.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const require_ = createRequire(import.meta.url)
const dayjs = require_('dayjs')
const today = +dayjs().startOf('day')
const todayKey = dayjs().format('YYYY-MM-DD')
const yesterdayKey = dayjs(today - 86400000).format('YYYY-MM-DD')
const tick = (ms = 25) => new Promise(r => setTimeout(r, ms))

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

/* ===== shared db bridge stub (installed BEFORE importing the store modules — tomato hydrates
   its pending queues from localStorage at import time) ===== */
const dbCalls = []
const metaMap = new Map()
let appendResult = { accepted: 1, rejected: [] }
let removeResult = []
let bumpResult = { ok: true, minutes: 5 }
let failSetMeta = false
let lastPlanPutMany = null
let planAllCount = 0
const filterUpserts = []
const filterListResult = []
const quitFlushCbs = []
globalThis.window.todoAPI = {
  dbCall (op, params) {
    dbCalls.push([op, params])
    switch (op) {
      case 'tomatoAppendMany': return Promise.resolve(appendResult)
      case 'tomatoRemoveByIds': return Promise.resolve(removeResult)
      case 'bumpSnow': return Promise.resolve(bumpResult)
      case 'getMeta': return Promise.resolve(metaMap.has(params) ? metaMap.get(params) : null)
      case 'setMeta':
        if (failSetMeta) return Promise.reject(new Error('disk full'))
        if (Array.isArray(params)) metaMap.set(params[0], params[1])
        return Promise.resolve('ok')
      case 'deleteMeta': metaMap.delete(params); return Promise.resolve(1)
      case 'planAll': planAllCount += 1; return Promise.resolve(planAllRows)
      case 'planAddMany': lastPlanPutMany = params; return Promise.resolve((params || []).map((r, i) => 'chip' + i))
      case 'planDeleteTask': return Promise.resolve(1)
      case 'filterUpsert': filterUpserts.push(params); return Promise.resolve(params && params.id)
      case 'filterList': return Promise.resolve(filterListResult)
      default: return Promise.resolve(null)
    }
  },
  onAppQuittingFlush (cb) { quitFlushCbs.push(cb) }
}
const fireQuitFlush = () => { for (const cb of quitFlushCbs) { try { cb() } catch (e) { /* per-consumer */ } } }
const LS = globalThis.localStorage
let planAllRows = []

/* seed the crash-proof retry queues the way a previous process life would have left them */
LS.setItem('tomatoPendingLedger', JSON.stringify({ v: 1, entries: [
  { seq: 1, ts: Date.now(), op: 'tomatoAppendMany', params: { tomatoId: 'tmt_bad', endTime: 0, dateKey: todayKey, succeed: true } },
  { seq: 2, ts: Date.now(), op: 'tomatoRemoveByIds', params: ['tmt_gone'] }
] }))
LS.setItem('tomatoPendingSnow', JSON.stringify({ v: 1, entries: [
  { seq: 3, ts: Date.now(), params: { taskId: 't9', minutes: 25, dedupKey: '123' } }
] }))

const tomato = (await import('../../../renderer/js/store/tomato.js')).default

// TQ-2: per-entry mirror — collect entries by prefix scan (legacy whole-blob seeds are migrated at hydrate)
const pendingLedgerEntries = () => {
  const out = []
  for (let i = 0; i < LS.length; i++) {
    const k = LS.key(i)
    if (k && k.indexOf('tomatoPendingLedger.') === 0) { try { out.push(JSON.parse(LS.getItem(k)).entry) } catch (e) { /* skip */ } }
  }
  return out
}
const pendingSnowEntries = () => {
  const out = []
  for (let i = 0; i < LS.length; i++) {
    const k = LS.key(i)
    if (k && k.indexOf('tomatoPendingSnow.') === 0) { try { out.push(JSON.parse(LS.getItem(k)).entry) } catch (e) { /* skip */ } }
  }
  return out
}

/* ==================== C1: ledger queue keeps/quarantines on non-accepted results ==================== */

test('C1 row-rejected append: entry retired from the queue but the rejected row is quarantined durably', async () => {
  appendResult = { accepted: 0, rejected: [{ index: 0, reason: 'bad endTime' }] }
  tomato.mutations.addRecord({ tomatoRecordList: [], todayTomatoCount: 0 }, { tomatoId: 'tmt_x', endTime: Date.now(), dateKey: todayKey, succeed: true })
  await tick()
  const kept = pendingLedgerEntries()
  assert.ok(!kept.some(e => e.op === 'tomatoAppendMany' && e.params && e.params.tomatoId === 'tmt_bad'),
    'the seeded rejected entry no longer spins in the retry queue')
  let quarantined = []
  try { quarantined = JSON.parse(LS.getItem('tomatoRejectedLedgerRows')) || [] } catch (e) { /* empty */ }
  assert.ok(Array.isArray(quarantined) && quarantined.some(r => r.row && r.row.tomatoId === 'tmt_bad'),
    'the row-rejected ledger row is preserved in the durable quarantine surface (not dropped)')
  assert.ok(quarantined.every(r => r.reason && r.ts), 'quarantine rows carry reason + timestamp')
  // the remove entry resolved [] (truthy, fully processed) → retired
  assert.ok(!kept.some(e => e.op === 'tomatoRemoveByIds' && e.params[0] === 'tmt_gone'))
})

test('C1 falsy resolution (no bridge / undefined result) keeps the entry queued', async () => {
  removeResult = undefined // the old `window.todoAPI && dbCall(...)` chain resolves falsy
  tomato.mutations.removeRecord({ tomatoRecordList: [], todayTomatoCount: 0 }, 'tmt_y')
  await tick()
  assert.ok(pendingLedgerEntries().some(e => e.op === 'tomatoRemoveByIds' && e.params[0] === 'tmt_y'),
    'a falsy result is NOT success — the entry stays queued for a real retry')
  removeResult = ['tmt_y']
  await tick(10) // a later replay with a truthy result retires it
  // no further write was dispatched, so it is still queued — drive one more write to replay
  tomato.mutations.removeRecord({ tomatoRecordList: [], todayTomatoCount: 0 }, 'tmt_z')
  await tick()
  assert.ok(!pendingLedgerEntries().some(e => e.op === 'tomatoRemoveByIds' && (e.params[0] === 'tmt_y' || e.params[0] === 'tmt_z')))
})

/* ==================== C2: snow queue keeps non-accepted results ==================== */

test('C2 bumpSnow: retryable failure keeps the entry; ok:true (incl. deduped echo) retires it', async () => {
  assert.ok(pendingSnowEntries().some(e => e.params.taskId === 't9'), 'seeded snow entry hydrated')
  // TQ-4: 'deleted' is a STRUCTURALLY-TERMINAL refusal (quarantined + retired — see its own test);
  // a transient/unknown non-accepted shape stays the retryable set.
  bumpResult = { ok: false, reason: 'unknown' }
  fireQuitFlush()
  await tick()
  assert.ok(pendingSnowEntries().some(e => e.params.taskId === 't9'),
    'a non-terminal non-accepted bump result is a failure — the entry stays queued')
  bumpResult = { ok: true, minutes: 0, deduped: true } // replay echo: already credited → retire
  fireQuitFlush()
  await tick()
  assert.ok(!pendingSnowEntries().some(e => e.params.taskId === 't9'), 'deduped:true counts as credited')
})

/* ==================== B2: todayTomatoCount recomputed in the initiating window ==================== */

test('B2 removeRecord/updateRecord recompute todayTomatoCount from the mutated ledger', () => {
  const st = {
    todayTomatoCount: 2, _countDate: todayKey,
    tomatoRecordList: [
      { tomatoId: 'r1', dateKey: todayKey, succeed: true },
      { tomatoId: 'r2', dateKey: todayKey, succeed: true },
      { tomatoId: 'r3', dateKey: '2020-01-01', succeed: true }
    ]
  }
  tomato.mutations.removeRecord(st, 'r1')
  assert.equal(st.todayTomatoCount, 1, 'deleting a today tomato drops the count immediately')
  tomato.mutations.updateRecord(st, { tomatoId: 'r2', patch: { endTime: today - 86400000 } })
  assert.equal(st.tomatoRecordList[0].dateKey, yesterdayKey, 're-dated record moves bucket')
  assert.equal(st.todayTomatoCount, 0, 're-dating a today tomato away drops the count immediately')
})

/* ==================== B3: dbMirror quit-path durable parking ==================== */

test('B3 quit-flush rejection parks the blob durably (both the reject branch and the no-bridge branch)', async () => {
  const { mirrorToDb, consumeUnflushed } = await import('../../../renderer/js/utils/dbMirror.js')
  LS.removeItem('dbMirror.unflushed.db.m3a')
  LS.removeItem('dbMirror.unflushed.db.m3b')
  failSetMeta = true
  mirrorToDb('db.m3a', { k: 1 }) // debounced; the quit flush below fires it immediately
  fireQuitFlush() // dbMirror's hook flips _quitting, then dispatches the writes
  await tick()
  const parked = consumeUnflushed('db.m3a')
  assert.ok(parked && parked.blob && parked.blob.k === 1, 'a quit-path setMeta REJECTION parks durably (the retry timer could never run)')
  // branch 2: bridge vanished before the quit flush → writeNow returns false, still parked
  const api = globalThis.window.todoAPI
  globalThis.window.todoAPI = { ...api, dbCall: undefined }
  try {
    mirrorToDb('db.m3b', { k: 2 })
    fireQuitFlush()
  } finally { globalThis.window.todoAPI = api }
  const parked2 = consumeUnflushed('db.m3b')
  assert.ok(parked2 && parked2.blob && parked2.blob.k === 2, 'a quit-path no-bridge blob is parked durably too')
  failSetMeta = false
})

/* ==================== B4 + C15: dayPlans snapshot restore re-dating / batch snapshot ==================== */

const dayPlans = (await import('../../../renderer/js/utils/dayPlans.js'))

test('B4 restoreSnapshot(taskId, toDay) re-homes snapshot chips onto the restored day; without toDay stays verbatim', async () => {
  const rows = [{ id: 'c1', taskId: 'tk', day: '2026-09-01', mm: '09:00', sort: 0, updatedAt: 5 }]
  metaMap.set('planChipsSnapshot:tk', JSON.stringify(rows))
  await dayPlans.restoreSnapshot('tk', todayKey)
  assert.ok(Array.isArray(lastPlanPutMany) && lastPlanPutMany.length === 1)
  assert.equal(lastPlanPutMany[0].day, todayKey, 'the chip follows the restored day — no ghost block on 2026-09-01')
  assert.ok(lastPlanPutMany[0].updatedAt > 5, 'LWW re-stamp preserved')
  assert.ok(!metaMap.has('planChipsSnapshot:tk'), 'snapshot meta consumed')
  // verbatim path (undo/rowChipSync) unchanged
  metaMap.set('planChipsSnapshot:tk2', JSON.stringify([{ id: 'c2', taskId: 'tk2', day: '2026-09-01', mm: '10:00', sort: 0 }]))
  await dayPlans.restoreSnapshot('tk2')
  assert.equal(lastPlanPutMany[0].day, '2026-09-01', 'no dayPatch → verbatim (existing behavior)')
})

test('C15 snapshotForDeleteMany does ONE planAll read and per-id snapshot+delete', async () => {
  planAllRows = [
    { id: 'c1', taskId: 't1', day: todayKey, mm: '09:00', sort: 0 },
    { id: 'c2', taskId: 't1', day: todayKey, mm: '10:00', sort: 1 },
    { id: 'c3', taskId: 't2', day: todayKey, mm: '11:00', sort: 0 }
  ]
  const before = planAllCount
  await dayPlans.snapshotForDeleteMany(['t1', 't2', 't3'])
  assert.equal(planAllCount - before, 1, 'exactly one shared planAll read for the whole batch (was N)')
  const deletes = dbCalls.filter(([op, p]) => op === 'planDeleteTask' && ['t1', 't2', 't3'].includes(p)).length
  assert.equal(deletes, 3, 'every requested id gets its chip rows cleared')
  assert.ok(dbCalls.some(([op, p]) => op === 'setMeta' && p[0] === 'planChipsSnapshot:t1'), 't1 snapshot written')
  assert.ok(dbCalls.some(([op, p]) => op === 'setMeta' && p[0] === 'planChipsSnapshot:t2'), 't2 snapshot written')
  assert.ok(!dbCalls.some(([op, p]) => op === 'setMeta' && p[0] === 'planChipsSnapshot:t3'), 'chip-less id: no snapshot row')
  // the todo batch action is wired to the batch op
  assert.match(read('renderer/js/store/todo.js'), /snapshotForDeleteMany\(ids\)/, 'deleteTodosMany uses the batch op')
})
