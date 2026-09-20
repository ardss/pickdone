/* D5 maint round (2026-09-20) — src/main regression tests, each with its behavior fix:
 *  1. [P1] db.js bumpSnow idempotency: optional dedupKey installs a transactional once-guard
 *     (meta snowDedup:<taskId>:<dedupKey>) — replaying the same key credits ONCE; no key keeps
 *     the legacy behavior (renderer replays on ambiguous failure and used to double-credit).
 *  2. [P2] db.js upsertCategory: a ROW-shape tombstone (deleted:1, no `delete`) now gets
 *     deletedAt stamped (was 0), and a second identical call preserves the original stamp.
 *  3. [P1] dbRecovery: a failed quarantine rename aborts the branch with source:'error' and
 *     NEVER copies the backup over a possibly-locked target (was a silent `catch {}` + copy).
 *  4. [P2] tomato-announce listAnnounces: pointer enumeration cached behind an oplog-seq
 *     watermark — a second call with no new rows performs no oplog scan.
 *  5. [P2] att-transfer serve: a failed frame send aborts the batch ({aborted:true}) instead of
 *     streaming the rest into a dead socket until the peer's 120s round deadline.
 *  6. [P2] transport.send returns a delivery boolean (false for dead sockets / write throws).
 *  7. [P2] discovery: repeated discover(cb) no longer stacks duplicate 'found' listeners.
 *  8. [P2] sync-apply: per-row emitRemoteAnnounce is coalesced to one fan-out per flush.
 *  9. [P2] updater flushOnceOnReady: _activeFlushRound is cleared when the round completes;
 *     forwardFlushAck ignores stale rounds.
 * 10. [P2] config-store: a quarantine-rename failure gates writes off (no clobber of the
 *     unreadable-but-in-place config.json).
 * 11. [P2] lan-sync-bootstrap stopSync: the throttled security-ring persist is flushed
 *     synchronously before the node is torn down (pending entries no longer lost on quit).
 * Real temp DB via TODO_DB_DIR (h7 pattern), never touches real data.
 * Run: node --test tests/unit/main/d5-main-round.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'
import { fileURLToPath } from 'node:url'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-d5-main-'))
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const core = require_('../../../src/main/core/todo-core.js')

db.init(process.env.TODO_DB_DIR)

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')

let _seq = 0
function seed (over = {}) {
  const now = Date.now() + (_seq++)
  const t = {
    complete: false, createTime: now, delete: false,
    reminderTime: 0, reminderOffsets: [], reminderExtra: [], estimate: 0, difficulty: 0,
    repeatId: null, subtasks: null, image: null, files: null,
    categoryId: 0, updateTime: now, syncTime: 0,
    taskContent: 'd5任务', taskDescribe: '',
    taskSort: 0, todoTime: 0, userId: 1, status: 'add', version: 0, ...over
  }
  if (!t.taskId) t.taskId = core.genTaskId(1, now)
  db.call('upsert', t)
  return db.call('getById', t.taskId)
}

/* ---- 1: bumpSnow dedupKey idempotency ---- */
test('d5-1: same bumpSnow dedupKey twice credits once; no key keeps legacy behavior', () => {
  const a = seed({ taskContent: 'd5专注A' })
  const r1 = db.call('bumpSnow', { taskId: a.taskId, minutes: 25, dedupKey: 'session-1' })
  assert.equal(r1.ok, true)
  assert.equal(r1.minutes, 25)
  assert.equal(db.call('getById', a.taskId).estimate, 25) // focusMinutes surfaces as estimate in todo shape
  // ambiguous-failure replay: same key must NOT double-credit
  const r2 = db.call('bumpSnow', { taskId: a.taskId, minutes: 25, dedupKey: 'session-1' })
  assert.equal(r2.ok, true)
  assert.equal(r2.deduped, true)
  assert.equal(r2.minutes, 0)
  assert.equal(db.call('getById', a.taskId).estimate, 25)
  // a different key credits again (per-session guard, not per-task)
  const r3 = db.call('bumpSnow', { taskId: a.taskId, minutes: 10, dedupKey: 'session-2' })
  assert.equal(r3.ok, true)
  assert.equal(db.call('getById', a.taskId).estimate, 35)
  // backward compat: no dedupKey → legacy blind increment
  const r4 = db.call('bumpSnow', { taskId: a.taskId, minutes: 5 })
  assert.equal(r4.ok, true)
  assert.equal(db.call('getById', a.taskId).estimate, 40)
})

