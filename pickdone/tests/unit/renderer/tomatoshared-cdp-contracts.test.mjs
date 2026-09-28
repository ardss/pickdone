/** Contract tests for the d11-wave under-covered pure modules:
 *  - renderer/js/utils/tomatoShared.js (the shared tomato countdown/format/dedupe trio —
 *    previously covered only INDIRECTLY through components, so refactors silently dropped
 *    its coverage below the ratchet baseline);
 *  - shared/sanitize-text.mjs (both exports incl. stripDangerous);
 *  - renderer/js/store/repeatSettings.js (mutations + LS write-through + blob adoption);
 *  - cli/lib-cdp-client.cjs (getJSON / cdpConnect against a minimal in-process WS server,
 *    plus the adopted-child zombie reaper).
 * Run: node --test tests/unit/renderer/tomatoshared-cdp-contracts.test.mjs */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import http from 'node:http'
import crypto from 'node:crypto'

import {
  remainSecOf, focusedElapsedSec, phaseToken, dedupeById, formatMMSS, mmToHHmm,
  secToHHmmss, isStaleTomatoCmd, expiredTomatoReceipt, TOMATO_CMD_TTL_MS,
} from '../../../renderer/js/utils/tomatoShared.js'
import { sanitizeText, stripDangerous } from '../../../shared/sanitize-text.mjs'
import repeatSettings from '../../../renderer/js/store/repeatSettings.js'
import { REPEAT_DEFAULTS } from '../../../renderer/js/utils/repeat.js'

const require = createRequire(import.meta.url)
const cdp = require('../../../cli/lib-cdp-client.cjs')

/* ---------- tomatoShared.js ---------- */

test('remainSecOf: null when not running or startedAt missing', () => {
  assert.equal(remainSecOf('default', Date.now(), 25, 5), null)
  assert.equal(remainSecOf('startRestTime', null, 25, 5), null)
  assert.equal(remainSecOf('startTomatoTime', undefined, 25, 5), null)
})

test('remainSecOf: focus countdown floors and clamps to 0', () => {
  const now = 1_000_000_000_000
  const startedAt = now - 60_000 // 1min elapsed of a 25min focus
  assert.equal(remainSecOf('startTomatoTime', startedAt, 25, 5, now), 24 * 60)
  // clock skew: startedAt in the future must not go negative-elapsed (clamp to 0 first)
  assert.equal(remainSecOf('startTomatoTime', now + 30_000, 25, 5, now), 25 * 60)
  // past the end: clamped to 0
  assert.equal(remainSecOf('startTomatoTime', now - 26 * 60_000, 25, 5, now), 0)
})

test('remainSecOf: rest countdown defaults to 5min when restTime missing', () => {
  const now = 1_000_000_000_000
  assert.equal(remainSecOf('startRestTime', now, null, null, now), 5 * 60)
  assert.equal(remainSecOf('startRestTime', now, 25, 10, now), 10 * 60)
})

test('focusedElapsedSec: null/absent startedAt → 0, floored elapsed, negative clamped', () => {
  const now = 1_000_000_000_000
  assert.equal(focusedElapsedSec(null, now), 0)
  assert.equal(focusedElapsedSec(undefined, now), 0)
  assert.equal(focusedElapsedSec(now - 90_500, now), 90)
  assert.equal(focusedElapsedSec(now + 5_000, now), 0)
})

test('phaseToken: identity is status:startedAt', () => {
  assert.equal(phaseToken('startTomatoTime', 123), 'startTomatoTime:123')
  assert.notEqual(phaseToken('startRestTime', 123), phaseToken('startTomatoTime', 123))
})

test('dedupeById: keeps first per tomatoId, keeps id-less rows, tolerates null list', () => {
  const a = { tomatoId: 't1', v: 1 }
  const b = { tomatoId: 't1', v: 2 }
  const c = { v: 3 }
  assert.deepEqual(dedupeById([a, b, c, null]), [a, c, null])
  assert.deepEqual(dedupeById(null), [])
  assert.deepEqual(dedupeById(undefined), [])
})

test('formatMMSS: floors, pads, clamps negatives to 0', () => {
  assert.equal(formatMMSS(0), '00:00')
  assert.equal(formatMMSS(65), '01:05')
  assert.equal(formatMMSS(61.9), '01:01')
  assert.equal(formatMMSS(-3), '00:00')
  assert.equal(formatMMSS(NaN), '00:00')
  assert.equal(formatMMSS(3600), '60:00')
})

test('mmToHHmm: rounds and clamps to 0..1439', () => {
  assert.equal(mmToHHmm(0), '00:00')
  assert.equal(mmToHHmm(90), '01:30')
  assert.equal(mmToHHmm(1439), '23:59')
  assert.equal(mmToHHmm(1500), '23:59')
  assert.equal(mmToHHmm(-5), '00:00')
  assert.equal(mmToHHmm('x'), '00:00')
  assert.equal(mmToHHmm(90.4), '01:30')
})

