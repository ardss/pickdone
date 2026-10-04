/* D19-DOM1 main-domain regression batch (2026-10-02):
 *   3. attachments.js: crash-residue .att-tmp-* excluded from quota accounting + age sweep.
 *   4. pair-ops.js: successful pairing PRESERVES an existing legacy global pairing secret
 *      (mint-once); unpair still rotates it and deletes the peer's tomatoRunAnnounce row.
 *   5. db-tomato-ops.js: non-numeric endTime is REJECTED, not coerced into a 1970 ledger row.
 *   7. handlers/shared.js computeMetaGc: tomatoRunAnnounce family rule (inert without inputs).
 *   8. config-store.js: busy-spin fallback capped (~50ms per wait).
 *   10. peer-extras.js: key-collection read failure returns null (not []).
 *   12. dbRecovery.cjs: plain-bak restore copies are atomic (copyFileAtomicRestore).
 *   11/13: source anchors (windows.js did-finish-load sender; settings.js guarded rebuildTrayMenu).
 *   14. db.js: --keyword matches beyond the SQL LIMIT window are found (filter runs before cap).
 * Run: node --test tests/unit/main/d19-dom1-domain-fixes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const attachments = require('../../../src/main/attachments.js')
const { computeMetaGc } = require('../../../src/main/handlers/shared.js')
const dbTomato = require('../../../src/main/db-tomato-ops.js')
const cfg = require('../../../src/main/config-store.js')
const createPeerExtras = require('../../../src/main/lan-sync/peer-extras.js')
const dbRecovery = require('../../../src/main/dbRecovery.cjs')

/* ---------- 3. attachments: tmp residue accounting + sweep ---------- */

test('.att-tmp-* excluded from dirUsage/dirTotalBytes; normal files counted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd19-att-'))
  fs.writeFileSync(path.join(dir, 'a.png'), 'x'.repeat(10))
  fs.writeFileSync(path.join(dir, 'x.att-tmp-1730000000000-123'), 'x'.repeat(1000000))
  fs.writeFileSync(path.join(dir, 'aliases.json'), '{"a":"b"}')
  const usage = attachments.dirUsage(dir)
  assert.deepEqual(usage, { bytes: 10, count: 1 })
  assert.equal(attachments.dirTotalBytes(dir), 10)
  assert.equal(attachments.isCrashTmpResidue('x.att-tmp-1730000000000-123'), true)
  assert.equal(attachments.isCrashTmpResidue('a.png'), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('sweepTmpResidue removes only OLD .att-tmp-* files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd19-sweep-'))
  const oldTmp = path.join(dir, 'old.att-tmp-1-2')
  const newTmp = path.join(dir, 'new.att-tmp-3-4')
  const keep = path.join(dir, 'real.png')
  for (const f of [oldTmp, newTmp, keep]) fs.writeFileSync(f, 'data')
  const oldMs = Date.now() - 25 * 60 * 60 * 1000 // 25h old: past the 24h sweep age
  fs.utimesSync(oldTmp, new Date(oldMs), new Date(oldMs))
  const removed = attachments.sweepTmpResidue(dir)
  assert.equal(removed, 1)
  assert.equal(fs.existsSync(oldTmp), false)
  assert.equal(fs.existsSync(newTmp), true, 'a young tmp may be an in-flight spool: never touched')
  assert.equal(fs.existsSync(keep), true)
  fs.rmSync(dir, { recursive: true, force: true })
})

/* ---------- 4. pair-ops: legacy global secret mint-once + unpair announce delete ---------- */

const NEWSECRET = 'NEWSECRET'.padEnd(64, '0')
const LEGACYSECRET = 'LEGACYSECRET'.padEnd(64, '0')

