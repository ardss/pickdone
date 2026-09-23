/* QC Round-2 P1 regression tests (2026-09-21, fix/round2-p1):
 *   F1  Device Center device names: status peers carry deviceName; machine-local per-peer alias
 *       (sync.peerAlias.<id>) round-trips via syncSetPeerAlias and wins display order.
 *   F2  UDP fallback discovery: the sender's real IP (rinfo.address) becomes the peer host; a
 *       peer with NO dialable address is skipped (never the 127.0.0.1 self-dial placeholder).
 *   F3  No hardcoded 192.168.111.* rejection: topological scoring — same-subnet IPv4 highest,
 *       cross-subnet lowest-dialable (allowed), scoped fe80 stripped + lowest.
 *   F4  Address-flap vs hibernate: re-fixes are budgeted (6/hour) and never reset the failure
 *       streak; only a successful round does — a flapping dead peer reaches 'hibernating'.
 *   F5  Fresh-paired device: a missing habits blob is MATERIALIZED from the applied rows
 *       (restart keeps the view; the next local persist can no longer clobber the peer).
 *   F6  Restore-backup habits: force-apply bypasses the stale savedAt guard AND persists.
 *   F7  Attachment re-pull: recycle-bin (deleted) todos' keys are never requested.
 *   F8  CLI channel: a queued slot command at seq === counter executes once after restart and
 *       does NOT re-execute on a second restart (cliSync channel; tomato mirrored in index.js).
 *   F9  misc guards: subscription existence guards, watermark-clear warn log, legacy folded-guard
 *       gen handling, OWN_KEYS_LS prune, foldedTodoList entry sanitation.
 *
 * Run: node --test tests/unit/lan-sync/round2-p1-20260921.test.mjs
 */
import '../../setup.mjs' // window/localStorage/i18n shims for renderer-module imports
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createLanSyncNode } = require('../../../src/main/lan-sync/index.js')
const { createDiscovery, hostScore, isDialableHost } = require('../../../src/main/lan-sync/discovery.js')
const boot = require('../../../src/main/lan-sync-bootstrap.js')
const syncOps = require('../../../src/main/db-sync-ops.js')
const { createSyncCmdHandler } = require('../../../src/main/cli-sync-channel.js')

const sleep = ms => new Promise(r => setTimeout(r, ms))
const here = f => path.join(path.dirname(fileURLToPath(import.meta.url)), f)

function fakeDiscovery () {
  return { startAdvertising() {}, discover() {}, stop() {}, getPeers: () => [] }
}

/* ---------------- F1: deviceName in the status payload + peer alias ---------------- */

test('F1: status peers carry deviceName (the raw UUID display bug)', () => {
  const node = createLanSyncNode({
    deviceId: 'self-1', name: 'Self', pairingSecret: 's', port: 0, host: '127.0.0.1',
    discoverFn: fakeDiscovery(), ingestSegment: () => ({ applied: 0 }),
  })
  node.addPeer({ deviceId: 'desk-9', name: 'DESKTOP-9', host: '127.0.0.1', port: 58471 })
  const p = node.getStatus().peers.find(x => x.deviceId === 'desk-9')
  assert.equal(p.deviceName, 'DESKTOP-9', 'renderer reads p.deviceName — payload must carry it')
  assert.equal(p.name, 'DESKTOP-9')
})

