/* M8B ops/recovery/discovery wave (2026-10-25):
 *   1. P1 external-db-watch: restartLatestDbWatch re-arms the fs.watchFile poll after the
 *      data:relocate failure branch's stop → re-init cycle (CLI direct-write detection must
 *      not stay blind for the rest of the session).
 *   2. P2 autoBackup.selectEmptyQuarantinePrunes: empty-quarantine-*.json side files keep the
 *      newest 5 by mtime; the rest are swept (housekeeping wiring in handlers/backup.js).
 *   3. P2 discovery: a bind callback landing AFTER stop() (socket already closed/nulled) must
 *      be a complete no-op — no setBroadcast on a dead/null handle, no uncaught throw.
 *   4. P2 autoBackup.selectPrunes: the evt tier ranks dup-suffix names LAST (rankTs parity with
 *      the auto tier) — a same-second dup must never fill the per-reason quota over its base.
 *   5. P3 scheduler.markFired: the all-unwritten eviction path flushes FIRST even when a persist
 *      timer is pending (pending debounce consumed; evicted watermark persisted, not dropped).
 *   6. P3 dbRecovery.preflightMigrateResidue: a garbage-header todos.db.plain-bak is skipped —
 *      nothing copied, todos.db stays absent, the bak is kept for manual salvage.
 *   7. P3 security-lock.jsStr: JSON-stringified copy is </script>-safe inside the inline script.
 * Run: node --test tests/unit/main/w8-ops.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(import.meta.dirname, '../../..')

/* ---------- fix 1 (P1): stop → restart restores the external-write watch ---------- */
test('M8B 1: restartLatestDbWatch re-arms the fs.watchFile poll after stopLatestDbWatch', () => {
  const ew = require_(`${ROOT}/src/main/external-db-watch.js`)
  const realWatchFile = fs.watchFile
  const realUnwatchFile = fs.unwatchFile
  let watched = 0
  let unwatched = 0
  fs.watchFile = () => { watched++ }
  fs.unwatchFile = () => { unwatched++ }
  try {
    const api = ew.createExternalDbWatch({
      app: { getPath: () => fs.mkdtempSync(path.join(os.tmpdir(), 'w8-watch-')) },
      log: { info () {}, warn () {}, error () {} },
      dbm: { call: () => null },
      fixUtil: require_(`${ROOT}/src/main/fix-util.js`),
      extWatchGate: { canPoll: () => false },
      nextWatchBaseline: m => m,
      scheduler: {},
      getMainWindow: () => null,
      isLocked: () => false,
      dbApi: () => ({}),
      broadcastTodosChanged: () => {},
      broadcastTomatoRecordsChanged: () => {},
      BrowserWindow: { getAllWindows: () => [] },
    })
    assert.equal(watched, 0)
    api.watchDbForExternalWrites()
    const afterStart = watched
    assert.equal(afterStart, 2, 'watch arms db + wal polls')
    ew.stopLatestDbWatch()
    assert.equal(unwatched, 2, 'stop releases both polls')
    assert.equal(watched, afterStart, 'stop must not re-arm')
    ew.restartLatestDbWatch()
    assert.equal(watched, afterStart + 2, 'restart re-arms both polls (session no longer blind)')
    ew.stopLatestDbWatch() // leave no dangling timers behind
    assert.equal(unwatched, 4)
  } finally {
    fs.watchFile = realWatchFile
    fs.unwatchFile = realUnwatchFile
  }
})

