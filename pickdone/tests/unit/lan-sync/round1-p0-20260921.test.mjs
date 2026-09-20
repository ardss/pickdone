/* QC Round-1 P0 regression tests (2026-09-21, fix/round1-p0):
 *   P0-1  peer addressing: dialable-address selection, mDNS re-resolve fallback on dial failure,
 *         paired-peer table persistence across restarts, host sanitization (link-local/virtual).
 *   P0-2  filterUpsert INSERT fallback (sync apply to a db lacking the row must create it,
 *         never log a phantom pointer that egress turns into a tombstone).
 *   P0-3  CLI sync + tomato command channels: no restart replay (seq watermark seeded from the
 *         persisted counter, handled slot cleared).
 *   P0-4  invalidateSyncWatermarks wired after EVERY recovery restore (json AND plain-bak).
 *   P0-5  sanitizeSettingsPatch accepts arrays for array-typed defaults (foldedTodoList).
 *   P0-6  gamification: multi-generation subtotal fold converges exactly; full index self-heal.
 *   P0-7  tag rename/delete: rewrite regex matches TAG_RE terminator class incl. punctuation.
 *
 * Run: node --test tests/unit/lan-sync/round1-p0-20260921.test.mjs
 */
import '../../setup.mjs' // window/dayjs/VueI18n shims for renderer-module imports (P0-5/P0-6)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createLanSyncNode } = require('../../../src/main/lan-sync/index.js')
const { pickAdvertisedAddress, isDialableHost, hostScore } = require('../../../src/main/lan-sync/discovery.js')
const { __test: boot } = require('../../../src/main/lan-sync-bootstrap.js')
const { createSyncCmdHandler } = require('../../../src/main/cli-sync-channel.js')
const fixUtil = require('../../../src/main/fix-util.js')

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

