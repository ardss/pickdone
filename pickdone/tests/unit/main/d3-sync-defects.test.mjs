/* D2 fixer round (2026-10-21) — sync/blob/updater defect regressions, one file, items #1-#10:
 *   #1 blob-union-merge equal-stamp ties are symmetric (merge(A,B)===merge(B,A))
 *   #2 sync-apply union seam no-op is CONTENT-based (legacy local serializations don't echo)
 *   #3 cli purge scrub JSON.parse(firstRaw) null guard (source anchor)
 *   #4 db-oplog machine-local filter works without sync-apply/electron-log (shared single source)
 *   #5 db-oplog one()/setMeta ghost-pointer filtering
 *   #6 hydrate skips empty/'undefined'/'null' entityIds (counted)
 *   #7 pair-ops runRound().then(persist) has a catch (anchor + behavior)
 *   #8 relaySetEnabled revisionsFlag failure rolls the enable back and throws
 *   #9 updater watchdog arms on EVERY entry into 'downloading' (zero-progress hang caught)
 *   #10 manual download settles on watchdog/error so the next click can re-download
 * Run: node --test tests/unit/main/d3-sync-defects.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = path.join(import.meta.dirname, '..', '..', '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))

/* ---------- #1: blob-union-merge symmetric equal-stamp ties ---------- */

const { mergeBlobMetaValue } = require(path.join(ROOT, 'shared', 'blob-union-merge.mjs'))

test('D2#1: equal updatedAt + different content converges identically from either argument order', () => {
  const key = 'projectDocs:c9'
  const A = JSON.stringify([{ id: 'd1', title: 'Alpha edit', updatedAt: 100 }])
  const B = JSON.stringify([{ id: 'd1', title: 'Beta edit', updatedAt: 100 }])
  const ab = mergeBlobMetaValue(key, A, B)
  const ba = mergeBlobMetaValue(key, B, A)
  assert.equal(ab, ba, 'RED before the fix: incoming-wins-ties made merge(A,B)=B but merge(B,A)=A')
  assert.ok(JSON.parse(ab)[0].title === 'Alpha edit' || JSON.parse(ab)[0].title === 'Beta edit')
})

test('D2#1: strictly newer stamp still wins regardless of side (LWW preserved)', () => {
  const key = 'projectDocs:c9'
  const old_ = JSON.stringify([{ id: 'd1', title: 'old', updatedAt: 100 }])
  const new_ = JSON.stringify([{ id: 'd1', title: 'new', updatedAt: 200 }])
  assert.equal(mergeBlobMetaValue(key, old_, new_), mergeBlobMetaValue(key, new_, old_))
  assert.equal(JSON.parse(mergeBlobMetaValue(key, old_, new_))[0].title, 'new')
})

/* ---------- #2: union seam no-op is content-based ---------- */

const syncApply = require(path.join(ROOT, 'src', 'main', 'sync-apply.js'))

function mockState (tables = {}) {
  const calls = []
  const state = {
    calls,
    deviceId: 'local-device',
    localUserId: null,
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
    db: { call (op, params) { calls.push({ op, params }); return tables[op] ? tables[op](params) : null } },
  }
  return { state, calls }
}
const opCalls = (m, op) => m.calls.filter(c => c.op === op)

test('D2#2: a legacy-formatted local blob (same entries, different JSON key order) does NOT echo a setMeta', () => {
  const key = 'projectDocs:c7'
  // local: same two entries as incoming, but key order inside each object differs (legacy writer)
  const localLegacy = JSON.stringify([
    { updatedAt: 50, title: 'one', id: 'k1' },
    { id: 'k2', updatedAt: 60, title: 'two' },
  ])
  const incoming = JSON.stringify([
    { id: 'k1', title: 'one', updatedAt: 50 },
    { id: 'k2', title: 'two', updatedAt: 60 },
  ])
  const m = mockState({
    getMeta: k => (k === key ? localLegacy : null),
    syncOplogSince: () => [{ seq: 1, entity: 'meta', entityId: key, ts: 50 }],
  })
  const ok = syncApply.applyRowSafe(m.state, { entity: 'meta', id: key, seq: 9, ts: 200, updatedAt: 200, deleted: false, deletedAt: 0, data: { key, value: incoming } })
  assert.equal(ok, false, 'RED before the fix: byte-compare saw a difference and applied an echo write')
  assert.equal(opCalls(m, 'setMeta').length, 0, 'content-identical re-land must be a no-op (no oplog echo fuel)')
})