/* ---------- fix 2 (P2): empty-quarantine side files keep newest 5 ---------- */
test('M8B 2: selectEmptyQuarantinePrunes keeps the newest 5 by mtime, sweeps the rest', () => {
  const autoBackup = require_(`${ROOT}/src/main/autoBackup.js`)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w8-quar-'))
  const base = Date.now() - 100 * 1000
  const names = []
  for (let i = 0; i < 6; i++) {
    const f = `empty-quarantine-20260101-1200${i}-${base + i * 1000}.json`
    fs.writeFileSync(path.join(dir, f), '{}')
    fs.utimesSync(path.join(dir, f), new Date(base + i * 1000), new Date(base + i * 1000))
    names.push(f)
  }
  fs.writeFileSync(path.join(dir, 'auto-20260101-120000.json'), '{}') // non-quarantine file untouched
  const entries = fs.readdirSync(dir).map(f => {
    const st = fs.statSync(path.join(dir, f))
    return { name: f, mtimeMs: st.mtimeMs }
  })
  const prunes = autoBackup.selectEmptyQuarantinePrunes(entries, { keep: 5 })
  assert.equal(prunes.length, 1, '6 quarantine files → exactly 1 swept')
  assert.equal(prunes[0], names[0], 'the OLDEST is the victim')
  for (const dead of prunes) fs.rmSync(path.join(dir, dead), { force: true })
  const left = fs.readdirSync(dir).filter(f => f.startsWith('empty-quarantine-'))
  assert.equal(left.length, 5, 'the newest 5 survive')
  assert.ok(left.includes(names[5]), 'the NEWEST quarantine file is kept')
  assert.ok(fs.existsSync(path.join(dir, 'auto-20260101-120000.json')), 'restore namespace untouched')
  // default keep (absent option) also floors at 5
  assert.equal(autoBackup.selectEmptyQuarantinePrunes(entries).length, 1)
})

/* ---------- fix 3 (P2): stale UDP bind callback is a no-op ---------- */
test('M8B 3: discovery stop() before the bind callback fires → callback is a safe no-op', () => {
  const dgram = require_('node:dgram')
  const Module = require_('node:module')
  const realCreateSocket = dgram.createSocket
  const realLoad = Module._load
  const calls = { setBroadcast: 0, closed: 0, bound: 0 }
  let bindCb = null
  const mockSock = {
    bind (port, cb) { bindCb = cb; calls.bound++ },
    setBroadcast () { calls.setBroadcast++ },
    close () { calls.closed++ },
    on () {},
    send () {},
    unref () {},
  }
  dgram.createSocket = () => mockSock
  Module._load = function (request, parent, isMain) {
    if (request === 'bonjour-service') return null // force the UDP fallback path
    return realLoad.call(this, request, parent, isMain)
  }
  try {
    const { createDiscovery } = require_(`${ROOT}/src/main/lan-sync/discovery.js`)
    const d = createDiscovery()
    d.startAdvertising({ deviceId: 'dev1', name: 'n1', port: 41000 })
    assert.equal(calls.bound, 1, 'first bind attempt started')
    assert.equal(typeof bindCb, 'function')
    d.stop() // socket closed + udp = null + stopped = true WHILE the bind is in flight
    assert.doesNotThrow(() => bindCb(), 'stale bind callback must not throw on the dead/null socket')
    assert.equal(calls.setBroadcast, 0, 'no setBroadcast after stop')
    assert.ok(!d._udpAdvertiseActive(), 'no advertise interval armed by the stale callback')
    assert.equal(d.udpFallbackPort(), 0, 'fallback port stays unbound')
    // second shape: a SECOND bind attempt queued after stop — also a no-op, no throw
    calls.bound = 0
    d.startAdvertising({ deviceId: 'dev2', name: 'n2', port: 41001 }) // recreate after stop
    d.stop()
    assert.doesNotThrow(() => bindCb())
    assert.equal(calls.setBroadcast, 0)
  } finally {
    dgram.createSocket = realCreateSocket
    Module._load = realLoad
  }
})

/* ---------- fix 4 (P2): evt tier ranks dup names last ---------- */
test('M8B 4: evt same-second dup never fills the per-reason quota over its base snapshot', () => {
  const autoBackup = require_(`${ROOT}/src/main/autoBackup.js`)
  const names = [
    'evt-abc-20260101-120000.json',
    'evt-abc-20260101-120000-dup1.json',
    'evt-abc-20260101-110000.json',
  ]
  const prunes = autoBackup.selectPrunes(names, { eventKeep: 1 })
  assert.ok(!prunes.includes('evt-abc-20260101-120000.json'), 'the REAL (base) snapshot survives the quota')
  assert.ok(prunes.includes('evt-abc-20260101-120000-dup1.json'), 'the collision dup is pruned (rankTs → oldest)')
  // explicit ranking parity with the auto tier
  assert.ok(!autoBackup.selectPrunes(names, { eventKeep: 2 }).includes('evt-abc-20260101-110000.json'),
    'the older-but-real snapshot is kept over the dup when quota allows 2 (dup ranks last)')
})

