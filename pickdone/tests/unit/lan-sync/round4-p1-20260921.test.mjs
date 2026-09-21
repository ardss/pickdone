/* QC Round-4 P1 regression tests (2026-09-21, fix/round4-p1):
 *   F1  Pre-auth idle vs pair-confirm: a two-way-confirmed pairing decision answered between
 *       the 30s pre-auth idle budget and the 60s confirm window used to land on a socket the
 *       idle timer had already destroyed. pair-challenge must disarm the idle timer.
 *   F2  Settings mirror gate vs clock skew: cur.updatedAt can carry the PEER's clock (up to
 *       +10min future, SKEW_CLAMP_MS). The _savedAt gate compared it against LOCAL time, so a
 *       fresher local edit was dropped during the skew window (lost on restart). The gate must
 *       clamp the row stamp to local now before comparing.
 *   F3  roundsInFlight leak: a malformed port from a discovery announce used to throw
 *       RangeError synchronously inside the round's promise executor — before finish() existed
 *       — so the per-peer mutex never released and the peer was skipped forever. A bad dial
 *       target must fail the round and leave the peer dialable.
 *   (F4, stats timeline dedup ordering, lives in tests/unit/components/w5-stats-chartmodels.test.mjs)
 *
 * Run: node --test tests/unit/lan-sync/round4-p1-20260921.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createLanSyncNode } = require('../../../src/main/lan-sync/index.js')
const { createLanServer } = require('../../../src/main/lan-sync/transport.js')
const cipher = require('../../../src/main/lan-sync/cipher.js')
const syncSchema = require('../../../src/main/db-sync-schema.js')

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function listen (server) {
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  return server.port
}

/* ---------------- F1: pair-challenge disarms the pre-auth idle timer ---------------- */

test('F1: a pair decision answered AFTER the pre-auth idle budget still completes', async () => {
  const pairRequests = []
  let paired = null
  const srv = createLanServer({
    port: 0, host: '127.0.0.1', deviceId: 'dev-r4', pairingSecret: 's3cret', getHandler: () => {},
    preAuthIdleMs: 400, // test-tunable (prod default 30000 — the bug window was 30s vs 60s confirm)
    pairConfirmTimeoutMs: 5000,
    onPairRequest: (info) => pairRequests.push(info),
    onPaired: (info) => { paired = info },
  })
  const port = await listen(srv)

  const s = net.connect({ host: '127.0.0.1', port })
  const lines = []
  let buf = ''
  s.on('data', (d) => {
    buf += d.toString('utf8')
    let i
    while ((i = buf.indexOf('\n')) !== -1) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1) }
  })
  let closed = false
  s.on('close', () => { closed = true })
  await new Promise((resolve, reject) => { s.on('connect', resolve); s.on('error', reject) })

  const eph = cipher.createPairEphemeral()
  s.write(JSON.stringify({ type: 'pair-request', deviceId: 'client-r4', deviceName: 'R4 Client', nonce: cipher.randomToken(), pub: eph.pub }) + '\n')

  // The server answers pair-challenge (plaintext, pre-decision).
  const challenge = await new Promise((resolve, reject) => {
    const t0 = Date.now()
    const iv = setInterval(() => {
      const hit = lines.map(l => { try { return JSON.parse(l) } catch { return null } }).find(m => m && m.type === 'pair-challenge')
      if (hit) { clearInterval(iv); resolve(hit) } else if (Date.now() - t0 > 3000) { clearInterval(iv); reject(new Error('no pair-challenge')) }
    }, 20)
  })
  assert.ok(challenge.challenge, 'pair-challenge received')

  // Human "thinks" PAST the 30s-class pre-auth idle budget (scaled: 400ms) — before the fix the
  // idle timer destroyed the socket here and the eventual answer landed nowhere.
  await sleep(700)
  assert.equal(closed, false, 'socket must survive the idle budget while the pair decision is pending')
  assert.ok(s.writable, 'socket still writable mid-decision')

  // The human accepts — the server must honor it on the still-live socket.
  assert.equal(pairRequests.length, 1, 'exactly one pair-request surfaced to the decision UI')
  pairRequests[0].respond(true)
  const acceptArrived = await new Promise((resolve) => {
    const t0 = Date.now()
    const iv = setInterval(() => {
      const hit = lines.some(l => { try { const m = JSON.parse(l); return m.type === 'pair-accept' || cipher.isEncFrame(m) } catch { return false } })
      if (hit || closed || Date.now() - t0 > 3000) { clearInterval(iv); resolve(hit) }
    }, 20)
  })
  assert.equal(acceptArrived, true, 'pair-accept (encrypted) sent after the late decision')
  assert.ok(paired, 'onPaired fired — pairing completed despite the late answer')
  s.destroy()
  await sleep(50)
  srv.close()
})

/* ---------------- F2: mirror gate clamps skewed row stamps to local time ---------------- */

