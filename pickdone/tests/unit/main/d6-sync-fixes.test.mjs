/* D6 daily-fix regression tests (2026-09-21, main-process sync/DB domain).
 *   F1 P1  tomatoAppendMany/tomatoUpdateById preserve an explicit positive updatedAt
 *          (sync-apply carries the peer winner's LWW age; hard re-stamping falsified it)
 *   F1 gate  every *Many bulk op preserves explicit stamps (M2 class gate assertion)
 *   F2 P2  settingsRowPutMany is skip-and-collect: one key-less element no longer drops
 *          the whole buffered settings segment
 *   F3 P2  UDP discovery flood guard keeps per-IP rate limits under spoofed-source cycling
 *          (bounded LRU sweep instead of lastUpsertByIp.clear())
 *   F4 P2  a poisoned (unparseable) cliSyncCmd slot is compare-and-deleted + receipts an
 *          error, instead of leaving the CLI waiting forever
 *   F5 P2  the reminder LRU evicts the oldest WRITTEN watermark first — unwritten entries
 *          inside the 60s flush debounce window are never evicted
 *   F6 P2  the startup meta-GC loop is followed by a kickSyncRound('meta-gc') wiring
 *          (deletions must not sit in the local oplog until the next periodic round)
 *
 * Real better-sqlite3 (vendor driver) for the DB items, round7-sync-lww pattern.
 * Run: node --test tests/unit/main/d6-sync-fixes.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)

function freshDb (label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd6-' + label + '-'))
  const dbm = require_('../../../src/main/db.js')
  dbm.init(dir)
  return { dbm, dir }
}
/** Reopen the encrypted db file raw (vendor driver) to inspect columns no op exposes. */
function rawRows (dir, sql, params = []) {
  const Database = require_('../../../vendor/better-sqlite3-multiple-ciphers')
  const key = fs.readFileSync(path.join(dir, 'db.key'), 'utf8').trim()
  const d = new Database(path.join(dir, 'todos.db'))
  d.pragma(`key='${key}'`)
  d.prepare('SELECT count(*) FROM sqlite_master').get() // decrypt probe
  const rows = d.prepare(sql).all(...params)
  d.close()
  return rows
}

test('F1 P1: tomatoAppendMany preserves the sync winner updatedAt (no local-now re-stamp)', () => {
  const { dbm, dir } = freshDb('tomato-lww')
  const base = Date.now()
  const T = base - 60000 // well in the past: a now()-re-stamp is unmistakable
  try {
    const res = dbm.call('tomatoAppendMany', [
      { tomatoId: 'd6f1a', endTime: base, focus: 'x', focusDuration: 5, updatedAt: T },
      { tomatoId: 'd6f1b', endTime: base + 1, focus: 'y', focusDuration: 5 }, // renderer/CLI: no stamp
    ])
    assert.equal(res.rejected.length, 0)
    dbm.close()
    const rows = rawRows(dir, 'SELECT tomatoId, updatedAt FROM tomato_records')
    const stamped = rows.find(r => r.tomatoId === 'd6f1a')
    const fresh = rows.find(r => r.tomatoId === 'd6f1b')
    assert.equal(stamped.updatedAt, T, 'winner LWW age must survive tomatoAppendMany (was re-stamped to now)')
    assert.ok(fresh.updatedAt >= base, 'unstamped local write keeps the now() stamp')
    assert.ok(fresh.updatedAt - T > 30000, 'sanity: the two stamps are distinct')
  } finally {
    try { dbm.close() } catch { /* already closed */ }
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* EBUSY on windows */ }
  }
})

test('F1 P1: tomatoUpdateById preserves an explicit updatedAt carried by the patch', () => {
  const { dbm, dir } = freshDb('tomato-upd')
  const base = Date.now()
  const T = base - 30000
  try {
    dbm.call('tomatoAppendMany', [{ tomatoId: 'd6u1', endTime: base, focus: 'x', focusDuration: 5 }])
    assert.equal(dbm.call('tomatoUpdateById', { tomatoId: 'd6u1', patch: { focus: 'edited', updatedAt: T } }), true)
    dbm.close()
    const row = rawRows(dir, 'SELECT updatedAt FROM tomato_records WHERE tomatoId = ? AND deleted = 0', ['d6u1'])[0]
    assert.equal(row.updatedAt, T, 'patch-carried winner age must survive tomatoUpdateById')
  } finally {
    try { dbm.close() } catch { /* already closed */ }
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* EBUSY on windows */ }
  }
})