test('D2#2: a REAL content change still lands exactly one union write (no-op check not over-broad)', () => {
  const key = 'projectDocs:c8'
  const local = JSON.stringify([{ id: 'd1', title: 'mine', updatedAt: 100 }])
  const incoming = JSON.stringify([
    { id: 'd1', title: 'theirs-newer', updatedAt: 200 },
    { id: 'd2', title: 'remote only', updatedAt: 300 },
  ])
  const m = mockState({
    getMeta: k => (k === key ? local : null),
    syncOplogSince: () => [{ seq: 1, entity: 'meta', entityId: key, ts: 100 }],
  })
  assert.equal(syncApply.applyRowSafe(m.state, { entity: 'meta', id: key, seq: 9, ts: 400, updatedAt: 400, deleted: false, deletedAt: 0, data: { key, value: incoming } }), true)
  assert.equal(opCalls(m, 'setMeta').length, 1, 'genuine merge still writes')
})

/* ---------- #3: cli purge scrub null guard ---------- */

test('D2#3: cli/lib.js purge scrub guards JSON.parse(firstRaw) against a null first read', () => {
  const src = readFileSync(path.join(ROOT, 'cli', 'lib.js'), 'utf8')
  assert.match(src, /JSON\.parse\(firstRaw \|\| '\[\]'\)/, 'RED before the fix: bare JSON.parse(firstRaw) threw on a null getMeta and aborted the whole scrub loop')
  // lib-projects.cjs msPersist already carries the guard (verified 2026-10-21) — assert it stays.
  const src2 = readFileSync(path.join(ROOT, 'cli', 'lib-projects.cjs'), 'utf8')
  assert.match(src2, /JSON\.parse\(firstRaw \|\| '\[\]'\)/)
})

/* ---------- #4 + #5: db-oplog ---------- */

const dbOplog = require(path.join(ROOT, 'src', 'main', 'db-oplog.js'))

function oplogHarness () {
  const inserts = []
  const getDb = () => ({
    prepare: () => ({
      run: (...a) => { inserts.push(a); return { changes: 1 } },
      get: () => ({ n: 0 }),
      all: () => [],
    }),
    transaction: fn => () => fn(),
  })
  const mod = dbOplog({ getDb, log: { warn () {} }, getPurgeChips: () => [], onAppendFailure: null })
  return { mod, inserts }
}