function makePairOps (settingsMap, busWrites) {
  return require('../../../src/main/lan-sync/pair-ops.js')({
    getState: () => ({
      node: {
        getStatus: () => ({ peers: [] }),
        pairWith: async () => ({ secret: NEWSECRET, peer: { deviceId: 'dev-b', name: 'B', host: 'h', port: 1 } }),
        requestPair: async () => ({ secret: NEWSECRET, deviceId: 'dev-b', host: 'h', port: 1 }),
        removePeer: () => {},
        notifyUnpaired: async () => true,
      },
      pairingCode: null,
    }),
    settingGet: k => settingsMap.get(k),
    settingPut: (k, v) => settingsMap.set(k, v),
    busWrite: (op, payload) => busWrites.push({ op, payload }),
    getSettingsPayload: () => ({}),
    ensureIdentity: () => ({ deviceId: 'self', deviceName: 'self' }),
    stopSync: async () => {}, startSync: async () => {}, runRound: async () => {},
    persistPeerWatermarks: () => {}, persistPairedPeer: () => {}, removePairedPeer: () => {},
    restartSync: async () => {},
    manualPeers: () => [], loadPeerWatermarks: () => ({}),
    notifyRenderers: () => {}, emitSyncEvent: () => {},
    K_PAIRING_SECRET: 'sync.pairingSecret', K_DEVICE_NAME: 'sync.deviceName',
    K_MANUAL_PEERS: 'sync.manualPeers', K_PEER_WATERMARKS: 'sync.peerWatermarks',
    K_ENABLED: 'sync.enabled', K_PEER_ALIAS_PREFIX: 'sync.peerAlias.',
    PAIRING_CODE_TTL_MS: 60000, DEFAULT_PORT: 58471,
    log: { info () {}, warn () {}, error () {} },
  })
}

test('pairing with NO existing global secret adopts the new one (mint path)', async () => {
  const map = new Map()
  const ops = makePairOps(map, [])
  await ops.syncPairWithCode({ code: '123456' })
  assert.equal(map.get('sync.pairingSecret'), NEWSECRET)
})

test('pairing with an EXISTING global secret PRESERVES it (legacy peers keep authenticating)', async () => {
  const map = new Map([['sync.pairingSecret', LEGACYSECRET]])
  const ops = makePairOps(map, [])
  await ops.syncPairWithCode({ code: '123456' })
  assert.equal(map.get('sync.pairingSecret'), LEGACYSECRET)
  await ops.syncPairRequest({ host: 'h' })
  assert.equal(map.get('sync.pairingSecret'), LEGACYSECRET)
})

test('unpair still rotates the global secret AND deletes the peer announce row', async () => {
  const map = new Map([['sync.pairingSecret', 'OLD'.padEnd(64, '0')]])
  const busWrites = []
  const ops = makePairOps(map, busWrites)
  await ops.syncUnpairPeerOp({ deviceId: 'dev-gone' })
  const rotated = map.get('sync.pairingSecret')
  assert.notEqual(rotated, 'OLD'.padEnd(64, '0'), 'unpair must rotate the shared secret')
  assert.match(rotated, /^[0-9a-f]{64}$/, 'rotated secret has the canonical pairing-secret shape')
  const del = busWrites.find(w => w.op === 'deleteMeta')
  assert.ok(del, 'unpair must delete the announce meta row')
  assert.equal(del.payload, 'tomatoRunAnnounce.dev-gone')
})

/* ---------- 5. tomato ledger: non-numeric endTime rejected ---------- */

function fakeDb () {
  const rows = []
  return {
    rows,
    prepare: () => ({ run: r => { rows.push(r) } }),
    transaction: fn => (...a) => fn(...a),
  }
}

test('tomatoAppendMany rejects truthy non-numeric endTime instead of coercing to 0 (1970 row)', () => {
  const db = fakeDb()
  const res = dbTomato.tomatoAppendMany(db, [
    { tomatoId: 'a', endTime: 'abc' },
    { tomatoId: 'b', endTime: true },
    { tomatoId: 'c', endTime: 0 },
    { tomatoId: 'd', endTime: 1730000000000 },
  ])
  assert.deepEqual(res.rejected.map(r => r.index), [0, 1, 2])
  assert.ok(res.rejected.every(r => r.reason === 'endTime required'))
  assert.equal(res.accepted, 1)
  assert.equal(db.rows[0].endTime, 1730000000000)
  assert.match(db.rows[0].dateKey, /^\d{4}-\d{2}-\d{2}$/)
})

/* ---------- 7. computeMetaGc tomatoRunAnnounce family rule ---------- */

test('tomatoRunAnnounce family rule: unpaired ids GC-able, self + paired kept, inert without inputs', () => {
  const keys = ['tomatoRunAnnounce.devA', 'tomatoRunAnnounce.self']
  // Rule inert when pairedDeviceIds is not supplied (legacy callers / failed peer-table read):
  // NO announce row is GC'd without the inputs, even for a clearly-unpaired id.
  assert.deepEqual(computeMetaGc(keys, [], [], {}), [])
  // With inputs: paired devA and our own row survive.
  const dead = computeMetaGc(keys, [], [], { pairedDeviceIds: ['devA'], ownDeviceId: 'self' })
  assert.deepEqual(dead, [])
  // devA unpaired -> its announce row is dead; our own row survives.
  const dead2 = computeMetaGc(keys, [], [], { pairedDeviceIds: [], ownDeviceId: 'self' })
  assert.deepEqual(dead2, ['tomatoRunAnnounce.devA'])
  // The repeatRule family rule is untouched by the new branch.
  assert.deepEqual(computeMetaGc(['repeatRule:r1'], [], [], { pairedDeviceIds: [] }), ['repeatRule:r1'])
})