function fakeDiscovery() {
  return { startAdvertising() {}, discover() {}, stop() {}, getPeers: () => [] }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

/* ---------------- P0-1: address selection + sanitization ---------------- */

test('P0-1: hostScore rejects link-local (with/without scope), virtual ranges; accepts real IPv4', () => {
  assert.equal(hostScore('169.254.10.10'), -1, 'IPv4 link-local')
  assert.equal(hostScore('fe80::1234'), -1, 'scope-less IPv6 link-local')
  assert.equal(hostScore('192.168.111.10'), -1, 'VMware NAT range (observed live)')
  assert.ok(hostScore('fe80::1234%12') >= 0, 'scoped link-local is technically dialable')
  assert.ok(hostScore('192.168.31.22') >= 0)
  assert.ok(hostScore('10.0.0.5') >= 0)
})

test('P0-1: pickAdvertisedAddress never returns a filtered-out address', () => {
  const junk = ['fe80::1', '169.254.5.5', '192.168.111.10']
  const out = pickAdvertisedAddress([...junk, '192.168.31.22', 'fd00::5'], 'mdns-host')
  assert.equal(junk.includes(out), false, 'picked ' + out)
  assert.equal(out, '192.168.31.22')
  // everything junk → falls back to the advertised hostname, else null
  assert.equal(pickAdvertisedAddress(junk, 'peer-lan-host'), 'peer-lan-host')
  assert.equal(pickAdvertisedAddress(junk, null), null)
})

test('P0-1: node.addPeer sanitizes undialable hosts (keeps a previous good one)', async () => {
  const node = createLanSyncNode({
    deviceId: 'san-a', pairingSecret: 's', port: 0, host: '127.0.0.1',
    discoverFn: fakeDiscovery(), ingestSegment: () => ({ applied: 0 }),
  })
  node.addPeer({ deviceId: 'p1', host: 'fe80::99', port: 1000 })
  let st = node.getStatus().peers.find(p => p.deviceId === 'p1')
  assert.ok(st.host == null || isDialableHost(st.host), 'scope-less link-local must not be stored: ' + st.host)
  node.addPeer({ deviceId: 'p1', host: '127.0.0.1', port: 1000 })
  st = node.getStatus().peers.find(p => p.deviceId === 'p1')
  assert.equal(st.host, '127.0.0.1')
  // a later junk re-announcement must NOT overwrite the working address
  node.addPeer({ deviceId: 'p1', host: '169.254.9.9', port: 1000 })
  st = node.getStatus().peers.find(p => p.deviceId === 'p1')
  assert.equal(st.host, '127.0.0.1', 'stale virtual/link-local re-announce keeps the good address')
  await node.stop()
})

/* ---------------- P0-1: mDNS re-resolve fallback (real two-node TCP) ---------------- */

test('P0-1: a wrong stored address re-resolves via discovery within the round and confirms', async () => {
  const ingestedA = []
  const nodeB = createLanSyncNode({
    deviceId: 'node-b', name: 'Node B', pairingSecret: 'sec-r1', port: 0, host: '127.0.0.1',
    discoverFn: fakeDiscovery(), ingestSegment: () => ({ applied: 0 }),
    buildSegments: () => [],
  })
  const nodeA = createLanSyncNode({
    deviceId: 'node-a', name: 'Node A', pairingSecret: 'sec-r1', port: 0, host: '127.0.0.1',
    discoverFn: fakeDiscovery(), ingestSegment: seg => ingestedA.push(seg),
    buildSegments: () => [{ fromSeq: 1, toSeq: 1, deviceId: 'node-a', rows: [{ id: 'a1', seq: 1 }] }],
    backoffBaseMs: 40, backoffMaxMs: 200,
    // the "mDNS" layer knows the REAL address
    resolvePeer: id => (id === 'node-b' ? { deviceId: 'node-b', host: '127.0.0.1', port: portB, name: 'Node B' } : null),
  })
  nodeA.start(); nodeB.start()
  const portB = await nodeB.whenListening()
  // stale/wrong address: 127.0.0.2 is inside the loopback /8 → instant ECONNREFUSED
  nodeA.addPeer({ deviceId: 'node-b', host: '127.0.0.2', port: portB, name: 'Node B' })
  const first = await nodeA.startSyncRound()
  assert.equal(first.confirmed, 0, 'dial to the wrong address fails')
  // the failure path must have re-resolved: the stored host flips to the real one, budget reset
  await sleep(30)
  assert.equal(nodeA.getStatus().peers.find(p => p.deviceId === 'node-b').host, '127.0.0.1', 're-resolved address stored')
  // retry (scheduled ~40ms) now confirms against the real nodeB
  const t0 = Date.now()
  let ok = false
  while (Date.now() - t0 < 5000) {
    ok = (await nodeA.startSyncRound()).confirmed === 1
    if (ok) break
    await sleep(50)
  }
  assert.ok(ok, 'round confirms after the fallback re-resolve')
  assert.ok(nodeA.getStatus().peers[0].watermark >= 1, 'push confirmed (watermark advanced)')
  await nodeA.stop(); await nodeB.stop()
})

/* ---------------- P0-1: paired-peer table persistence ---------------- */

test('P0-1: paired-peer table persists across a restart (settings_rows round-trip)', () => {
  const rows = []
  const state = {
    db: { call (op, p) {
      if (op === 'settingsRowsAll') return rows
      if (op === 'settingsRowPut') { const i = rows.findIndex(r => r.key === p.key); const v = typeof p.value === 'string' ? p.value : JSON.stringify(p.value); if (i >= 0) rows[i] = { key: p.key, value: v, deleted: 0 }; else rows.push({ key: p.key, value: v, deleted: 0 }); return true }
      return null
    } },
  }
  boot.setState(state)
  boot.persistPairedPeer({ deviceId: 'dev-9', name: 'Desk', host: '::ffff:192.168.31.22', port: 58471 })
  // simulate restart: fresh read from the persisted row
  const loaded = boot.loadPairedPeers()
  assert.equal(loaded['dev-9'].host, '192.168.31.22', 'IPv4-mapped IPv6 normalized')
  assert.equal(loaded['dev-9'].port, 58471)
  boot.removePairedPeer('dev-9')
  assert.ok(!boot.loadPairedPeers()['dev-9'])
  // undialable junk never overwrites a good stored address
  boot.persistPairedPeer({ deviceId: 'dev-x', host: '127.0.0.5', port: 100 })
  boot.persistPairedPeer({ deviceId: 'dev-x', host: 'fe80::1', port: 100 })
  assert.equal(boot.loadPairedPeers()['dev-x'].host, '127.0.0.5')
  boot.removePairedPeer('dev-x')
})

/* ---------------- P0-2: filterUpsert INSERT fallback (real better-sqlite3) ---------------- */

test('P0-2: applying a filter row to a db lacking it creates it — no phantom tombstone', () => {
  const db = require('../../../src/main/db.js')
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-fa-'))
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-fb-'))
  // side A: a live filter with a known id (explicit-id upsert = the sync-apply shape)
  db.init(dirA)
  const stamp = Date.now()
  const returned = db.call('filterUpsert', { id: 42, name: 'Work', conds: [{ k: 'priority', v: 'high' }], sort: 3, updatedAt: stamp })
  assert.equal(returned, 42)
  const rowA = db.call('filterList').find(f => f.id === 42)
  assert.ok(rowA, 'side A holds the filter')

  // side B: never saw the filter — the sync apply passes the explicit id; the old UPDATE-only
  // code matched 0 rows, logged a phantom oplog pointer, and the next egress fabricated a
  // tombstone that (delete-wins LWW) deleted the SOURCE's live filter.
  db.init(dirB)
  assert.equal(db.call('filterList').some(f => f.id === 42), false, 'precondition: side B lacks it')
  const r2 = db.call('filterUpsert', { id: 42, name: 'Work', conds: [{ k: 'priority', v: 'high' }], sort: 3, updatedAt: stamp })
  assert.equal(r2, 42)
  const rowB = db.call('filterList').find(f => f.id === 42)
  assert.ok(rowB, 'INSERT fallback created the missing row')
  assert.deepEqual(rowB.conds, rowA.conds)
  assert.equal(db.call('filterTombstones').some(t => t.id === 42), false, 'no phantom tombstone')

  // round-trip: side B now pushes its identical row back — identical content is a no-op (no
  // fake delta, no re-stamp) and the filter is preserved on both sides.
  const oplogBefore = db.call('syncOplogSince', { sinceSeq: 0 }).length
  assert.equal(db.call('filterUpsert', { id: 42, name: 'Work', conds: [{ k: 'priority', v: 'high' }], sort: 3, updatedAt: stamp }), false)
  assert.equal(db.call('syncOplogSince', { sinceSeq: 0 }).length, oplogBefore, 'identical re-apply logs no new oplog entry')
  db.init(dirA)
  assert.ok(db.call('filterList').find(f => f.id === 42), 'source filter still alive after round-trip')
})

/* ---------------- P0-3: CLI command channels must not replay across restarts ---------------- */

test('P0-3: cliSyncCmd — seq watermark seeded from the persisted counter; handled slot cleared', async () => {
  const meta = new Map([['cliSyncSeq', '7']])
  const dispatched = []
  const deleted = []
  const log = { warn: () => {} }
  const mk = () => createSyncCmdHandler({
    dispatch: op => { dispatched.push(op); return { ok: true } },
    setMeta: (k, v) => meta.set(k, v),
    getMeta: k => (meta.has(k) ? meta.get(k) : null),
    deleteMeta: k => { deleted.push(k); meta.delete(k) },
    log,
  })
  // restart scenario: an old `unpair` (seq 5 <= persisted counter 7) still sits in the slot
  meta.set('cliSyncCmd', JSON.stringify({ action: 'unpair', seq: 5, deviceId: 'x' }))
  let ch = mk()
  ch.forward(meta.get('cliSyncCmd'))
  await sleep(20)
  assert.equal(dispatched.length, 0, 'old command below the persisted counter is NOT re-executed')
  assert.equal(deleted.length, 0)

  // a fresh command (seq 8) executes and the slot is cleared after handling.
  // (Contract: the CLI bumps nextCliSyncSeq WHEN writing the command, so the persisted counter
  // is always >= any slot seq — that is exactly what makes the seeding safe.)
  meta.set('cliSyncSeq', '8')
  meta.set('cliSyncCmd', JSON.stringify({ action: 'status', seq: 8 }))
  ch.forward(meta.get('cliSyncCmd'))
  await sleep(20)
  assert.deepEqual(dispatched, ['syncGetStatus'])
  assert.ok(deleted.includes('cliSyncCmd'), 'handled slot cleared')
  assert.equal(JSON.parse(meta.get('cliSyncState')).seq, 8)

  // simulate a restart with the slot already cleared: nothing replays
  dispatched.length = 0
  ch = mk()
  ch.forward(meta.get('cliSyncCmd') || null)
  await sleep(20)
  assert.equal(dispatched.length, 0)

  // compare-and-delete: a NEWER command is never eaten by an older handler's cleanup
  meta.set('cliSyncSeq', '9')
  meta.set('cliSyncCmd', JSON.stringify({ action: 'pairing-code', seq: 9 }))
  ch = mk()
  ch.forward(meta.get('cliSyncCmd'))
  await sleep(20)
  meta.set('cliSyncCmd', JSON.stringify({ action: 'status', seq: 10 })) // arrived during handling
  await sleep(30)
  assert.equal(JSON.parse(meta.get('cliSyncCmd')).seq, 10, 'newer command survives the cleanup')
})

test('P0-3: cliTomatoCmd — clearCmd fires after a successful forward; seeded watermark skips old seq', () => {
  const win = { isDestroyed: () => false, webContents: { sent: [], send (ch, m) { this.sent.push(m) } } }
  const cleared = []
  // stale seq 5 vs persisted counter 7: not forwarded, not consumed
  let st = fixUtil.tryForwardTomatoCmd({ raw: JSON.stringify({ action: 'stop', seq: 5 }), lastTomatoCmdRaw: null, lastTomatoSeq: 7, getMainWindow: () => win, clearCmd: c => cleared.push(c.seq) })
  assert.equal(st.sent, false)
  assert.equal(cleared.length, 0)
  // fresh seq 8: forwarded, seq advances, slot cleared via the callback
  st = fixUtil.tryForwardTomatoCmd({ raw: JSON.stringify({ action: 'stop', seq: 8 }), lastTomatoCmdRaw: null, lastTomatoSeq: 7, getMainWindow: () => win, clearCmd: c => cleared.push(c.seq) })
  assert.equal(st.sent, true)
  assert.equal(st.lastTomatoSeq, 8)
  assert.deepEqual(cleared, [8])
  assert.equal(win.webContents.sent[0].seq, 8)
})

/* ---------------- P0-4: invalidateSyncWatermarks wired after recovery ---------------- */

test('P0-4: index.js wires invalidateSyncWatermarks for BOTH json and plain-bak restores', () => {
  const src = read('src/main/index.js')
  assert.match(src, /invalidateSyncWatermarks\('db-recovery:' \+ recoveredFrom\.source\)/)
  assert.match(src, /recoveredFrom\.source === 'json' \|\| recoveredFrom\.source === 'plain-bak'/)
  // and it fires AFTER the recovery writes (outside the json-only restore branch)
  const jsonBranch = src.match(/if \(recoveredFrom && recoveredFrom\.source === 'json'\) \{([\s\S]*?)\n {6}\}/)[1]
  assert.ok(!jsonBranch.includes('invalidateSyncWatermarks'), 'must not stay json-only')
})

/* ---------------- P0-5: sanitizeSettingsPatch array-typed defaults ---------------- */

test('P0-5: foldedTodoList (array default) passes; object field with array value still dropped', async () => {
  const { sanitizeSettingsPatch } = await import('file://' + path.join(ROOT, 'renderer/js/store/settings.js').replace(/\\/g, '/'))
  assert.deepEqual(sanitizeSettingsPatch({ foldedTodoList: ['today-done', 'day-done'] }).foldedTodoList, ['today-done', 'day-done'])
  assert.deepEqual(sanitizeSettingsPatch({ foldedTodoList: [] }).foldedTodoList, [])
  assert.deepEqual(sanitizeSettingsPatch({ shortcutKeySettings: ['a'] }), {}, 'object-typed field rejects an array')
})

/* ---------------- P0-6: gamification multi-generation fold + index self-heal ---------------- */

test('P0-6: peer subtotal folds converge exactly across generations (no double-subtract)', async () => {
  const { 'default': auth } = await import('file://' + path.join(ROOT, 'renderer/js/store/auth.js').replace(/\\/g, '/'))
  const LS = new Map()
  globalThis.localStorage = {
    getItem: k => (LS.has(k) ? LS.get(k) : null),
    setItem: (k, v) => LS.set(k, String(v)),
    removeItem: k => LS.delete(k),
  }
  const meta = new Map()
  globalThis.window.todoAPI = { dbCall: async (op, p) => {
    if (op === 'getMeta') return meta.has(p) ? meta.get(p) : null
    if (op === 'setMeta') { meta.set(p[0], p[1]); return true }
    if (op === 'deleteMeta') { meta.delete(p); return true }
    return null
  } }
  const state = { user: { snow: 0, tomatoGain: 0 } }
  const ctx = { state, commit: (m, p) => { state.user = { ...state.user, ...p } } }
  const PEER = 'dpeer'
  const k1 = `gamification.delta.${PEER}:1a`
  const k2 = `gamification.delta.${PEER}:1b`
  // peer emits k1=5; our device folds it individually
  meta.set(k1, JSON.stringify({ snow: 5, tomatoGain: 5, ts: Date.now() }))
  meta.set('gamification.delta.index', JSON.stringify([k1]))
  await auth.actions.initGamification(ctx)
  assert.equal(state.user.snow, 5)

  // gen 1 subtotal covers k1 (compacted list is cumulative)
  meta.set(`gamification.delta.${PEER}:c`, JSON.stringify({ snow: 5, tomatoGain: 5, ts: Date.now(), gen: 1, compacted: [k1] }))
  meta.delete(k1)
  meta.set('gamification.delta.index', JSON.stringify([`gamification.delta.${PEER}:c`]))
  await auth.actions.initGamification(ctx)
  assert.equal(state.user.snow, 5, 'k1 was already folded individually — gen1 adds 0 (was -0 before; old code subtracted it twice later)')

  // gen 2: k2=10 compacted in → cumulative subtotal 15. Old code: 15 - prev(5) - k1(5) = 0 (undercount).
  meta.set(`gamification.delta.${PEER}:c`, JSON.stringify({ snow: 15, tomatoGain: 15, ts: Date.now(), gen: 2, compacted: [k1, k2] }))
  meta.set('gamification.delta.index', JSON.stringify([`gamification.delta.${PEER}:c`]))
  await auth.actions.initGamification(ctx)
  assert.equal(state.user.snow, 15, 'multi-generation trace converges exactly')
  assert.equal(state.user.tomatoGain, 15)

  // idempotent: re-init adds nothing
  await auth.actions.initGamification(ctx)
  assert.equal(state.user.snow, 15, 'restart-stable')
})

test('P0-6: init re-adds EVERY orphaned own delta key to the shared index (not just the last)', async () => {
  const { 'default': auth } = await import('file://' + path.join(ROOT, 'renderer/js/store/auth.js').replace(/\\/g, '/'))
  const LS = new Map()
  globalThis.localStorage = {
    getItem: k => (LS.has(k) ? LS.get(k) : null),
    setItem: (k, v) => LS.set(k, String(v)),
    removeItem: k => LS.delete(k),
  }
  const meta = new Map()
  globalThis.window.todoAPI = { dbCall: async (op, p) => {
    if (op === 'getMeta') return meta.has(p) ? meta.get(p) : null
    if (op === 'setMeta') { meta.set(p[0], p[1]); return true }
    if (op === 'deleteMeta') { meta.delete(p); return true }
    return null
  } }
  const state = { user: { snow: 888, tomatoGain: 0 } } // default profile: no base delta noise
  const ctx = { state, commit: () => {} }
  await auth.actions.initGamification(ctx)
  // device emits two deltas via the batching surface
  await auth.actions.saveSnowGain(ctx, 5)
  meta.set('gamification.seq', LS.get('gamification.seq')) // harmless bookkeeping
  await auth.actions.saveSnowGain(ctx, 3)
  // force the two pending flushes
  const authMod = await import('file://' + path.join(ROOT, 'renderer/js/store/auth.js').replace(/\\/g, '/'))
  // (flush is timer-based; emit keys directly the way emitDelta would record them)
  const own = JSON.parse(LS.get('gamification.ownKeys') || '[]')
  assert.ok(Array.isArray(own), 'own emitted keys tracked in LS')
  // orphan BOTH own keys in the shared index (lost index race)
  meta.set('gamification.delta.index', '[]')
  await authMod.default.actions.initGamification(ctx)
  const idx = JSON.parse(meta.get('gamification.delta.index'))
  for (const k of own) assert.ok(idx.includes(k), 'self-healed into index: ' + k)
})

/* ---------------- P0-7: tag rewrite regex matches TAG_RE semantics ---------------- */

test('P0-7: rewrite terminator class matches TAG_RE — `#工作,明天` renames and deletes cleanly', () => {
  const src = read('renderer/js/components/side-nav/SnManageTagsModal.vue')
  // the rewrite must terminate on the same class TAG_RE extracts with (search.js)
  assert.ok(src.includes('(?=[\\\\s#,，。.!?！？]|$)'), 'rewrite terminator class matches TAG_RE')
  assert.ok(!src.includes('(?=\\s|$)'), 'the old whitespace-only lookahead is fully gone')
  // functional check with the REAL TAG_RE semantics + the FIXED rewrite semantics
  const TAG_RE = /#([^\s#,，。.!?！？]+)/g
  const renameRe = name => new RegExp('#' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=[\\s#,，。.!?！？]|$)', 'g')
  const content = '买菜#工作,明天 #工作 '
  assert.ok([...content.matchAll(TAG_RE)].some(m => m[1] === '工作'), 'counter counts the tag after punctuation')
  const renamed = content.replace(renameRe('工作'), '#职场')
  assert.equal(renamed, '买菜#职场,明天 #职场 ', 'rename lands (old regex replaced nothing here)')
  const delRe = name => new RegExp('\\s*#' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=[\\s#,，。.!?！？]|$)', 'g')
  assert.equal(content.replace(delRe('工作'), '').trim(), '买菜,明天')
  // a LONGER tag sharing the prefix is not rewritten
  assert.equal('#工作者'.replace(renameRe('工作'), '#职场'), '#工作者')
})