/* ---- 2: upsertCategory row-shape tombstone deletedAt ---- */
test('d5-2: row-shape tombstone (deleted:1) gets deletedAt stamped; second call preserves it', () => {
  const row = over => Object.assign({ id: 8001, userId: 1, name: 'd5分类', deleted: 1 }, over)
  assert.equal(db.call('upsertCategory', row()), true, 'first row-shape tombstone writes')
  assert.equal(db.call('upsertCategory', row({ deletedAt: 1234567890123 })), true, 'explicit deletedAt rewrite wins')
  const base = db.call('syncOplogSince', { sinceSeq: 0 }).pop().seq
  // THE fix discriminator: without the stamp the plain row-shape re-upsert computed deletedAt=0
  // ≠ stored 1234567890123 → a WRITE (fake delta). With the stamp it preserves the prior value
  // → identical row → no-op.
  assert.equal(db.call('upsertCategory', row()), false,
    'row-shape tombstone must preserve the prior deletedAt (fix: stamped at tombstone time)')
  assert.equal(db.call('syncOplogSince', { sinceSeq: base }).length, 0, 'no fake delta')
  // renderer-shape (`delete`) tombstones keep stamping too
  assert.equal(db.call('upsertCategory', { id: 8002, userId: 1, name: 'd5分类2', delete: 1 }), true)
})

/* ---- 3: dbRecovery failed quarantine rename aborts (Windows-locked-file semantics) ---- */
test('d5-3: unquarantineable corrupt DB aborts with source:error, no backup clobber', () => {
  const { attemptDbRecovery } = require_('../../../src/main/dbRecovery.cjs')
  const realFs = require_('node:fs')
  const origRename = realFs.renameSync
  // Simulate the locked file cross-platform: the -wal quarantine rename fails (real EBUSY on
  // Windows cannot be produced portably — Node opens handles with FILE_SHARE_DELETE).
  realFs.renameSync = function (src, dst) {
    if (String(src).endsWith('todos.db-wal')) { const e = new Error('EBUSY: resource busy (simulated lock)'); e.code = 'EBUSY'; throw e }
    return origRename.call(this, src, dst)
  }
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-d5-rec-'))
  // Corrupt main DB (wrong header) + a recoverable plain-bak with DISTINCT content.
  fs.writeFileSync(path.join(ud, 'todos.db'), 'not-a-sqlite-file-at-all')
  fs.writeFileSync(path.join(ud, 'todos.db-wal'), 'wal-junk')
  fs.writeFileSync(path.join(ud, 'todos.db.plain-bak'), 'BACKUP-CONTENT')
  try {
    const r = attemptDbRecovery(ud, null)
    assert.equal(r.source, 'error', 'rename failure must abort the branch with source:error, got ' + JSON.stringify(r))
    assert.ok(r.label && r.label.length > 10, 'structured label for the relaunch dialog')
    // No copy over the locked target: todos.db-wal still holds its original bytes and no
    // todos.db was materialized from the backup.
    assert.equal(fs.readFileSync(path.join(ud, 'todos.db-wal'), 'utf8'), 'wal-junk')
    assert.ok(!fs.existsSync(path.join(ud, 'todos.db')), 'no backup copied over the locked target')
    assert.equal(fs.readFileSync(path.join(ud, 'todos.db.plain-bak'), 'utf8'), 'BACKUP-CONTENT')
  } finally {
    realFs.renameSync = origRename
    fs.rmSync(ud, { recursive: true, force: true })
  }
})