test('F1: peer alias round-trips via syncSetPeerAlias and is attached to status peers', () => {
  const rows = []
  const state = {
    node: { getStatus: () => ({ listening: true, port: 58471, peers: [{ deviceId: 'desk-9', name: 'DESKTOP-9', host: '192.168.31.5', port: 58471 }], recent: [], security: [] }) },
    db: { call (op, p) {
      if (op === 'settingsRowsAll') return rows
      if (op === 'settingsRowPut') {
        const i = rows.findIndex(r => r.key === p.key)
        const v = typeof p.value === 'string' ? p.value : JSON.stringify(p.value)
        if (i >= 0) rows[i] = { key: p.key, value: v, deleted: 0 }; else rows.push({ key: p.key, value: v, deleted: 0 })
        return true
      }
      if (op === 'settingsRowDelete') { const i = rows.findIndex(r => r.key === p.key); if (i >= 0) rows.splice(i, 1); return true }      return null
    } },
  }
  boot.__test.setState(state)
  boot.__test.registerOps()
  const status0 = syncOps.dispatch('syncGetStatus', {})
  assert.equal(status0.peers[0].deviceName, 'DESKTOP-9')
  assert.equal(status0.peers[0].alias, null)
  syncOps.dispatch('syncSetPeerAlias', { deviceId: 'desk-9', alias: '  书房台式机  ' })
  const st1 = syncOps.dispatch('syncGetStatus', {})
  assert.equal(st1.peers[0].alias, '书房台式机', 'alias round-trips through the machine-local settings row')
  assert.ok(rows.find(r => r.key === 'sync.peerAlias.desk-9'), 'stored under sync.peerAlias.<deviceId>')
  // empty string clears the alias back to the advertised name
  syncOps.dispatch('syncSetPeerAlias', { deviceId: 'desk-9', alias: '' })
  const st2 = syncOps.dispatch('syncGetStatus', {})
  assert.equal(st2.peers[0].alias, null)
  assert.ok(!rows.find(r => r.key === 'sync.peerAlias.desk-9'), 'cleared row removed')
  syncOps.reset()
})

/* ---------------- F2/F3: discovery addressing + topological scoring ---------------- */

test('F2: upsertPeer without any dialable address SKIPS the peer (never 127.0.0.1)', () => {
  const d = createDiscovery()
  const out = d._upsertPeer({ deviceId: 'ghost', name: 'Ghost', port: 58471 }) // UDP payload w/o host/addresses
  assert.equal(out, null, 'no dialable host -> peer announcement skipped')
  assert.equal(d.getPeers().length, 0, 'no loopback placeholder peer stored')
})

test('F2: UDP fallback discovery stores the sender address (rinfo.address) as the peer host', async () => {
  // Force the UDP fallback path (bonjour-service would otherwise take over) by making the
  // optional require fail for THIS require of discovery.js.
  const Module = require('module')
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'bonjour-service') throw new Error('stubbed unavailable (UDP fallback test)')
    return origLoad.call(this, request, parent, isMain)
  }
  let A = null
  let B = null
  try {
    delete require.cache[require.resolve('../../../src/main/lan-sync/discovery.js')]
    const { createDiscovery: createUdpDiscovery } = require('../../../src/main/lan-sync/discovery.js')
    A = createUdpDiscovery()
    A.startAdvertising({ deviceId: 'udp-a', name: 'UDP-A', port: 58491 })
    B = createUdpDiscovery()
    B.startAdvertising({ deviceId: 'udp-b', name: 'UDP-B', port: 58492 })
    B.discover(() => {})
    const t0 = Date.now()
    while (Date.now() - t0 < 6000 && !B.getPeers().some(p => p.deviceId === 'udp-a')) await sleep(200)
    const peer = B.getPeers().find(p => p.deviceId === 'udp-a')
    assert.ok(peer, 'UDP-discovered peer present')
    // the payload carries no addresses, so the stored host MUST be the datagram sender IP
    // (rinfo.address) — a real, dialable address rather than a loopback placeholder
    assert.ok(peer.host && isDialableHost(peer.host), 'host = rinfo.address: ' + peer.host)
    const locals = new Set(['127.0.0.1'])
    for (const l of Object.values(os.networkInterfaces())) for (const ni of l || []) if (ni && ni.address && !ni.internal) locals.add(ni.address)
    assert.ok(locals.has(peer.host), 'sender address is one of this machine’s own IPs')
  } finally {
    Module._load = origLoad
    try { if (A) A.stop() } catch { /* noop */ }
    try { if (B) B.stop() } catch { /* noop */ }
  }
})

