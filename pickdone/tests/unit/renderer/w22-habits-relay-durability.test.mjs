/**
 * W22 P1 — aux-relay durability: the relay must persist the MERGED state, not the raw aux blob.
 *
 * Root cause being pinned: relayAuxBlob accepted an aux blob via externalApplier (habits/applyExternal
 * — union-max records merge + tombstone merge/prune + moments union, deliberately NO persist), then
 * wrote the RAW aux blob to the durable DB meta row. LS still held the raw aux blob too, so a
 * restart ran initFromDb → replaceAll with the un-merged blob and the main window's just-merged
 * check-ins vanished from LS, DB and memory at once.
 *
 * Covered:
 *   [1] accepted aux blob → after the relay, BOTH the LS blob and the DB meta write carry the
 *       union of the main window's in-memory records and the aux blob's records (merged state
 *       persisted, fresh savedAt); the SYNC_KEY ping is consumed after the DB write settles.
 *   [2] rejected (stale) aux blob → no persist at all: LS unchanged, no DB write, ping KEPT.
 *   [3] no live state (no store created / headless relay) → legacy contract kept: the accepted
 *       blob itself is written to the DB (U-10 acceptance path unchanged).
 *
 * Run: node --test tests/unit/renderer/w22-habits-relay-durability.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
let importSeq = 0
const importSrc = p => import(pathToFileURL(path.join(ROOT, p)).href + '?w22=' + (++importSeq))

const LS = {}
globalThis.localStorage = {
  getItem: k => (k in LS ? LS[k] : null),
  setItem: (k, v) => { LS[k] = String(v) },
  removeItem: k => { delete LS[k] }
}
const metaWrites = []
const metaStore = new Map()
globalThis.window = {
  location: { hash: '' },
  dayjs: globalThis.window.dayjs,
  todoAPI: {
    dbCall: async (op, params) => {
      if (op === 'setMeta') { metaWrites.push(params); metaStore.set(params[0], params[1]); return 'ok' }
      return 'ok'
    }
  }
}
const SYNC_KEY = 'habitsSyncPing'
const LS_KEY = 'habitsState'
const META_KEY = 'db.habitsState'
const readLsBlob = () => { try { return JSON.parse(LS[LS_KEY]) } catch { return null } }
const readMetaBlob = () => { try { return JSON.parse(metaStore.get(META_KEY)) } catch { return null } }

test('[1] relay persists the MERGED state: LS + DB meta carry the main window records AND the aux check-in', async () => {
  const mod = await importSrc('renderer/js/store/habits.js')
  const habits = mod.default
  // aux blob: a fresh check-in on d1 (savedAt NEWER than the main window's state → accepted),
  // but it never saw the main window's d2 record (e.g. d2 arrived via a LAN fold after aux booted)
  LS[LS_KEY] = JSON.stringify({
    schemaV: 1,
    habits: [{ id: 'h1', name: 'N', records: { '2026-10-01': true }, frequency: { type: 'daily' } }],
    moments: [], savedAt: 5000, deleted: [], deletedMoments: []
  })
  LS[SYNC_KEY] = 'ping-w22'
  // the state factory captures the module's live state (same object Vuex would hold)
  const live = habits.state()
  live.savedAt = 4000 // main memory is OLDER by stamp but holds MORE records (union-max source)
  // main window's own record, invisible to the aux blob (arrived via a LAN fold after aux booted):
  // this is the datum the old relay lost — it lived only in main memory
  live.habits[0].records['2026-10-02'] = true
  const seen = []
  // applier = main.js's onExternalHabitBlob contract: staleness guard + applyExternal + verdict
  mod.onExternalHabitBlob(b => {
    seen.push(b)
    if (mod.isStaleExternalRound(b.savedAt, live.savedAt)) return false
    habits.mutations.applyExternal(live, b)
    return true
  })
  mod._testInternals.relayAuxBlob()
  await new Promise(r => setTimeout(r, 20))
  assert.equal(seen.length, 1, 'the aux blob was fed to the applier')
  // the in-memory merge result: union-max keeps BOTH days
  assert.ok(live.habits[0].records['2026-10-01'], 'aux check-in merged into memory')
  assert.ok(live.habits[0].records['2026-10-02'], 'main-window record survived the merge in memory')
  // DURABILITY: both persistence channels carry the MERGED state (not the raw aux blob)
  const lsBlob = readLsBlob()
  assert.ok(lsBlob, 'LS blob rewritten by the merged-state persist')
  assert.ok(lsBlob.habits[0].records['2026-10-01'] && lsBlob.habits[0].records['2026-10-02'],
    'LS holds the merged records — a restart replaceAll can no longer drop the main-window check-in')
  const metaBlob = readMetaBlob()
  assert.ok(metaBlob, 'the durable DB meta row was written exactly once via the relay')
  assert.equal(metaWrites.length, 1, 'exactly one setMeta for the relay')
  assert.ok(metaBlob.habits[0].records['2026-10-01'] && metaBlob.habits[0].records['2026-10-02'],
    'the DB meta write carries the merged records, not the raw aux blob')
  assert.ok((lsBlob.savedAt || 0) >= 5000 && (metaBlob.savedAt || 0) >= 5000,
    'the merged persist carries a fresh savedAt (>= the aux round it supersedes)')
  assert.equal(LS[SYNC_KEY], undefined, 'the ping is consumed after the durable write settles')
})

test('[2] relay with a REJECTED (stale) aux blob: no persist, LS unchanged, ping kept', async () => {
  const mod = await importSrc('renderer/js/store/habits.js')
  const habits = mod.default
  const staleBlob = { schemaV: 1, habits: [{ id: 'h9', records: { '2026-09-09': true } }], moments: [], savedAt: 10, deleted: [], deletedMoments: [] }
  LS[LS_KEY] = JSON.stringify(staleBlob)
  LS[SYNC_KEY] = 'ping-stale'
  const live = habits.state()
  live.savedAt = 9999 // state is much newer → the applier must reject
  mod.onExternalHabitBlob(b => mod.isStaleExternalRound(b.savedAt, live.savedAt) ? false : (habits.mutations.applyExternal(live, b), true))
  metaWrites.length = 0
  mod._testInternals.relayAuxBlob()
  await new Promise(r => setTimeout(r, 20))
  assert.equal(metaWrites.length, 0, 'no DB write for a rejected blob')
  assert.equal(JSON.parse(LS[LS_KEY]).savedAt, 10, 'LS was NOT rewritten (no merged-state persist either)')
  assert.equal(LS[SYNC_KEY], 'ping-stale', 'the ping stays on the retry channel')
})

test('[3] relay WITHOUT live state keeps the legacy contract: the accepted blob itself reaches the DB', async () => {
  // fresh import + NO state() call → liveState stays null (isolated mutations-only host)
  const mod = await importSrc('renderer/js/store/habits.js')
  const blob = { schemaV: 1, habits: [{ id: 'h-legacy', records: {} }], moments: [], savedAt: 5000, deleted: [], deletedMoments: [] }
  LS[LS_KEY] = JSON.stringify(blob)
  LS[SYNC_KEY] = 'ping-legacy'
  mod.onExternalHabitBlob(() => true)
  metaWrites.length = 0
  mod._testInternals.relayAuxBlob()
  await new Promise(r => setTimeout(r, 20))
  assert.equal(metaWrites.length, 1, 'exactly one setMeta (U-10 acceptance path unchanged)')
  assert.ok(metaWrites[0][1].includes('"savedAt":5000'), 'the accepted blob itself was written verbatim')
  assert.equal(LS[SYNC_KEY], undefined, 'the ping is consumed after the durable write settles')
})