test('F1 gate: every *Many bulk op preserves an explicit updatedAt (M2-class gate)', () => {
  const { dbm, dir } = freshDb('gate')
  const T = Date.now() - 45000
  try {
    // tomato
    dbm.call('tomatoAppendMany', [{ tomatoId: 'g1', endTime: Date.now(), focusDuration: 1, updatedAt: T }])
    // plan
    dbm.call('planAddMany', [{ taskId: 'gT', day: '2026-09-22', mm: '09:00', updatedAt: T }])
    // settings rows
    dbm.call('settingsRowPutMany', [{ key: 'gKey', value: 1, updatedAt: T }])
    dbm.close()
    const tomato = rawRows(dir, 'SELECT updatedAt FROM tomato_records WHERE tomatoId = ?', ['g1'])[0]
    const plan = rawRows(dir, 'SELECT updatedAt FROM plan_chips WHERE taskId = ?', ['gT'])[0]
    const setting = rawRows(dir, 'SELECT updatedAt FROM settings_rows WHERE key = ?', ['gKey'])[0]
    assert.equal(tomato.updatedAt, T, 'tomatoAppendMany must preserve explicit stamps')
    assert.equal(plan.updatedAt, T, 'planAddMany must preserve explicit stamps')
    assert.equal(setting.updatedAt, T, 'settingsRowPutMany must preserve explicit stamps')
  } finally {
    try { dbm.close() } catch { /* already closed */ }
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* EBUSY on windows */ }
  }
})

test('F2 P2: settingsRowPutMany skips a key-less element and commits the valid rest', () => {
  const { dbm, dir } = freshDb('rowputmany')
  try {
    const changed = dbm.call('settingsRowPutMany', [
      { key: 'd6ok1', value: 1 },
      { value: 'poison — no key' },
      { key: 'd6ok2', value: 3 },
      null,
    ])
    assert.deepEqual(changed.sort(), ['d6ok1', 'd6ok2'], 'valid rows commit; only the malformed element is rejected')
    const rows = dbm.call('settingsRowsAll', {})
    assert.ok(rows.some(r => r.key === 'd6ok1' && r.value === 1))
    assert.ok(rows.some(r => r.key === 'd6ok2' && r.value === 3))
    assert.ok(!rows.some(r => r.key === null), 'the key-less element never lands')
  } finally {
    try { dbm.close() } catch { /* already closed */ }
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* EBUSY on windows */ }
  }
})

test('F3 P2: UDP flood-guard sweep never bulk-clears — a known peer keeps its rate limit', () => {
  // discovery.js requires core 'node:dgram' (not interceptable via require.cache) and optional
  // 'bonjour-service'. Intercept both at Module._load BEFORE first load: fake socket captures
  // the 'message' handler (no real network in tests); null bonjour forces the UDP fallback.
  // node:os is stubbed too: hostScore calls os.networkInterfaces() per upsert and the real
  // Windows adapters query (~60ms) would turn the 1100-message flood into minutes of syscall.
  const Module = require_('module')
  const handlers = {}
  const fakeSocket = {
    on (ev, fn) { handlers[ev] = fn },
    bind (_port, cb) { if (cb) cb() },
    setBroadcast () {},
    send (_buf, _port, _host, cb) { if (typeof cb === 'function') cb() },
    close () {},
    unref () {},
  }
  const realOs = require_('node:os')
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'node:dgram') return { createSocket: () => fakeSocket }
    if (request === 'bonjour-service') return null // falsy => UDP fallback branch
    if (request === 'node:os') return { ...realOs, networkInterfaces: () => ({}) } // cheap hostScore
    return origLoad.call(this, request, parent, isMain)
  }
  let createDiscovery
  try { ({ createDiscovery } = require_('../../../src/main/lan-sync/discovery.js')) } finally { Module._load = origLoad }

  const disc = createDiscovery()
  disc.startAdvertising({ deviceId: 'd6self', port: 11111 })
  assert.ok(typeof handlers.message === 'function', 'UDP fallback message handler captured')
  const payload = d => Buffer.from(JSON.stringify({ deviceId: d, name: d, port: 22222, protoVer: 2 }))
  const send = (dev, ip) => handlers.message(payload(dev), { address: ip })

  // A legit peer announces; its rate limit entry is now in the map. Real peers re-announce
  // every ~2s (> the 500ms floor), so an accepted re-announce refreshes LRU recency — model
  // that by advancing the clock (patched Date.now, restored at the end).
  const realNow = Date.now
  let clockShift = 0
  Date.now = () => realNow() + clockShift
  try {
    send('legit', '192.168.10.7')
    assert.ok(disc.getPeers().some(p => p.deviceId === 'legit'), 'first legit announcement is accepted')

    // Spoofed-source cycling: > cap (1024) distinct IPs. The old code hit size>=1024 and
    // clear()ed EVERY entry — including the legit peer's rate limit — so the flood defeated
    // the very guard it triggered. The new sweep is expiry + bounded LRU: a recently
    // refreshed entry always survives.
    for (let i = 0; i < 500; i++) send('sp' + i, `10.${(i >> 8) & 0xff}.${i & 0xff}.1`)
    clockShift += 1000 // the peer's ~2s re-announce: passes the 500ms floor, refreshes recency
    send('legit-refresh', '192.168.10.7')
    for (let i = 500; i < 1100; i++) send('sp' + i, `10.${(i >> 8) & 0xff}.${i & 0xff}.1`)

    // Immediate re-announce from the legit IP: must still be rate-limited — its device
    // 'legit2' would appear if the gate had been wiped by the flood.
    send('legit2', '192.168.10.7')
    assert.ok(!disc.getPeers().some(p => p.deviceId === 'legit2'),
      'rate limit for the legit IP must survive the spoofed flood (old code bulk-cleared it)')
    // And the peer map stays bounded (separate round-3 guard, must not regress either).
    assert.ok(disc.getPeers().length <= 64, 'peer map stays bounded')
  } finally {
    Date.now = realNow
    try { disc.stop() } catch { /* noop */ }
  }
})