test('F2: UDP fallback walks to the next candidate when the pinned port is unbindable (WinNAT excluded ranges drift between reboots)', async () => {
  const dgram = require('node:dgram')
  const Module = require('module')
  const origLoad = Module._load
  const origCreateSocket = dgram.createSocket
  let D = null
  try {
    // Pin a recognizable dead candidate AND sabotage the first bind attempt deterministically
    // (Windows grants SO_REUSEADDR binds on almost any port, so an OS-level EACCES cannot be
    // staged reliably — the real-world trigger is WinNAT excluded ranges, which shift per boot).
    process.env.LAN_SYNC_UDP_FALLBACK_PORT = '58477'
    let sabotaged = 1
    dgram.createSocket = function (...args) {
      const s = origCreateSocket.apply(dgram, args)
      const origBind = s.bind.bind(s)
      s.bind = function (...bindArgs) {
        if (sabotaged > 0) {
          sabotaged--
          process.nextTick(() => s.emit('error', Object.assign(new Error('sabotaged bind (test)'), { code: 'EACCES' })))
          return s
        }
        return origBind(...bindArgs)
      }
      return s
    }
    Module._load = function (request, parent, isMain) {
      if (request === 'bonjour-service') throw new Error('stubbed unavailable (UDP fallback test)')
      return origLoad.call(this, request, parent, isMain)
    }
    // FALLBACK_PORT_CANDIDATES is built at require time — env must be set BEFORE the re-require.
    delete require.cache[require.resolve('../../../src/main/lan-sync/discovery.js')]
    const { createDiscovery: createUdpDiscovery } = require('../../../src/main/lan-sync/discovery.js')
    D = createUdpDiscovery()
    D.startAdvertising({ deviceId: 'udp-c', name: 'UDP-C', port: 58493 })
    const t0 = Date.now()
    while (Date.now() - t0 < 5000 && !D.udpFallbackPort()) await sleep(100)
    const bound = D.udpFallbackPort()
    assert.ok(bound > 0, 'a fallback candidate port actually bound')
    assert.notEqual(bound, 58477, 'the failed pinned candidate was ABANDONED, not retried forever (walk moved to the next candidate)')
  } finally {
    delete process.env.LAN_SYNC_UDP_FALLBACK_PORT
    dgram.createSocket = origCreateSocket
    Module._load = origLoad
    try { if (D) D.stop() } catch { /* noop */ }
  }
})

/** /24 prefixes of this machine's active non-internal IPv4 interfaces. */
function localPrefixes () {
  const out = new Set()
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (!ni || ni.internal || ni.family !== 'IPv4') continue
      const m = String(ni.address).match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
      if (m) out.add(m[1] + '.' + m[2] + '.' + m[3])
    }
  }
  return out
}

test('F3: same-subnet peer accepted with top score; cross-subnet scored lowest but NOT dropped', () => {
  const prefixes = localPrefixes()
  // a candidate in one of the machine's OWN /24s (this dev LAN is 192.168.111.x) -> highest
  const same = [...prefixes].map(px => px + '.77').find(h => isDialableHost(h))
  if (same) assert.ok(hostScore(same) >= 3, 'same-subnet IPv4 scores high: ' + same)
  // a candidate guaranteed OUTSIDE every local /24: RFC5737 documentation range + scan
  let cross = null
  for (const c of ['192.0.2.10', '198.51.100.10', '203.0.113.10', '10.99.99.10']) {
    const m = c.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
    if (!prefixes.has(m[1] + '.' + m[2] + '.' + m[3])) { cross = c; break }
  }
  assert.ok(cross, 'found a cross-subnet candidate')
  assert.equal(hostScore(cross), 1, 'cross-subnet IPv4: lowest-dialable score, not rejection')
  assert.ok(isDialableHost(cross), 'cross-subnet IPv4 is still accepted (rememberPeer guards dialing)')
  // scoped link-local IPv6: %scope stripped (advertiser's interface) and scored lowest
  assert.equal(hostScore('fe80::1234%12'), 1)
  assert.equal(hostScore('fe80::1234'), -1, 'scope-less link-local stays undialable')
})

