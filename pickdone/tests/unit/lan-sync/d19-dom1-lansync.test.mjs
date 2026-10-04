/* D19-DOM1 LAN-sync regression batch (2026-10-02):
 *   1. server-role.js: a dead peer's socket (send false) aborts snapshot serving on the FIRST
 *      failed frame; no onSnapshotSync 'sent' report, busy flag released.
 *   2. transport.js: TOTAL pre-auth lifetime cap — an unauthenticated peer answering pings
 *      (traffic re-arms the 30s idle timer) is still destroyed after preAuthMaxLifeMs; an
 *      AUTHENTICATED socket clears the lifetime timer at hello-ack and survives it.
 *   3. att-transfer.js: quota precheck ordering — the dedup/quota gate runs BEFORE the tmp
 *      spool write (source anchor).
 *   4. client-round.js: a throw inside att.onMessage is terminal for the round (source anchor:
 *      catch -> finish(err), not a swallowed warn with attOpen stuck true).
 * Run: node --test tests/unit/lan-sync/d19-dom1-lansync.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createServerRoleHandler } = require('../../../src/main/lan-sync/server-role.js')
const transport = require('../../../src/main/lan-sync/transport.js')
const { deriveAuthCode } = require('../../../src/main/lan-sync/pairing.js')

/* ---------- 1. server-role dead-peer snapshot abort ---------- */

function stubDeps (extra = {}) {
  return {
    ingestSegment: () => ({ applied: 1, rejected: 0, fromSeq: null, toSeq: null }),
    buildSegments: () => [],
    buildSnapshotRows: () => [],
    getMaxSeq: () => 100,
    getOldestSeq: () => 10,
    serverSnapshotBusy: new Set(),
    serverPullAck: new Map(),
    maxSnapshotChunks: 512,
    snapshotSchemaVersion: 1,
    pushRecent: () => {},
    onSnapshotError: () => {},
    onSnapshotSync: () => {},
    onServerError: () => {},
    ...extra,
  }
}

const bigRow = () => ({ id: 'r' + Math.random(), blob: 'x'.repeat(600 * 1024) }) // ~1 row per 1MB chunk

test('snapshot serving aborts on the first failed frame and does NOT report success', () => {
  let sends = 0
  const failAfter = 2
  const socket = {}
  const sendVia = () => { sends += 1; return sends > failAfter ? false : true }
  let synced = null
  const busy = new Set()
  const handler = createServerRoleHandler(stubDeps({
    buildSnapshotRows: () => [bigRow(), bigRow(), bigRow(), bigRow()],
    serverSnapshotBusy: busy,
    onSnapshotSync: info => { synced = info },
  }))
  const peer = { deviceId: 'dead-peer' }
  handler(peer, { type: 'snapshot-request' }, socket, sendVia)
  // chunk1, chunk2 went out; chunk3's send returned false -> abort, NO snapshot-end trailer
  assert.equal(sends, failAfter + 1)
  assert.equal(synced, null, 'onSnapshotSync must NOT report a sent snapshot to a dead socket')
  assert.equal(busy.has(peer.deviceId), false, 'busy flag must be released on abort')
})

test('healthy socket still receives the full snapshot + trailer + success report', () => {
  const frames = []
  const socket = {}
  const sendVia = (s, m) => { frames.push(m); return true }
  let synced = null
  const handler = createServerRoleHandler(stubDeps({
    buildSnapshotRows: () => [bigRow(), bigRow()],
    onSnapshotSync: info => { synced = info },
  }))
  handler({ deviceId: 'ok-peer' }, { type: 'snapshot-request' }, socket, sendVia)
  assert.equal(frames[frames.length - 1].type, 'snapshot-end')
  assert.ok(synced && synced.direction === 'sent' && synced.rows === 2)
})

/* ---------- 2. transport total pre-auth lifetime cap ---------- */

function listen (em) {
  return new Promise(resolve => em.on('listening', p => resolve(p)))
}