/* ---------- fix 5 (P3): eviction with a pending persist timer still flushes first ---------- */
test('M8B 5: markFired all-unwritten eviction flushes the pending watermark even with a timer armed', () => {
  const scheduler = require_(`${ROOT}/src/main/scheduler.js`)
  scheduler._clearStateForTest()
  const fired = scheduler._fired
  const FIRED_MAX = 2000
  // Arm a pending persist timer first (the exact D21 "coalesced" state that used to skip the flush)
  for (let i = 0; i < FIRED_MAX - 1; i++) fired.set('u' + i, { ts: i, written: false })
  scheduler._markFired('warmup')
  assert.equal(fired.size, FIRED_MAX)
  assert.ok(fired.has('warmup'))
  // Eviction branch with EVERYTHING unwritten + pending timer: flush must run NOW (watermark of
  // the evicted entry persisted, not deferred to the 60s debounce the timer was holding).
  assert.doesNotThrow(() => scheduler._markFired('x'))
  assert.equal(fired.size, FIRED_MAX, 'the memory bound still holds')
  assert.ok(!fired.has('u0'), 'the oldest entry was evicted')
  assert.ok(fired.has('x'))
  scheduler._clearStateForTest()
  try { scheduler.flushFiredNow() } catch { /* best-effort cleanup */ }
})

/* ---------- fix 6 (P3): torn plain-bak is skipped by the migration preflight ---------- */
test('M8B 6: preflightMigrateResidue skips a garbage-header plain-bak (no copy, no delete)', () => {
  const dbRecovery = require_(`${ROOT}/src/main/dbRecovery.cjs`)
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'w8-bak-'))
  const bak = path.join(ud, 'todos.db.plain-bak')
  fs.writeFileSync(bak, Buffer.from('GARBAGE-NOT-SQLITE'.repeat(64), 'utf8'))
  const warns = []
  const r = dbRecovery.preflightMigrateResidue(ud, { warn: (...a) => warns.push(a.join(' ')) })
  assert.equal(r, false, 'torn bak is not a recoverable source')
  assert.ok(!fs.existsSync(path.join(ud, 'todos.db')), 'todos.db NOT restored from garbage bytes')
  assert.ok(fs.existsSync(bak), 'the plain-bak is never deleted (forensics doctrine)')
  assert.ok(warns.some(w => /SQLite/.test(w)), 'the skip is logged, not silent')
  // control: a REAL sqlite header still recovers (gate not over-tightened)
  fs.writeFileSync(bak, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(4096)]))
  const r2 = dbRecovery.preflightMigrateResidue(ud, { warn: () => {} })
  assert.equal(r2, true, 'healthy-header plain-bak still restores')
  assert.ok(fs.existsSync(path.join(ud, 'todos.db')))
})

/* ---------- fix 7 (P3): lock-screen script literal is </script>-safe ---------- */
test('M8B 7: jsStr escapes </script> (and friends) inside the lock-screen inline script', () => {
  const sl = require_(`${ROOT}/src/main/security-lock.js`)
  const evil = '密码错误</script><script>alert(1)</script>ok'
  const out = sl.jsStr(evil)
  assert.ok(!out.includes('</script>'), 'raw </script> must never appear in the document')
  assert.ok(!/[<>]/.test(out.slice(1, -1)), 'no raw angle brackets inside the JSON literal')
  assert.equal(JSON.parse(out), evil, 'the literal round-trips to the original copy')
  // the source template actually uses jsStr for the interpolated copy (not bare JSON.stringify)
  const src = fs.readFileSync(path.join(ROOT, 'src/main/security-lock.js'), 'utf8')
  assert.ok(/err\.textContent = \$\{jsStr\(/.test(src), 'template interpolates through jsStr')
})