/* ---------------- F4: re-fix budget + hibernate ---------------- */

test('F4: a flapping dead peer reaches hibernating (re-fix never resets the failure streak)', async () => {
  let resolveCalls = 0
  const nodeA = createLanSyncNode({
    deviceId: 'flap-a', name: 'Flap A', pairingSecret: 's', port: 0, host: '127.0.0.1',
    discoverFn: fakeDiscovery(), ingestSegment: () => ({ applied: 0 }),
    backoffBaseMs: 10, backoffMaxMs: 40,
    dialFailureBudget: 3, hibernateBackoffMs: 40,
    // "discovery" keeps offering a NEW wrong address (port 1 = instant refuse): the old code
    // reset the streak + budget on every re-fix -> infinite round-error spam, never hibernating.
    resolvePeer: id => (id === 'flap-b' ? { deviceId: 'flap-b', host: '127.0.0.' + (20 + (resolveCalls++ % 200)), port: 1 } : null),
  })
  nodeA.start()
  nodeA.addPeer({ deviceId: 'flap-b', host: '127.0.0.10', port: 1 })
  const seenHosts = new Set()
  let state = null
  const t0 = Date.now()
  while (Date.now() - t0 < 8000) {
    await nodeA.startSyncRound()
    await sleep(20)
    const p = nodeA.getStatus().peers.find(x => x.deviceId === 'flap-b')
    if (!p) break
    if (p.host) seenHosts.add(p.host)
    state = p.peerState
    if (state === 'hibernating') break
  }
  await nodeA.stop()
  assert.equal(state, 'hibernating', 'dead peer reaches hibernate despite address flapping')
  assert.ok(seenHosts.size <= 7, 're-fixes are budgeted (initial + 6/hour), saw: ' + seenHosts.size)
})

test('F4: a SUCCESSFUL round still resets the streak after a re-fix (healthy peer recovers)', async () => {
  const ingested = []
  const nodeB = createLanSyncNode({
    deviceId: 'flap-b2', name: 'B2', pairingSecret: 's2', port: 0, host: '127.0.0.1',
    discoverFn: fakeDiscovery(), ingestSegment: s => ingested.push(s),
  })
  const nodeA = createLanSyncNode({
    deviceId: 'flap-a2', name: 'A2', pairingSecret: 's2', port: 0, host: '127.0.0.1',
    discoverFn: fakeDiscovery(), ingestSegment: () => ({ applied: 0 }),
    backoffBaseMs: 20, backoffMaxMs: 100,
    buildSegments: () => [{ fromSeq: 1, toSeq: 1, deviceId: 'flap-a2', rows: [{ id: 'x1', seq: 1 }] }],
    resolvePeer: id => (id === 'flap-b2' ? { deviceId: 'flap-b2', host: '127.0.0.1', port: portB } : null),
  })
  nodeA.start(); nodeB.start()
  const portB = await nodeB.whenListening()
  nodeA.addPeer({ deviceId: 'flap-b2', host: '127.0.0.99', port: portB }) // wrong -> refused
  await nodeA.startSyncRound() // fails, re-fixes to the real address
  await sleep(40)
  let ok = false
  const t0 = Date.now()
  while (Date.now() - t0 < 5000) {
    ok = (await nodeA.startSyncRound()).confirmed === 1
    if (ok) break
    await sleep(40)
  }
  const p = nodeA.getStatus().peers.find(x => x.deviceId === 'flap-b2')
  await nodeA.stop(); await nodeB.stop()
  assert.ok(ok, 'round confirms after re-fix')
  assert.notEqual(p.peerState, 'hibernating', 'success keeps the peer out of hibernate')
})