test('unauthenticated keepalive peer is destroyed by the total lifetime cap despite live traffic', async () => {
  const SECRET = 's'.repeat(64)
  const em = transport.createLanServer({ port: 0, deviceId: 'srv', pairingSecret: SECRET, secretFor: () => null, preAuthMaxLifeMs: 300 })
  const port = await listen(em)
  // Keepalive peer: pings every 30ms — each inbound byte re-arms the 30s idle timer, but the
  // lifetime cap is a plain setTimeout from accept and must fire anyway.
  const sock = net.connect({ host: '127.0.0.1', port })
  sock.on('error', () => { /* server-side destroy surfaces as ECONNRESET: expected */ })
  const closed = new Promise(resolve => sock.on('close', resolve))
  const iv = setInterval(() => { try { sock.write(JSON.stringify({ type: 'ping' }) + '\n') } catch { /* dying */ } }, 30)
  const t0 = Date.now()
  await closed
  clearInterval(iv)
  const elapsed = Date.now() - t0
  assert.ok(elapsed >= 200 && elapsed < 5000, `keepalive socket closed after ${elapsed}ms (expected ~300ms, not immediately, not never)`)
  await em.close()
})

test('authenticated socket clears the lifetime cap and survives past it', async () => {
  const SECRET = 's'.repeat(64)
  const em = transport.createLanServer({ port: 0, deviceId: 'srv', pairingSecret: SECRET, secretFor: () => null, preAuthMaxLifeMs: 300 })
  const port = await listen(em)
  const client = transport.connect('127.0.0.1', port, { deviceId: 'cli', pairingSecret: SECRET, authCode: deriveAuthCode(SECRET, 'cli'), timeoutMs: 3000 })
  await new Promise((resolve, reject) => { client.once('ready', resolve); client.once('rejected', reject); client.once('error', reject) })
  let closedByCap = false
  client.once('close', () => { closedByCap = true })
  await new Promise(r => setTimeout(r, 700)) // well past preAuthMaxLifeMs=300
  assert.equal(closedByCap, false, 'authenticated socket must have cleared the pre-auth lifetime timer')
  await client.close()
  await em.close()
})

test('preAuthMaxLifeMs <= 0 disables the cap (legacy behavior)', async () => {
  const SECRET = 's'.repeat(64)
  const em = transport.createLanServer({ port: 0, deviceId: 'srv', pairingSecret: SECRET, secretFor: () => null, preAuthMaxLifeMs: 0 })
  const port = await listen(em)
  const sock = net.connect({ host: '127.0.0.1', port })
  sock.on('error', () => { /* ignored */ })
  let closed = false
  sock.on('close', () => { closed = true })
  const iv = setInterval(() => { try { sock.write(JSON.stringify({ type: 'ping' }) + '\n') } catch { /* dying */ } }, 30)
  await new Promise(r => setTimeout(r, 450)) // past the 300ms budget that killed the peer above
  clearInterval(iv)
  assert.equal(closed, false, 'disabled cap must not destroy a pre-auth keepalive socket')
  sock.destroy()
  await em.close()
})

/* ---------- 3. att-transfer quota precheck ordering (source anchor) ---------- */

test('att-transfer writeAtomic: quota precheck runs BEFORE the tmp spool write', () => {
  const src = fs.readFileSync(require.resolve('../../../src/main/lan-sync/att-transfer.js'), 'utf8')
  const pre = src.indexOf('assertWriteAllowed({ incomingBytes: buf.length')
  // D21 (2026-10-02): the spool moved to writeFileDurable (fsync before rename) — the ordering
  // anchor follows the new call site.
  const spool = src.indexOf('writeFileDurable(tmp, buf')
  assert.ok(pre > -1 && spool > -1, 'both sites present')
  assert.ok(pre < spool, 'assertWriteAllowed must appear before the durable spool write')
  // The dedup no-op check moved BEFORE the quota gate too (identical content stays quota-exempt).
  const dedup = src.indexOf('let same = false')
  assert.ok(dedup > -1 && dedup < pre, 'identical-content dedup check must precede the quota gate')
})

/* ---------- 4. client-round att-frame throw is terminal (source anchor) ---------- */

test('client-round: att.onMessage throw finishes the round with an error, attOpen not stuck true', () => {
  const src = fs.readFileSync(require.resolve('../../../src/main/lan-sync/client-round.js'), 'utf8')
  const branch = src.indexOf("att.handles(msg.type)")
  const seg = src.slice(branch, branch + 1600)
  assert.ok(/catch \(err\) \{[\s\S]*?finish\(err\)/.test(seg), 'att frame catch must call finish(err) (terminal)')
  assert.ok(!/attOpen = true; try \{ attOpen = att.onMessage\(msg\) \} catch \(err\) \{ try \{ require\('electron-log'\)\.warn\('\[LanSync\] att frame error:'/ .test(src), 'old swallow-in-place pattern must be gone')
})