test('secToHHmmss: rounds, pads, clamps', () => {
  assert.equal(secToHHmmss(3661), '01:01:01')
  assert.equal(secToHHmmss(59), '00:00:59')
  assert.equal(secToHHmmss(-5), '00:00:00')
  assert.equal(secToHHmmss(3599.6), '01:00:00')
})

test('stale CLI tomato cmd + expired receipt contract', () => {
  assert.equal(TOMATO_CMD_TTL_MS, 60000)
  const now = 1_000_000_000_000
  assert.equal(isStaleTomatoCmd(null, now), true)
  assert.equal(isStaleTomatoCmd({}, now), true)
  assert.equal(isStaleTomatoCmd({ at: now - 1000 }, now), false)
  assert.equal(isStaleTomatoCmd({ at: now - TOMATO_CMD_TTL_MS - 1 }, now), true)
  assert.deepEqual(
    expiredTomatoReceipt({ seq: 7 }, now),
    { seq: 7, status: 'expired', error: 'stale command (>60s)', at: now })
  assert.deepEqual(
    expiredTomatoReceipt(null, now).seq, 0)
})

/* ---------- shared/sanitize-text.mjs ---------- */

test('sanitizeText: strips control/RTL/bidi chars, collapses whitespace, truncates', () => {
  assert.equal(sanitizeText(null), '')
  assert.equal(sanitizeText(undefined), '')
  assert.equal(sanitizeText('ab\u0000\u0007cd'), 'abcd')
  assert.equal(sanitizeText('a\u202eb\u2066c\u2069d'), 'abcd') // RLO + LRI/FSI/PDI
  assert.equal(sanitizeText('a\u200eb\uFEFFc'), 'abc') // LRM + BOM
  assert.equal(sanitizeText('a  b'), 'a b') // whitespace collapse
  assert.equal(sanitizeText('x\ty'), 'xy') // tab is a control char (U+0009): CONTROL_RE strips it before the tab branch
  assert.equal(sanitizeText('x'.repeat(6000)).length, 5000) // default cap
  assert.equal(sanitizeText('abcdef', 3), 'abc') // explicit cap
  assert.equal(stripDangerous('ok 1\u0002'), 'ok 1') // strips dangerous, keeps whitespace, no truncation
  assert.equal(stripDangerous(null), '')
  assert.equal(sanitizeText('keep   spacing'), 'keep spacing')
})

/* ---------- renderer/js/store/repeatSettings.js ---------- */

test('repeatSettings store: defaults seed, updateSettings writes LS + mirrors blob, updateFromBlob adopts', () => {
  const lsRef = globalThis.localStorage
  // fresh LS → state starts as REPEAT_DEFAULTS
  lsRef.removeItem('repeatSettingsV2State')
  // re-import not possible without a loader; emulate load() by checking the module's shape
  assert.equal(typeof repeatSettings.mutations.updateSettings, 'function')
  assert.equal(typeof repeatSettings.mutations.updateFromBlob, 'function')

  const state = { ...REPEAT_DEFAULTS }
  const mirrored = []
  const rootStore = { commit (m, p) { mirrored.push([m, p]) } }
  repeatSettings.mutations.updateSettings.call(rootStore, state, { workRest: 7 })
  assert.equal(state.workRest, 7)
  assert.deepEqual(JSON.parse(lsRef.getItem('repeatSettingsV2State')).workRest, 7)
  assert.deepEqual(mirrored, [['settings/updateSettings', { repeatDefaultSettings: { ...state } }]])

  // inbound blob adoption: object adopted + LS write-through, no re-commit
  mirrored.length = 0
  repeatSettings.mutations.updateFromBlob.call(rootStore, state, { workFocus: 30 })
  assert.equal(state.workFocus, 30)
  assert.deepEqual(JSON.parse(lsRef.getItem('repeatSettingsV2State')).workFocus, 30)
  assert.deepEqual(mirrored, [])

  // invalid blobs ignored
  const before = { ...state }
  repeatSettings.mutations.updateFromBlob.call(rootStore, state, null)
  repeatSettings.mutations.updateFromBlob.call(rootStore, state, [1, 2])
  repeatSettings.mutations.updateFromBlob.call(rootStore, state, 'x')
  assert.deepEqual(state, before)
})

/* ---------- cli/lib-cdp-client.cjs ---------- */