/* ---------------- F5: missing habits blob is materialized from applied rows ---------------- */

test('F5: foldIntoBlob materializes a missing habits blob (fresh-paired device keeps its habits)', () => {
  const metaWrites = []
  const state = {
    db: { call (op, p) {
      if (op === 'getMeta') return null // db.habitsState does not exist yet (fresh device)
      if (op === 'setMeta') { metaWrites.push({ key: p[0], doc: JSON.parse(p[1]) }); return true }
      return null
    } },
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
    applied: {
      kinds: new Set(['setting']),
      // a peer's habits push applied rows: the bridge decoded them into the settingsPatch
      settingsPatch: { habits: [{ id: 'h1', name: 'Run', records: {} }], moments: [], savedAt: 1727000000000 },
      conflicts: [],
    },
    getWindowSenders: () => [],
    resyncExternalWatch: null,
  }
  boot.__test.setState(state)
  boot.__test.emitAppliedRound()
  const w = metaWrites.find(x => x.key === 'db.habitsState')
  assert.ok(w, 'missing blob must be written (fold = create), not skipped')
  assert.deepEqual(w.doc.habits, [{ id: 'h1', name: 'Run', records: {} }])
  assert.equal(w.doc.savedAt, 1727000000000)
  assert.ok(w.doc.schemaV >= 1, 'materialized blob carries the renderer persist shape')
  assert.ok(metaWrites.find(x => x.key === 'db.settingsState') === undefined, 'no spurious settings blob write')
})

/* ---------------- F6: restore-backup habits force-applies and persists ---------------- */

test('F6: habits replaceAll with force applies an OLDER savedAt and persists to the DB meta row', async () => {
  const mod = await import('../../../renderer/js/store/habits.js')
  const store = mod.default
  const calls = []
  globalThis.window.todoAPI = { dbCall: async (op, p) => { calls.push({ op, p }); return true } }
  const s = { habits: [{ id: 'new', name: 'Newer', records: {} }], moments: [], savedAt: 9000000000000 }
  // stale blob WITHOUT force: guard holds (no restore, no persist)
  store.mutations.replaceAll(s, { schemaV: 1, habits: [{ id: 'old', name: 'Older', records: {} }], moments: [], savedAt: 1000 })
  assert.equal(s.habits[0].id, 'new', 'stale savedAt still rejected without force')
  assert.equal(calls.length, 0)
  // restore path: force bypasses the guard AND persists
  store.mutations.replaceAll(s, { schemaV: 1, habits: [{ id: 'old', name: 'Older', records: {} }], moments: [], savedAt: 1000, force: true })
  assert.equal(s.habits[0].id, 'old', 'restore force-applies an older backup')
  const meta = calls.find(c => c.op === 'setMeta' && c.p[0] === 'db.habitsState')
  assert.ok(meta, 'restored blob persisted to the durable DB meta row (reaches sync)')
  assert.equal(JSON.parse(meta.p[1]).habits[0].id, 'old')
  delete globalThis.window.todoAPI
})

/* ---------------- F7: recycle-bin todos never re-pull attachments ---------------- */