/* ---- 4: tomato-announce listAnnounces watermark cache ---- */
test('d5-4: listAnnounces re-scans only new oplog seqs (watermark cache), values stay fresh', () => {
  const ta = require_('../../../src/main/tomato-announce.js')
  ta.__reset()
  let scannedRows = 0
  const meta = new Map()
  let seq = 0
  const oplog = []
  const pushPointer = (entityId) => { seq += 1; oplog.push({ seq, entity: 'meta', entityId, ts: Date.now() + seq }) }
  ta.init({
    dbCall: (op, p) => {
      if (op === 'syncOplogSince') {
        const rows = oplog.filter(r => r.seq > (p.sinceSeq || 0)).slice(0, p.limit || 10000)
        scannedRows += rows.length
        return rows
      }
      if (op === 'getMeta') return meta.get(p) ?? null
      throw new Error('unexpected op ' + op)
    },
    getIdentity: () => ({ deviceId: 'local', deviceName: 'local' }),
  })
  meta.set(ta.keyFor('devA'), JSON.stringify({ deviceId: 'devA', deviceName: 'A', status: 'running', startedAt: Date.now(), plannedSec: 600, at: Date.now() }))
  pushPointer(ta.keyFor('devA'))
  const l1 = ta.listAnnounces()
  assert.equal(l1.length, 1)
  assert.equal(l1[0].deviceId, 'devA')
  const rowsAfterFirst = scannedRows
  // No new rows → the only query is the incremental "anything past the watermark?" (0 rows),
  // never a full re-scan of the accumulated oplog.
  const l2 = ta.listAnnounces()
  assert.equal(scannedRows, rowsAfterFirst, 'second call with no new seqs must re-scan zero rows')
  assert.equal(l2.length, 1)
  // A NEW announce row → incremental re-scan from the watermark picks it up (correctness).
  meta.set(ta.keyFor('devB'), JSON.stringify({ deviceId: 'devB', deviceName: 'B', status: 'idle', startedAt: 0, plannedSec: 0, at: Date.now() }))
  pushPointer(ta.keyFor('devB'))
  const l3 = ta.listAnnounces()
  assert.equal(scannedRows, rowsAfterFirst + 1, 'only the new seq range is scanned')
  assert.equal(l3.map(v => v.deviceId).sort().join(','), 'devA,devB')
  ta.__reset()
})

/* ---- 5: att-transfer serve aborts on a failed frame send ---- */
test('d5-5: serve aborts with {aborted:true} when a frame send returns false', () => {
  const { createAttachmentServer, MAX_FILES_PER_ROUND } = require_('../../../src/main/lan-sync/att-transfer.js')
  const blob = Buffer.alloc(1024, 7)
  const files = ['a', 'b', 'c']
  const server = createAttachmentServer({
    exists: k => files.includes(k),
    size: k => blob.length,
    read: k => blob,
  })
  const sent = []
  const r = server.serve({ deviceId: 'peer1' }, { ids: files }, m => {
    sent.push(m.type)
    return false // socket dead: every send fails
  })
  assert.equal(r.aborted, true, 'serve must report the abort')
  assert.equal(r.sent, 0)
  assert.ok(sent.length < files.length + 1, 'must stop replaying frames into the dead socket, sent=' + sent.length)
  // healthy path unchanged
  const ok = server.serve({ deviceId: 'peer2' }, { ids: ['a'] }, m => { sent.push(m.type); return true })
  assert.equal(ok.sent, 1)
  assert.equal(ok.aborted, undefined)
  void MAX_FILES_PER_ROUND
})

