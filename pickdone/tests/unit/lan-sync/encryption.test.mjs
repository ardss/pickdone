/**
 * Transport-encryption regression tests (2026-09-18): post-auth sync traffic is AES-256-GCM
 * encrypted (cipher.js), session key = HKDF-SHA256(pairingSecret, per-connection salt from
 * `hello`). Real TCP loopback + REAL crypto — nothing here stubs the cipher.
 *
 * Covered:
 *   1. pairing (two-way, through a byte-sniffing proxy) + full sync rounds over encrypted
 *      transport; task rows are never plaintext on the wire
 *   2. tampered GCM tag -> connection severed, message never delivered
 *   3. plaintext data message where encryption is expected -> connection closed (both directions)
 *   4. session key derived from a wrong secret cannot decrypt -> severed
 *   5. line caps still enforced on the encrypted framing (oversize encrypted line severed)
 *   6. the pair-accept `secret` is never plaintext on the wire (raw bytes sniffed)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createLanServer, connect, MAX_LINE_BYTES } = require('../../../src/main/lan-sync/transport.js')
const { createLanSyncNode } = require('../../../src/main/lan-sync/index.js')
const { deriveAuthCode } = require('../../../src/main/lan-sync/pairing.js')
const cipher = require('../../../src/main/lan-sync/cipher.js')

const SECRET = 'encryption-secret-alpha'
const SERVER_DEVICE = 'enc-server'
const CLIENT_DEVICE = 'enc-client'

async function listen(server) {
  await new Promise((resolve) => server.on('listening', resolve))
  return server.port
}

/** Byte-sniffing TCP proxy: forwards 127.0.0.1:port -> 127.0.0.1:targetPort and records
 *  EVERY raw byte in both directions (for plaintext-on-the-wire assertions). */
function sniffProxy(targetPort) {
  const chunks = []
  const server = net.createServer((c) => {
    const up = net.connect({ host: '127.0.0.1', port: targetPort })
    c.on('data', (d) => chunks.push(Buffer.from(d)))
    up.on('data', (d) => chunks.push(Buffer.from(d)))
    c.pipe(up)
    up.pipe(c)
    const kill = () => {
      try { c.destroy() } catch { /* noop */ }
      try { up.destroy() } catch { /* noop */ }
    }
    c.on('error', kill)
    up.on('error', kill)
    c.on('close', kill)
    up.on('close', kill)
  })
  return {
    server,
    port: null,
    text: () => Buffer.concat(chunks).toString('latin1'),
    listen() {
      if (this.port !== null) return Promise.resolve(this.port)
      return new Promise((resolve, reject) => {
        this.server.once('listening', () => { this.port = this.server.address().port; resolve(this.port) })
        this.server.once('error', reject)
        this.server.listen(0, '127.0.0.1')
      })
    },
    async close() { await new Promise((r) => server.close(r)) },
  }
}

/** Raw-socket peer for adversarial framing tests: manual hello handshake + line reading. */
async function openRaw(port, authCode, { salt = cipher.randomToken(), deviceId = CLIENT_DEVICE, enc = 1 } = {}) {
  const sock = net.createConnection({ host: '127.0.0.1', port })
  await new Promise((resolve, reject) => { sock.once('connect', resolve); sock.once('error', reject) })
  const lines = []
  let wakeup = null
  let buf = ''
  sock.setEncoding('utf8')
  sock.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      lines.push(buf.slice(0, i))
      buf = buf.slice(i + 1)
    }
    if (wakeup) { const w = wakeup; wakeup = null; w() }
  })
  const nextLine = (timeoutMs = 4000) => new Promise((resolve) => {
    if (lines.length) return resolve(lines.shift())
    wakeup = () => resolve(lines.length ? lines.shift() : null)
    setTimeout(() => { if (wakeup === null) return; wakeup = null; resolve(null) }, timeoutMs).unref?.()
  })
  sock.write(JSON.stringify({ type: 'hello', deviceId, protoVer: 2, authCode, enc, salt }) + '\n')
  const ackLine = await nextLine()
  let ack = null
  try { ack = JSON.parse(ackLine) } catch { /* leave null */ }
  const closed = new Promise((resolve) => sock.once('close', resolve))
  return { sock, salt, ack, nextLine, closed, write: (s) => sock.write(s) }
}