test('F2: a local edit is not gated away by a row stamped into the future (peer clock skew)', () => {
  // In-memory settings_rows/meta stand-in (same prepared-statement surface db-sync-schema uses).
  const rows = new Map() // key -> { key, value, updatedAt, deleted, deletedAt }
  const meta = new Map()
  const fakeDb = {
    prepare (sql) {
      if (sql.startsWith('SELECT value, deleted, updatedAt FROM settings_rows')) {
        return { get: key => rows.has(key) ? { ...rows.get(key) } : undefined }
      }
      if (sql.startsWith('SELECT key, value, updatedAt')) {
        return { all: () => [...rows.values()].filter(r => !r.deleted) }
      }
      if (sql.startsWith('INSERT INTO settings_rows')) {
        return { run: (key, value, updatedAt) => {
          rows.set(key, { key, value, updatedAt, deleted: 0, deletedAt: 0 })
          return { changes: 1 }
        } }
      }
      if (sql.startsWith('INSERT INTO meta')) {
        return { run: (key, value) => { meta.set(key, value); return { changes: 1 } } }
      }
      throw new Error('unexpected sql: ' + sql)
    },
    transaction (fn) { return (...a) => fn(...a) },
  }
  const api = syncSchema({ getDb: () => fakeDb, log: { warn () {}, error () {} } })
  const OPS = { setMeta: (k, v) => meta.set(Array.isArray(k) ? k[0] : k, Array.isArray(k) ? k[1] : v) }
  api.registerOps(OPS, new Set(), { appendOplog () {} })

  // A peer whose clock runs +5min ahead synced in a row: SKEW_CLAMP_MS (10min) lets the row
  // keep its future stamp. (Direct row-table seed — mirrors the applied-sync state.)
  const future = Date.now() + 5 * 60 * 1000
  rows.set('theme', { key: 'theme', value: JSON.stringify('dark'), updatedAt: future, deleted: 0, deletedAt: 0 })

  // NOW the local user edits the same field; the renderer's whole-blob mirror fires with a
  // fresh _savedAt. The pre-fix gate compared the FUTURE row stamp against _savedAt and
  // silently dropped the local edit — lost on restart.
  OPS.setMeta(['db.settingsState', JSON.stringify({ theme: 'light', _savedAt: Date.now() })])
  const row = rows.get('theme')
  assert.equal(row.value, JSON.stringify('light'), 'the fresh local edit must land despite the skewed row stamp')
  assert.ok(row.updatedAt <= Date.now(), 'and is re-stamped with LOCAL time, not the future stamp')

  // The Round-3 guard still holds: a genuinely STALE blob (_savedAt predating the row) must
  // not revert the row.
  OPS.setMeta(['db.settingsState', JSON.stringify({ theme: 'dark', _savedAt: Date.now() - 60 * 1000 })])
  assert.equal(rows.get('theme').value, JSON.stringify('light'), 'stale whole-blob echo still loses (Round-3 guard intact)')
})

/* ---------------- F3: malformed dial target fails the round without leaking the mutex ---------------- */

test('F3: a peer with a malformed port fails its round and stays dialable afterwards', async () => {
  let dials = 0
  const fakePeer = createLanServer({
    port: 0, host: '127.0.0.1', deviceId: 'peer-r4f3', pairingSecret: 's3cret',
    onPeer: () => { dials += 1 },
    getHandler: () => (msg, socket) => {
      if (msg.type === 'segments-chunk') socket._lanSend({ type: 'ack', applied: msg.segments.length, rejected: 0 })
    },
  })
  const goodPort = await listen(fakePeer)

  const errors = []
  const node = createLanSyncNode({
    deviceId: 'self-r4f3', pairingSecret: 's3cret', port: 0, host: '127.0.0.1',
    discoverFn: { startAdvertising () {}, discover () {}, stop () {}, getPeers: () => [] },
    ingestSegment: () => ({ applied: 0 }),
    ingestSnapshot: () => {},
    buildSegments: () => [{ fromSeq: 1, toSeq: 1, deviceId: 'self-r4f3', rows: [{ id: 'x1', seq: 1 }] }],
  })
  node.on('round-error', (e) => errors.push(e))

  // Malformed announce: port 99999 is out of the TCP range — net.createConnection used to
  // throw RangeError synchronously inside the round executor, leaking the per-peer mutex.
  node.addPeer({ deviceId: 'peer-r4f3', host: '127.0.0.1', port: 99999 })
  const r1 = await node.startSyncRound()
  assert.equal(r1.confirmed, 0, 'the malformed round fails (nothing confirmed)')
  assert.equal(errors.length, 1, 'one round-error surfaced for the bad dial target')
  assert.match(String(errors[0].error && errors[0].error.message || ''), /port/i, 'the error names the invalid port')

  // The mutex must NOT be leaked: correcting the entry lets the very next round dial.
  node.addPeer({ deviceId: 'peer-r4f3', host: '127.0.0.1', port: goodPort })
  const r2 = await node.startSyncRound()
  assert.equal(dials, 1, 'the peer was dialed after the fix — the mutex was released')
  assert.equal(r2.allConfirmed, true, 'and the corrected round completes')
  await node.stop()
  fakePeer.close()
})