/* ---------- 8. config-store spin cap ---------- */
/* ---------- 8. config-store spin cap ---------- */

test('sleepBackoff busy-spin fallback is capped (~50ms), never the full backoff slice', () => {
  const elapsed = cfg.sleepBackoff(800, { forceSpin: true }) // full slice would be 800ms
  assert.ok(elapsed >= 40, `spin kept some real delay (${elapsed}ms)`)
  assert.ok(elapsed < 200, `spin capped below the slice (${elapsed}ms)`)
  const e2 = cfg.sleepBackoff(800, { forceSpin: true, spinCapMs: 10 })
  assert.ok(e2 < 100, `explicit cap honored (${e2}ms)`)
})

/* ---------- 10. peer-extras read failure = null ---------- */

test('missingAttachmentKeys returns null (not []) on read failure and warns loudly', () => {
  const peerExtras = createPeerExtras({ settingGet: () => null })
  const out = peerExtras.missingAttachmentKeys({ db: { call: () => [] } }, {
    readMaxOplogSeq: () => { throw new Error('settings read failed') },
  })
  assert.equal(out, null)
})

/* ---------- 12. dbRecovery atomic restore copy ---------- */

test('copyFileAtomicRestore publishes the full backup atomically (no residue)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd19-rec-'))
  const src = path.join(dir, 'todos.db.plain-bak')
  const dest = path.join(dir, 'todos.db')
  const payload = Buffer.from('SQLite format 3' + 'x'.repeat(4096))
  fs.writeFileSync(src, payload)
  dbRecovery.copyFileAtomicRestore(src, dest)
  assert.deepEqual(fs.readFileSync(dest), payload)
  const residue = fs.readdirSync(dir).filter(f => f.includes('.dtmp'))
  assert.deepEqual(residue, [])
  fs.rmSync(dir, { recursive: true, force: true })
})

/* ---------- 11/13. source anchors ---------- */

test('windows.js did-finish-load uses the event sender, not the module-level win', () => {
  const src = fs.readFileSync(require.resolve('../../../src/main/windows.js'), 'utf8')
  const i = src.indexOf("'did-finish-load', (e)")
  assert.ok(i > -1, 'test-env did-finish-load handler must take the event arg')
  const seg = src.slice(i, i + 400)
  assert.ok(/e\.sender/.test(seg), 'handler must capture event.sender')
  assert.ok(/wc\.setTitle/.test(seg), 'setTitle must go to the captured sender')
})

test('settings.js set-app-locale guards rebuildTrayMenu like its siblings', () => {
  const src = fs.readFileSync(require.resolve('../../../src/main/handlers/settings.js'), 'utf8')
  assert.match(src, /try \{ rebuildTrayMenu\(\) \} catch/)
})

/* ---------- 14. db.js keyword filter vs LIMIT ---------- */

test('list --keyword finds matches BEYOND the default LIMIT window; non-keyword paths unchanged', () => {
  const db = require('../../../src/main/db.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd19-kw-'))
  db.init(dir)
  for (let i = 0; i < 150; i++) {
    db.call('upsert', { taskId: 'kw_' + i, taskContent: i === 140 ? 'needle special' : 'plain ' + i, sort: i, complete: false, delete: false })
  }
  // Old behavior: LIMIT 100 applied before the JS keyword filter -> the row-140 match invisible.
  const hits = db.call('queryTodos', { keyword: 'needle', limit: 100 })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].taskId, 'kw_140')
  // Unfiltered keyword query still works; non-keyword limit truncates as before.
  assert.equal(db.call('queryTodos', { keyword: 'needle' }).length, 1)
  assert.equal(db.call('queryTodos', { limit: 100 }).length, 100)
  assert.equal(db.call('queryTodos', { keyword: 'needle', limit: 0 }).length, 0)
  assert.throws(() => db.call('queryTodos', { limit: -1 }), /invalid limit/)
  // no dir cleanup: the better-sqlite3 handle stays open for the process (Windows EBUSY on unlink)
})