test('encryption: two-way pairing through a sniffing proxy, then full sync rounds — rows never plaintext on the wire', async () => {
  const ROW_TEXT = 'secret-task-content-zebra'
  const serverNode = createLanSyncNode({
    deviceId: SERVER_DEVICE, name: 'EncS', pairingSecret: SECRET, port: 0, host: '127.0.0.1',
    discoverFn: { startAdvertising() {}, discover() {}, stop() {}, getPeers: () => [] },
    ingestSegment: () => ({ applied: 0, rejected: 0 }),
    ingestSnapshot: () => {},
    buildSegments: () => [{ fromSeq: 1, toSeq: 1, deviceId: SERVER_DEVICE, rows: [{ entity: 'todo', id: 's1', updatedAt: 1, deleted: false, deletedAt: 0, data: { taskId: 's1', taskContent: ROW_TEXT } }] }],
  })
  serverNode.on('pair-request', (info) => info.respond(true))
  serverNode.start()
  const realPort = await serverNode.whenListening()

  const proxy = sniffProxy(realPort)
  const sniffPort = await proxy.listen()
  try {
    // Pair THROUGH the proxy (as a real attacker-visible session would run).
    const pairClient = createLanSyncNode({
      deviceId: CLIENT_DEVICE, name: 'EncC', pairingSecret: 'unpaired-placeholder', port: 0, host: '127.0.0.1',
      discoverFn: { startAdvertising() {}, discover() {}, stop() {}, getPeers: () => [] },
      ingestSegment: () => {}, ingestSnapshot: () => {}, buildSegments: () => [],
    })
    const { secret } = await pairClient.requestPair('127.0.0.1', sniffPort)
    assert.equal(secret, SECRET, 'pair-accept delivered the secret (decrypted client-side)')
    // (6) the raw wire between pair-request and pair-accept must NOT contain the secret.
    assert.ok(!proxy.text().includes(SECRET), 'pairing secret must never appear in sniffed bytes')

    // Full sync rounds with the adopted secret, still through the proxy.
    const clientNode = createLanSyncNode({
      deviceId: CLIENT_DEVICE, name: 'EncC', pairingSecret: secret, port: 0, host: '127.0.0.1',
      discoverFn: { startAdvertising() {}, discover() {}, stop() {}, getPeers: () => [] },
      ingestSegment: (seg) => ({ applied: seg.rows ? seg.rows.length : 0, rejected: 0 }),
      ingestSnapshot: () => {},
      buildSegments: () => [],
    })
    clientNode.start()
    await clientNode.whenListening()
    clientNode.addPeer({ deviceId: SERVER_DEVICE, host: '127.0.0.1', port: sniffPort })
    const r = await clientNode.startSyncRound()
    assert.equal(r.confirmed, 1, 'round completed over the encrypted transport')

    // The pulled row must have been delivered (segments reached the server handler side is
    // push; the pull is what carries ROW_TEXT) — verify via the proxy that the wire is opaque.
    const wire = proxy.text()
    assert.ok(wire.length > 0, 'proxy actually observed bytes')
    assert.ok(!wire.includes(ROW_TEXT), 'sync payload must not appear plaintext on the wire')
    assert.ok(!wire.includes('"type":"segments"'), 'even the message envelope must be inside the ciphertext')

    await clientNode.stop()
    await pairClient.stop()
  } finally {
    await proxy.close()
    await serverNode.stop()
  }
})