/** Minimal WebSocket server: completes the upgrade handshake and can send/receive text frames. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
function wsSendText (socket, text) {
  const payload = Buffer.from(text)
  const header = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff])
  socket.write(Buffer.concat([header, payload]))
}
function startWsServer ({ onMessage = () => {}, silent = false } = {}) {
  const sockets = new Set()
  const server = http.createServer(() => {})
  server.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + WS_GUID).digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
    sockets.add(socket)
    let buf = Buffer.alloc(0)
    socket.on('data', d => {
      buf = Buffer.concat([buf, d])
      // parse complete masked client frames
      while (buf.length >= 2) {
        let len = buf[1] & 0x7f
        let off = 2
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4 }
        if (buf.length < off + 4 + len) break
        const mask = buf.slice(off, off + 4)
        const payload = Buffer.from(buf.slice(off + 4, off + 4 + len))
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
        buf = buf.slice(off + 4 + len)
        let parsed = null
        try { parsed = JSON.parse(payload.toString()) } catch { /* ignore */ }
        if (parsed && !silent && parsed.id != null) {
          wsSendText(socket, JSON.stringify({ id: parsed.id, result: { result: { value: parsed.id * 10 } } }))
        }
        onMessage(parsed, socket)
      }
    })
    socket.on('error', () => {})
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      broadcast: text => { for (const s of sockets) wsSendText(s, text) },
      drop: () => { for (const s of sockets) s.destroy() },
      close: async () => { for (const s of sockets) s.destroy(); await new Promise(r => server.close(r)) },
    }))
  })
}

test('getJSON: parses JSON bodies and rejects non-JSON with a descriptive error', async () => {
  const good = http.createServer((req, res) => { res.end(JSON.stringify({ ok: 1, url: req.url })) })
  await new Promise(r => good.listen(0, '127.0.0.1', r))
  const gp = good.address().port
  assert.deepEqual(await cdp.getJSON(gp, '/json/list'), { ok: 1, url: '/json/list' })
  await new Promise(r => good.close(r))

  const bad = http.createServer((req, res) => { res.end('<html>stale service</html>') })
  await new Promise(r => bad.listen(0, '127.0.0.1', r))
  const bp = bad.address().port
  await assert.rejects(() => cdp.getJSON(bp, '/json'), e => /non-JSON response/.test(e.message) && /stale service/.test(e.message))
  await new Promise(r => bad.close(r))
})

test('sleep resolves', async () => {
  const t0 = Date.now()
  await cdp.sleep(30)
  assert.ok(Date.now() - t0 >= 25)
})

test('adopted-child zombie guard: killSpawnedChild no-ops on already-exited child', () => {
  cdp.adoptSpawnedChild({ pid: 4_000_000_000, exitCode: 1 }) // already exited → early return
  cdp.killSpawnedChild()
  cdp.adoptSpawnedChild(null)
  cdp.killSpawnedChild()
})

test('cdpConnect: send/evalJS round-trip, exception capture, silent-socket timeout, socket-death rejection', async () => {
  const captured = []
  const srv = await startWsServer({ onMessage: (parsed, socket) => {} })
  const client = cdp.cdpConnect(`ws://127.0.0.1:${srv.port}/cdp`, { exceptions: captured, truncLen: 50, timeoutMs: 5000 })
  await client.open
  // evalJS round-trip: server echoes id*10 for each call
  assert.equal(await client.evalJS('1+1'), 10) // first call → id 1 → 10
  // exception push from the page is captured and truncated
  srv.broadcast(JSON.stringify({ method: 'Runtime.exceptionThrown', params: { exceptionDetails: { exception: { description: 'boom: ' + 'x'.repeat(500) } } } }))
  await cdp.sleep(50)
  assert.equal(captured.length, 1)
  assert.ok(captured[0].startsWith('boom:'))
  assert.equal(captured[0].length, 50)
  // silent method: server never answers this id → per-call timeout rejects
  srv.broadcast(JSON.stringify({})) // no-op traffic
  const silentSrv = await startWsServer({ silent: true })
  const silent = cdp.cdpConnect(`ws://127.0.0.1:${silentSrv.port}/cdp`, { timeoutMs: 120 })
  await silent.open
  await assert.rejects(() => silent.send('Runtime.evaluate'), /timed out after 120ms/)
  // abrupt socket death rejects pending calls
  silentSrv.drop()
  await assert.rejects(() => silent.send('Runtime.evaluate'), /socket (closed|error|not open)/)
  await silentSrv.close()
  await srv.close()
})

test('cdpConnect: refused connection rejects open; send on non-open socket fails fast', async () => {
  const client = cdp.cdpConnect('ws://127.0.0.1:9/cdp', { timeoutMs: 2000 })
  await assert.rejects(() => client.open, /CDP connect (failed|timed out)/)
  await assert.rejects(() => client.send('Runtime.evaluate'), /socket not open/)
})