test('D2#4: machine-local filter works in a plain node process (no sync-apply require, no electron-log)', () => {
  const src = readFileSync(path.join(ROOT, 'src', 'main', 'db-oplog.js'), 'utf8')
  assert.doesNotMatch(src, /require\(['"]\.\/sync-apply\.js['"]\)/, 'RED before the fix: lazy sync-apply require pulled electron-log and disabled the filter in the CLI process')
  const { mod, inserts } = oplogHarness()
  mod.appendOplog([
    { entity: 'meta', entityId: 'sync.pushCursor', ts: 1 },
    { entity: 'meta', entityId: 'db.settingsState', ts: 1 },
    { entity: 'setting', entityId: 'securityLockHash', ts: 1 },
    { entity: 'meta', entityId: 'userKey', ts: 2 },
  ])
  assert.deepEqual(inserts.map(r => r[1]), ['userKey'], 'machine-local bookkeeping stays out of the ring even in plain node')
})

test('D2#5: oplogEntriesFor filters ghost pointers — null keys/ids emit nothing', () => {
  const { mod } = oplogHarness()
  assert.deepEqual(mod.oplogEntriesFor('setMeta', [null, 'v']), [], 'RED before the fix: setMeta with a null key logged a ghost pointer')
  assert.deepEqual(mod.oplogEntriesFor('upsert', { taskId: null }), [])
  assert.deepEqual(mod.oplogEntriesFor('upsert', { taskId: undefined }), [])
  assert.equal(mod.oplogEntriesFor('upsert', { taskId: 't1' }).length, 1, 'a real id still emits its pointer')
  // appendOplog also drops null entries defensively (one() can return null inside arr shapes)
  const { mod: m2, inserts } = oplogHarness()
  m2.appendOplog([null, { entity: 'todo', entityId: 't1', ts: 3 }])
  assert.deepEqual(inserts.map(r => r[1]), ['t1'])
})

/* ---------- #6: hydrate ghost entityId guard ---------- */

const hydrate = require(path.join(ROOT, 'src', 'main', 'sync-apply-hydrate.js'))

test('D2#6: hydrateRow skips empty / literal undefined / literal null entityIds and counts them', () => {
  const fakeCache = { todo: () => null, setting: () => null, meta: () => null, tomato: () => null, tomatoTomb: () => null, category: () => null, plan: () => null, planTomb: () => null, filter: () => null, filterTomb: () => null, metaTs: () => new Map(), metaFloorTs: () => 0 }
  const state = {}
  for (const bad of ['', 'undefined', 'null', null, undefined]) {
    assert.equal(hydrate.hydrateRow(state, { entity: 'todo', entityId: bad, seq: 1, ts: 5 }, fakeCache), null, `entityId ${JSON.stringify(bad)} must be skipped`)
  }
  assert.equal(state.egressGhostIds, 5, 'each skip is counted')
  // a valid id still hydrates (tombstone fallback for an absent todo)
  const row = hydrate.hydrateRow(state, { entity: 'todo', entityId: 't1', seq: 2, ts: 6 }, fakeCache)
  assert.equal(row.deleted, true)
  assert.equal(row.id, 't1')
  assert.equal(state.egressGhostIds, 5, 'valid rows do not bump the counter')
})

/* ---------- #7: pair-ops runRound catch ---------- */

test('D2#7: post-pair first-round rejection is caught (no unhandled rejection; warned) at both sites', async () => {
  const src = readFileSync(path.join(ROOT, 'src', 'main', 'lan-sync', 'pair-ops.js'), 'utf8')
  const sites = src.match(/then\(runRound\)/g) || []
  assert.equal(sites.length, 2, 'both post-pair kick sites present')
  for (const m of src.matchAll(/then\(runRound\)\.then\(persistPeerWatermarks\)/g)) {
    assert.equal(src.slice(m.index).includes('.catch('), true, 'RED before the fix: then() without a catch — unhandled rejection')
  }
  // Behavior: a rejecting runRound must surface as a warn, not an unhandled rejection
  const factory = require(path.join(ROOT, 'src', 'main', 'lan-sync', 'pair-ops.js'))
  const warns = []
  let rounds = 0
  const deps = {
    getState: () => ({ node: { pairWith: async () => ({ secret: 's', peer: { deviceId: 'peer1', host: 'h', port: 1 } }) }, peerWatermarks: null, pairingCode: null }),
    settingGet: () => 'preset-secret', settingPut: () => {}, busWrite: () => {},
    getSettingsPayload: () => ({}),
    ensureIdentity: () => ({ deviceId: 'me' }),
    stopSync: async () => {}, startSync: async () => {},
    runRound: async () => { rounds++; throw new Error('transport dead right after pairing') },
    persistPeerWatermarks: () => {},
    persistPairedPeer: () => {}, removePairedPeer: () => {}, restartSync: async () => {},
    manualPeers: () => [], loadPeerWatermarks: () => ({}), notifyRenderers: () => {}, emitSyncEvent: () => {},
    K_PAIRING_SECRET: 'k1', K_DEVICE_NAME: 'k2', K_MANUAL_PEERS: 'k3', K_PEER_WATERMARKS: 'k4', K_ENABLED: 'k5',
    K_PEER_ALIAS_PREFIX: 'k6', PAIRING_CODE_TTL_MS: 60000, DEFAULT_PORT: 1,
    log: { info () {}, warn: (...a) => warns.push(a.join(' ')) },
  }
  const ops = factory(deps)
  const r = await ops.syncPairWithCode({ code: '123456' })
  assert.ok(r && r.peer, 'pairing op itself still succeeds (fire-and-forget round)')
  await sleep(20)
  assert.equal(rounds, 1)
  assert.ok(warns.some(w => w.includes('post-pair first round failed')), 'RED before the fix: rejection was swallowed into an unhandled rejection, never warned')
})

/* ---------- #8: relaySetEnabled revisionsFlag failure rolls back ---------- */

test('D2#8: a failed revisionsFlag flip disables the adapter and rejects the op (never live on an empty DAG)', async () => {
  const Module = require('module')
  const relaySrcPath = path.join(ROOT, 'src', 'main', 'relay-sync-bootstrap.js')
  const origLoad = Module._load
  const registered = {}
  const dbCalls = []
  Module._load = function (request, parent, isMain) {
    if (parent && parent.filename === relaySrcPath) {
      if (request === './db') {
        return { call: (op, p) => { dbCalls.push(op); if (op === 'revisionsFlag') throw new Error('recorder boom'); return null }, __revisionsForTests: null }
      }
      if (request === './db-sync-ops') return { register: map => Object.assign(registered, map) }
      if (request === './command-bus') return { commit: () => {} }
    }
    return origLoad.call(this, request, parent, isMain)
  }
  try {
    const relay = require(relaySrcPath)
    relay.__test.reset()
    relay.initRelaySync()
    assert.equal(typeof registered.relaySetEnabled, 'function', 'ops registered')
    await assert.rejects(
      registered.relaySetEnabled({ enabled: true, account: 'acct1', baseUrl: 'http://127.0.0.1:1' }),
      /rolled back/,
      'RED before the fix: flag-flip failure was warn-and-continue — enable went live on an empty DAG'
    )
    const status = registered.relayGetSettings()
    assert.equal(status.enabled, false, 'enable rolled back: adapter disabled, nothing went live')
  } finally {
    Module._load = origLoad
    const relay = require(relaySrcPath)
    relay.__test.reset()
  }
})

/* ---------- #9 + #10: updater ---------- */

const Module = require('module')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'd3-updater-'))
let autoUpdaterStub = null
const ELECTRON_STUB = { app: { getPath: () => TMP, getVersion: () => '0.0.0-test' } }
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB
  if (request === 'electron-updater') return { autoUpdater: autoUpdaterStub }
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

function freshUpdater (stub) {
  autoUpdaterStub = stub
  const resolved = require.resolve(path.join(ROOT, 'src', 'main', 'updater.js'))
  delete require.cache[resolved]
  return require(resolved)
}

test('D2#9: watchdog arms on the auto-download entry into downloading (zero progress events still stalls out)', async () => {
  process.env.PICKDONE_UPDATER_STALL_MS = '40'
  process.env.PICKDONE_UPDATER_RETRY_MS = '10'
  try {
    let availHandler = null
    const autoUpdater = {
      isUpdaterActive: () => true,
      autoDownload: true, // auto-download ON: update-available goes straight to 'downloading'
      on: (evt, fn) => { if (evt === 'update-available') availHandler = fn },
      checkForUpdates: async () => ({}),
      downloadUpdate: async () => ({}),
      quitAndInstall: () => {},
    }
    const updater = freshUpdater(autoUpdater)
    updater.init(null)
    availHandler({ version: '9.9.9' })
    assert.equal(updater.getStatus().status, 'downloading')
    // NO download-progress ever fires (hang before first byte). The watchdog must still fire.
    await sleep(150)
    assert.equal(updater.getStatus().status, 'error', 'RED before the fix: only download-progress armed the watchdog — zero-progress hangs were invisible forever')
    assert.match(updater.getStatus().info.message, /stalled/)
  } finally {
    delete process.env.PICKDONE_UPDATER_STALL_MS
    delete process.env.PICKDONE_UPDATER_RETRY_MS
  }
})

test('D2#9b: watchdog arms on the manual download entry too', async () => {
  process.env.PICKDONE_UPDATER_STALL_MS = '40'
  process.env.PICKDONE_UPDATER_RETRY_MS = '10'
  try {
    let availHandler = null
    const autoUpdater = {
      isUpdaterActive: () => true,
      autoDownload: false,
      on: (evt, fn) => { if (evt === 'update-available') availHandler = fn },
      checkForUpdates: async () => ({}),
      downloadUpdate: () => new Promise(() => {}), // hangs forever, no progress
      quitAndInstall: () => {},
    }
    const updater = freshUpdater(autoUpdater)
    updater.init(null)
    autoUpdater.autoDownload = false
    availHandler({ version: '9.9.9' })
    assert.equal(updater.getStatus().status, 'available')
    const p = updater.downloadUpdate()
    assert.equal(updater.getStatus().status, 'downloading')
    await sleep(150)
    assert.equal(updater.getStatus().status, 'error', 'manual download entry must arm the stall watchdog')
    assert.equal(await p, false, 'the hung manual download settles when the watchdog errors')
  } finally {
    delete process.env.PICKDONE_UPDATER_STALL_MS
    delete process.env.PICKDONE_UPDATER_RETRY_MS
  }
})

test('D2#10: a manual download aborted by the error path settles; the next click starts a FRESH download', async () => {
  process.env.PICKDONE_UPDATER_STALL_MS = '60000'
  process.env.PICKDONE_UPDATER_RETRY_MS = '10'
  try {
    let availHandler = null
    let errorHandler = null
    let downloadCalls = 0
    let hang = true
    const autoUpdater = {
      isUpdaterActive: () => true,
      autoDownload: false,
      on: (evt, fn) => { if (evt === 'update-available') availHandler = fn; if (evt === 'error') errorHandler = fn },
      checkForUpdates: async () => ({}),
      downloadUpdate: async () => { downloadCalls++; if (hang) await new Promise(() => {}); return {} },
      quitAndInstall: () => {},
    }
    const updater = freshUpdater(autoUpdater)
    updater.init(null)
    autoUpdater.autoDownload = false
    availHandler({ version: '9.9.9' })
    const p1 = updater.downloadUpdate()
    assert.equal(updater.getStatus().status, 'downloading')
    errorHandler(new Error('dead mirror')) // watchdog/error path while the download hangs
    assert.equal(await p1, false, 'RED before the fix: the dead in-flight promise was returned to every later click forever')
    assert.equal(updater.getStatus().status, 'error')
    // state back to 'available' (like a fresh check finding the version again), stub heals
    availHandler({ version: '9.9.9' })
    assert.equal(updater.getStatus().status, 'available')
    hang = false
    const p2 = updater.downloadUpdate()
    assert.notEqual(p2, p1, 'a NEW download promise (the old one is gone, not reused)')
    assert.equal(await p2, true)
    assert.equal(downloadCalls, 2, 'a fresh autoUpdater.downloadUpdate ran')
  } finally {
    delete process.env.PICKDONE_UPDATER_STALL_MS
    delete process.env.PICKDONE_UPDATER_RETRY_MS
  }
})