test('encryption: tampered GCM tag severs the connection and the message is never delivered', async () => {
  const handled = []
  const server = createLanServer({
    port: 0, host: '127.0.0.1', deviceId: SERVER_DEVICE, pairingSecret: SECRET,
    getHandler: () => (msg) => handled.push(msg),
  })
  const port = await listen(server)
  try {
    const raw = await openRaw(port, deriveAuthCode(SECRET, CLIENT_DEVICE))
    assert.equal(raw.ack && raw.ack.ok, true, 'handshake ok')
    const key = cipher.deriveSessionKey(SECRET, raw.salt)
    const frame = JSON.parse(cipher.encryptFrame(key, { type: 'segments', segments: [{ evil: true }] }))
    // Flip one character of the auth tag: GCM verification must fail server-side.
    const flipped = frame.tag[0] === 'A' ? 'B' : 'A'
    frame.tag = flipped + frame.tag.slice(1)
    raw.write(JSON.stringify(frame) + '\n')
    await raw.closed // connection dropped
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(handled.length, 0, 'tampered frame never reaches the handler')
  } finally {
    await server.close()
  }
})

test('encryption: plaintext data message where encryption is expected closes the connection', async () => {
  // client -> server direction
  const handled = []
  const server = createLanServer({
    port: 0, host: '127.0.0.1', deviceId: SERVER_DEVICE, pairingSecret: SECRET,
    getHandler: () => (msg) => handled.push(msg),
  })
  const port = await listen(server)
  try {
    const raw = await openRaw(port, deriveAuthCode(SECRET, CLIENT_DEVICE))
    assert.equal(raw.ack && raw.ack.ok, true)
    raw.write(JSON.stringify({ type: 'segments', segments: [{ plaintext: true }] }) + '\n')
    await raw.closed
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(handled.length, 0, 'plaintext post-auth message refused')
  } finally {
    await server.close()
  }

  // server -> client direction: a handler replying with a raw plaintext write must get the
  // client to hang up instead of parsing the message.
  const server2 = createLanServer({
    port: 0, host: '127.0.0.1', deviceId: SERVER_DEVICE, pairingSecret: SECRET,
    getHandler: () => (msg, socket) => {
      if (msg.type === 'segments') socket.write(JSON.stringify({ type: 'ack', applied: 1, rejected: 0 }) + '\n')
    },
  })
  const port2 = await listen(server2)
  try {
    const client = connect('127.0.0.1', port2, {
      deviceId: CLIENT_DEVICE, authCode: deriveAuthCode(SECRET, CLIENT_DEVICE), pairingSecret: SECRET,
    })
    await new Promise((resolve) => client.on('ready', resolve))
    const msgs = []
    client.on('message', (m) => msgs.push(m))
    client.send({ type: 'segments', segments: [{ fromSeq: 1, toSeq: 1, deviceId: CLIENT_DEVICE, rows: [] }] })
    await new Promise((resolve) => client.on('close', resolve))
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(msgs.length, 0, 'plaintext server reply is not parsed as a message')
    await client.close()
  } finally {
    await server2.close()
  }
})

test('encryption: session key derived from a wrong secret cannot decrypt — connection severed', async () => {
  const handled = []
  const server = createLanServer({
    port: 0, host: '127.0.0.1', deviceId: SERVER_DEVICE, pairingSecret: SECRET,
    getHandler: () => (msg) => handled.push(msg),
  })
  const port = await listen(server)
  try {
    // Handshake passes (valid authCode), but the peer derives its session key from the WRONG
    // secret (e.g. rotated/derivation mismatch). Its first encrypted frame must fail the GCM
    // tag check server-side and drop the connection.
    const raw = await openRaw(port, deriveAuthCode(SECRET, CLIENT_DEVICE))
    assert.equal(raw.ack && raw.ack.ok, true)
    const wrongKey = cipher.deriveSessionKey('a-totally-different-secret', raw.salt)
    raw.write(cipher.encryptFrame(wrongKey, { type: 'segments', segments: [{ x: 1 }] }) + '\n')
    await raw.closed
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(handled.length, 0, 'wrong-key frame never reaches the handler')
  } finally {
    await server.close()
  }
})