/* ---- 6: transport.send delivery boolean ---- */
test('d5-6: send returns true on write, false for dead sockets and write throws', () => {
  const { send } = require_('../../../src/main/lan-sync/transport.js')
  assert.equal(send(null, { a: 1 }), false)
  assert.equal(send({ destroyed: true, writable: true, write: () => true }, { a: 1 }), false)
  assert.equal(send({ destroyed: false, writable: false, write: () => true }, { a: 1 }), false)
  const good = { destroyed: false, writable: true, write: () => true }
  assert.equal(send(good, { a: 1 }), true)
  assert.equal(send({ destroyed: false, writable: true, write: () => { throw new Error('boom') } }, { a: 1 }), false)
})

/* ---- 7: discovery duplicate discover(cb) listener dedupe ---- */
test('d5-7: repeated discover(cb) emits onFound once per peer, not once per registration', () => {
  const { createDiscovery } = require_('../../../src/main/lan-sync/discovery.js')
  const d = createDiscovery()
  const hits = []
  const cb = p => hits.push(p.deviceId)
  d.discover(cb)
  d.discover(cb) // duplicate registration (restart discovery with the same callback)
  d._upsertPeer({ deviceId: 'devX', port: 58471, host: '192.168.31.50' })
  d._upsertPeer({ deviceId: 'devX', port: 58471 }) // known peer refresh → no duplicate emit
  assert.equal(hits.filter(x => x === 'devX').length, 1, 'deduped listener: exactly one found emit')
  d.stop()
})

/* ---- 8: sync-apply coalesced emitRemoteAnnounce ---- */
test('d5-8: announce fan-out coalesces per ingest pass — emitted at flush, not per row', () => {
  const syncApply = require_('../../../src/main/sync-apply.js')
  const ta = require_('../../../src/main/tomato-announce.js')
  ta.__reset()
  const emitted = []
  ta.onRemoteAnnounce(v => emitted.push(v.deviceId))
  const state = {
    deviceId: 'local',
    applyCache: null,
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
    applied: null,
    db: { call: (op, p) => { if (op === 'setMeta') return true; if (op === 'getMeta') return null; if (op === 'syncOplogSince') return []; if (op === 'getAll') return []; return null } },
  }
  const mk = (id, status) => ({
    entity: 'meta', id: ta.keyFor(id), updatedAt: Date.now(), deleted: false, deletedAt: 0,
    data: { key: ta.keyFor(id), value: JSON.stringify({ deviceId: id, deviceName: id, status, startedAt: Date.now(), plannedSec: 600, at: Date.now() }) },
  })
  assert.equal(syncApply.applyRowSafe(state, mk('dev1', 'running')), true)
  assert.equal(syncApply.applyRowSafe(state, mk('dev1', 'idle')), true)
  assert.equal(syncApply.applyRowSafe(state, mk('dev2', 'running')), true)
  assert.equal(emitted.length, 0, 'per-row fan-out must be deferred to the flush')
  syncApply.flushPendingWrites(state)
  assert.equal(emitted.length, 2, 'one emit per device after flush (last value wins per key)')
  assert.deepEqual(emitted.sort(), ['dev1', 'dev2'])
  ta.__reset()
})

/* ---- 9: updater early-flush round lifecycle ---- */
// electron-updater touches electron.app.getVersion at require time — stub it for module load
// (d4-round-fixes freshRequireWithElectron pattern).
const ELECTRON_UPDATER_STUB = { app: { getVersion: () => '0.0.0' } }
function freshRequireWithElectron (modulePath, electronStub) {
  const Module = require_('module')
  const resolved = require_.resolve(modulePath)
  delete require_.cache[resolved]
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub
    if (request === 'electron-updater') return { autoUpdater: { on: () => {}, checkForUpdates: async () => {}, downloadUpdate: async () => {}, quitAndInstall: () => {}, isUpdaterActive: () => false } }
    return origLoad.call(this, request, parent, isMain)
  }
  try { return require_(modulePath) } finally { Module._load = origLoad }
}
test('d5-9: flushOnceOnReady clears the active round; forwardFlushAck ignores stale rounds', async () => {
  const updater = freshRequireWithElectron(path.join(ROOT, 'src/main/updater.js'), ELECTRON_UPDATER_STUB)
  let flushed = 0
  const tracker = {
    nextToken: () => 'tok-1',
    beginRound: () => {},
    allAcked: () => true,
    ack: () => true,
  }
  updater.flushOnceOnReady({ tracker, getWindows: () => [], flushMain: () => { flushed++ }, ACK_CAP_MS: 2000 })
  // round already complete (allAcked=true): after the poll tick the tracker must be cleared.
  await new Promise(r => setTimeout(r, 120))
  assert.equal(flushed, 1, 'main flush ran once')
  assert.equal(updater.forwardFlushAck('tok-1', 1), false, 'stale round must not route acks')
})