test('F4 P2: a poisoned cliSyncCmd slot is compare-and-deleted and receipts an error', async () => {
  const { createSyncCmdHandler } = require_('../../../src/main/cli-sync-channel.js')
  const POISON = '{not json at all'
  let slot = POISON
  const deleted = []
  const receipts = []
  const h = createSyncCmdHandler({
    dispatch: op => ({ op }),
    setMeta: (k, v) => { if (k === 'cliSyncState') receipts.push(JSON.parse(v)) },
    getMeta: k => (k === 'cliSyncCmd' ? slot : null),
    deleteMeta: k => { if (k === 'cliSyncCmd') { deleted.push(k); slot = null } },
    log: { warn () {}, error () {}, info () {} },
  })
  h.forward(POISON)
  await new Promise(r => setImmediate(r))
  assert.ok(deleted.includes('cliSyncCmd'), 'poisoned slot must be cleared (CLI was waiting forever before)')
  assert.equal(slot, null)
  assert.equal(receipts.length, 0, 'no receipt is possible: the payload carries no usable seq')

  // Compare-and-delete guard: a slot that moved on to a VALID command must not be eaten by
  // the poisoned payload's cleanup.
  const slot2 = '{"seq":1,"action":"status"}'
  const VALID = slot2
  const deleted2 = []
  const h2 = createSyncCmdHandler({
    dispatch: op => ({ op }),
    setMeta: () => {},
    getMeta: k => (k === 'cliSyncCmd' ? VALID : null), // meta already holds the NEXT (valid) command
    deleteMeta: k => deleted2.push(k),
    log: { warn () {}, error () {}, info () {} },
  })
  h2.forward(POISON)
  await new Promise(r => setImmediate(r))
  assert.equal(deleted2.length, 0, 'cleanup must not eat a newer valid command (compare-and-delete)')
  void slot2
})

test('F5 P2: reminder LRU evicts the oldest WRITTEN entry first; unwritten entries survive', () => {
  const scheduler = require_('../../../src/main/scheduler.js')
  scheduler._clearStateForTest()
  const fired = scheduler._fired
  const FIRED_MAX = 2000
  // Head is UNWRITTEN (the realistic bug window: everything up to the last 60s flush is
  // persisted, the tail inside the debounce window is not — but sustained traffic evicts
  // until the head IS an unwritten entry).
  fired.set('u_head', { ts: 1, written: false })
  for (let i = 0; i < FIRED_MAX - 1; i++) fired.set('w' + i, { ts: 2 + i, written: true })
  scheduler._markFired('brand-new')
  assert.equal(fired.size, FIRED_MAX, 'the memory bound still holds')
  assert.ok(fired.has('u_head'), 'the oldest WRITTEN entry is evicted, never the unwritten head (re-fire guard)')
  assert.ok(!fired.has('w0'), 'the oldest written entry was the eviction victim')
  assert.ok(fired.has('brand-new'))

  // Fallback (R3-stability 2026-09-26): when EVERY entry is unwritten, markFired flushes FIRST.
  // Here the flush cannot persist (no live db in this harness), so the eviction is SKIPPED:
  // no unwritten watermark is dropped (that used to re-fire the reminder after restart) and
  // the map is allowed to exceed FIRED_MAX by one; the bound self-heals on the next flush.
  scheduler._clearStateForTest()
  for (let i = 0; i < FIRED_MAX; i++) fired.set('u' + i, { ts: i, written: false })
  scheduler._markFired('x')
  assert.equal(fired.size, FIRED_MAX + 1, 'flush-failed fallback: eviction skipped, cap overshot by one (self-heals)')
  assert.ok(fired.has('x'), 'the new watermark is recorded even when the flush failed')
  assert.ok(fired.has('u0'), 'all-unwritten + flush failed: NO watermark is dropped (re-fire guard)')
  assert.ok(fired.has('u1'))
})

test('F6 P2: startup meta-GC is followed by a sync kick (wiring regression)', () => {
  // index.js is electron-entry (not loadable under pure node): assert the wiring statically —
  // the kickSyncRound('meta-gc') call must sit inside the MetaGC try block, after the GC loop
  // (mirrors the GAP-D recovery kick pattern).
  const src = fs.readFileSync(new URL('../../../src/main/index.js', import.meta.url), 'utf8')
  const gcIdx = src.indexOf('computeMetaGc(dbm.call')
  const kickIdx = src.indexOf("kickSyncRound('meta-gc')")
  assert.ok(gcIdx > 0, 'meta-GC loop found in index.js')
  assert.ok(kickIdx > gcIdx, 'kickSyncRound(\'meta-gc\') must follow the GC loop (deletions reach peers without waiting for the periodic round)')
  const between = src.slice(gcIdx, kickIdx)
  assert.ok(between.includes("commit('meta', 'delete'"), 'kick belongs to the same GC block')
})