test('encryption: line caps still enforced on the encrypted framing (oversize encrypted line severed)', async () => {
  const handled = []
  let serverSawError = null
  const server = createLanServer({
    port: 0, host: '127.0.0.1', deviceId: SERVER_DEVICE, pairingSecret: SECRET,
    getHandler: () => (msg) => handled.push(msg),
  })
  server.on('error', (e) => { serverSawError = e })
  const port = await listen(server)
  try {
    const raw = await openRaw(port, deriveAuthCode(SECRET, CLIENT_DEVICE))
    assert.equal(raw.ack && raw.ack.ok, true)
    const key = cipher.deriveSessionKey(SECRET, raw.salt)
    // Legitimately encrypted frame (right key, intact tag) but the resulting WIRE line
    // exceeds MAX_LINE_BYTES: the cap must sever the connection regardless of validity.
    const frame = cipher.encryptFrame(key, { type: 'segments', pad: 'x'.repeat(25 * 1024 * 1024) })
    assert.ok(Buffer.byteLength(frame, 'utf8') > MAX_LINE_BYTES)
    raw.write(frame + '\n')
    await raw.closed
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(handled.length, 0, 'oversize encrypted line never reaches the handler')
    assert.equal(serverSawError, null, 'cap kill is not a server crash')
  } finally {
    await server.close()
  }
})

test('encryption: pair-accept secret is NOT plaintext on the wire (manual 6-digit mode)', async () => {
  const CODE = '654321'
  const server = createLanServer({
    port: 0, host: '127.0.0.1', deviceId: SERVER_DEVICE, pairingSecret: SECRET,
    verifyPairingCode: (c) => c === CODE,
  })
  const proxy = sniffProxy(await listen(server))
  const sniffPort = await proxy.listen()
  try {
    const client = connect('127.0.0.1', sniffPort, { deviceId: CLIENT_DEVICE, pairCode: CODE, timeoutMs: 3000 })
    const paired = await new Promise((resolve, reject) => {
      client.on('paired', resolve)
      client.on('rejected', reject)
      client.on('error', reject)
    })
    assert.equal(paired.secret, SECRET, 'client decrypted the secret')
    const wire = proxy.text()
    assert.ok(wire.includes('"pair-request"'), 'proxy observed the pairing exchange')
    assert.ok(!wire.includes(SECRET), 'secret never in plaintext between pair-request and pair-accept')
    client.close()
  } finally {
    await proxy.close()
    await server.close()
  }
})

test('encryption: pre-auth encrypted frames (no session key) and plaintext peers are refused', async () => {
  // (a) an encrypted frame arriving before any session key exists -> severed
  const server = createLanServer({
    port: 0, host: '127.0.0.1', deviceId: SERVER_DEVICE, pairingSecret: SECRET,
    getHandler: () => (msg) => { throw new Error('handler must never run') },
  })
  const port = await listen(server)
  try {
    const sock = net.createConnection({ host: '127.0.0.1', port })
    await new Promise((resolve, reject) => { sock.once('connect', resolve); sock.once('error', reject) })
    const closed = new Promise((resolve) => sock.once('close', resolve))
    sock.write(cipher.encryptFrame(cipher.deriveSessionKey(SECRET, cipher.randomToken()), { type: 'segments' }) + '\n')
    await closed
  } finally {
    await server.close()
  }

  // (b) a peer that does not advertise enc support is refused with a clear reason
  // (both sides ship together — no plaintext fallback).
  const server2 = createLanServer({
    port: 0, host: '127.0.0.1', deviceId: SERVER_DEVICE, pairingSecret: SECRET,
    getHandler: () => (msg) => { throw new Error('handler must never run') },
  })
  const port2 = await listen(server2)
  try {
    const raw = await openRaw(port2, deriveAuthCode(SECRET, CLIENT_DEVICE), { enc: 0 })
    assert.equal(raw.ack && raw.ack.ok, false, 'hello without enc capability refused')
    assert.equal(raw.ack && raw.ack.error, 'encryption required')
    await raw.closed
  } finally {
    await server2.close()
  }
})