test('F7: missing-attachment collection only considers LIVE todos', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickdone-f7-'))
  try {
    fs.writeFileSync(path.join(dir, 'present.jpg'), 'x')
    const rows = [
      { taskId: 'live', delete: 0, image: JSON.stringify([{ url: 'local://present.jpg' }, { url: 'local://missing.jpg' }]) },
      // recycle-bin row: its file is gone on purpose and must NOT be requested
      { taskId: 'dead', delete: 1, deletedAt: 123, image: JSON.stringify([{ url: 'local://purged.jpg' }]) },
    ]
    const st = { db: { call (op, params) {
      if (op === 'getAll') {
        assert.deepEqual(params, { deleted: 0 }, 'the collection must query LIVE rows only')
        return rows.filter(r => !r.delete)
      }
      return null
    } } }
    const keys = boot.__test.missingAttachmentKeys(st, { attachDir: dir })
    assert.deepEqual(keys.sort(), ['missing.jpg'], 'only the live todo’s missing key is requested')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/* ---------------- F8: queued CLI slot command at seq === counter ---------------- */

test('F8: cliSyncCmd slot at seq === counter executes ONCE after restart, not twice', async () => {
  const makeMeta = () => ({
    cliSyncSeq: '5',
    cliSyncCmd: JSON.stringify({ seq: 5, action: 'status' }), // crashed between slot-write and handle
  })
  const runBoot = async (meta) => {
    const dispatchLog = []
    const ch = createSyncCmdHandler({
      dispatch: op => { dispatchLog.push(op); return {} },
      setMeta: () => {},
      getMeta: k => (k in meta ? meta[k] : null),
      deleteMeta: k => { delete meta[k] },
      log: { warn: () => {} },
    })
    ch.forward(meta.cliSyncCmd || null)
    await sleep(20)
    return dispatchLog
  }
  // restart 1: the queued command (seq === counter) must EXECUTE exactly once
  const meta1 = makeMeta()
  const log1 = await runBoot(meta1)
  assert.deepEqual(log1, ['syncGetStatus'], 'queued command handled once')
  assert.equal(meta1.cliSyncCmd, undefined, 'handled slot cleared')
  // restart 2: slot gone -> nothing re-executes
  const log2 = await runBoot(meta1)
  assert.deepEqual(log2, [], 'no re-execution on the second restart')
  // stale slot (seq < counter: already handled, delete lost) must NOT re-execute
  const meta3 = { cliSyncSeq: '9', cliSyncCmd: JSON.stringify({ seq: 4, action: 'status' }) }
  assert.deepEqual(await runBoot(meta3), [])
})

test('F8: the tomato channel seeding mirrors the slot fix (source contract)', async () => {
  const src = fs.readFileSync(here('../../../src/main/index.js'), 'utf8')
  assert.ok(/cliTomatoCmd[\s\S]{0,400}lastTomatoSeq -= 1/.test(src), 'tomato watermark seeds from a queued slot (counter - 1)')
})

/* ---------------- F9: misc guards ---------------- */

test('F9a: onShortcutAction / onSecurityLock subscriptions are existence-guarded', () => {
  const src = fs.readFileSync(here('../../../renderer/js/main.js'), 'utf8')
  assert.ok(src.includes('if (window.todoAPI.onShortcutAction)'), 'shortcut dispatch guarded')
  assert.ok(src.includes('if (window.todoAPI.onSecurityLock)'), 'security-lock subscription guarded')
})

test('F9b: invalidateSyncWatermarks logs a live-map clear failure instead of swallowing it', () => {
  const src = fs.readFileSync(here('../../../src/main/lan-sync-bootstrap.js'), 'utf8')
  assert.ok(src.includes('live watermark map clear failed'))
})

test('F9c/d: legacy folded guards treat missing gen as 1; OWN_KEYS_LS pruned after compaction', () => {
  const src = fs.readFileSync(here('../../../renderer/js/store/auth.js'), 'utf8')
  assert.ok(/Number\.isFinite\(Number\(f\.gen\)\) \? Number\(f\.gen\) : 1/.test(src), 'missing gen = gen 1')
  assert.ok(src.includes('prune OWN_KEYS_LS'), 'own-key index pruned after compaction')
})

test('F9e: foldedTodoList inbound arrays drop non-string junk entries', async () => {
  const { sanitizeSettingsPatch } = await import('../../../renderer/js/store/settings.js')
  const out = sanitizeSettingsPatch({ foldedTodoList: ['today-done', 42, true, null, {}, 'day-done'] }, null)
  assert.deepEqual(out.foldedTodoList, ['today-done', 'day-done'])
})