/* ---- 10: config-store quarantine-failure write gate ---- */
test('d5-10: unreadable + unrenamable config → writeConfig skipped, no clobber', () => {
  const cfg = require_('../../../src/main/config-store.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-d5-cfg-'))
  cfg.__setConfigDir(dir)
  try {
    // config.json as a DIRECTORY (unreadable via readFileSync: EISDIR) and config.json.bad as a
    // non-empty directory (rename target exists → quarantine rename fails).
    fs.mkdirSync(path.join(dir, 'config.json'))
    fs.mkdirSync(path.join(dir, 'config.json.bad'))
    fs.writeFileSync(path.join(dir, 'config.json.bad', 'evidence.txt'), 'KEEP-ME')
    const c = cfg.readConfig()
    assert.deepEqual(Object.keys(c), ['shortcutKeySettings'], 'defaults returned, nothing clobbered')
    assert.equal(cfg.isReadFailed(), true, 'quarantine failure sets the read-failed gate')
    assert.equal(cfg.writeConfig({ locale: 'en' }), null, 'write is skipped while gated')
    assert.equal(fs.readFileSync(path.join(dir, 'config.json.bad', 'evidence.txt'), 'utf8'), 'KEEP-ME',
      'on-disk state preserved — no clobber')
    // recovery path: a subsequent SUCCESSFUL read clears the gate and writes resume
    fs.rmSync(path.join(dir, 'config.json'), { recursive: true, force: true })
    fs.rmSync(path.join(dir, 'config.json.bad'), { recursive: true, force: true })
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ locale: 'zh' }))
    assert.deepEqual(cfg.readConfig().locale, 'zh', 'recovery: the file reads again')
    assert.equal(cfg.isReadFailed(), false, 'a successful read clears the gate')
    cfg.writeConfig({ locale: 'en' })
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).locale, 'en')
  } finally {
    cfg.__setConfigDir(null)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/* ---- 11: bootstrap stopSync flushes the throttled security ring ---- */
test('d5-11: stopSync flushes pending security-ring entries before the node is torn down', async () => {
  const boot = require_('../../../src/main/lan-sync-bootstrap.js')
  const puts = []
  const fakeNode = {
    getStatus: () => ({ security: [{ ip: '10.0.0.9', kind: 'auth-rejected', at: 1 }, { ip: '10.0.0.8', kind: 'pair-throttled', at: 2 }] }),
    stop: async () => {},
  }
  boot.__test.setState({
    db: { call: (op, p) => { if (op === 'settingsRowPut') { puts.push(p); return true } if (op === 'settingsRowsAll') return []; return null } },
    node: fakeNode,
    engine: null,
    timers: [],
    peerWatermarks: { raw: () => ({}) },
    pendingPair: null,
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
  })
  await boot.__test.stopSync()
  const secPut = puts.find(p => p && p.key === 'sync.securityLog')
  assert.ok(secPut, 'security ring persisted synchronously on stop')
  const entries = JSON.parse(secPut.value)
  assert.equal(entries.length, 2)
  assert.equal(entries[1].kind, 'pair-throttled')
  assert.equal(fakeNode.getStatus, fakeNode.getStatus) // node object survived (not nulled before flush)
  boot.__test.setState(null)
})
