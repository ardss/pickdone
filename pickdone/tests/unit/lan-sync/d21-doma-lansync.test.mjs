// D21 domain fixes (2026-10-02) — lan-sync side:
//   finding 2: LineReader JSON.parse is narrowed to the sever-on-failure path; a HANDLER throw
//              logs loudly and keeps the socket (no more silent 'bad JSON line' destroy).
//   finding 15: transport.send writes the line and the newline separately (no ~32MB concat),
//               preserving the boolean backpressure contract.
//   finding 7 (source pin): att-transfer spools through durable-fs writeFileDurable.
//   finding 6 (source pin): node-events guards loadPairedPeers so one throw cannot skip all
//               peer restore.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'

const require = createRequire(import.meta.url)
const { LineReader } = require('../../../src/main/lan-sync/line-reader.js')
const transport = require('../../../src/main/lan-sync/transport.js')


/** Fake net socket: EventEmitter + the surface LineReader/transport touch. */
function fakeSocket () {
  const s = new EventEmitter()
  s.setEncoding = () => {}
  s.writable = true
  s.destroyed = false
  s.writes = []
  s.write = (chunk) => { s.writes.push(String(chunk)); return true }
  s.destroy = () => { s.destroyed = true }
  return s
}

test('D21: torn JSON still severs the connection with the bad-JSON protocol error', () => {
  const sock = fakeSocket()
  const errors = []
  const reader = new LineReader(sock, () => {}, (e) => errors.push(e))
  assert.ok(reader)
  sock.emit('data', '{"broken": \n')
  assert.equal(sock.destroyed, true, 'torn JSON must destroy the socket (protocol fault)')
  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /^bad JSON line:/)
})

test('D21: a dispatch (handler) throw is logged honestly and does NOT destroy the socket', () => {
  const sock = fakeSocket()
  const errors = []
  const received = []
  const reader = new LineReader(sock, (msg) => {
    received.push(msg)
    if (msg.type === 'boom') throw new Error('handler bug')
  }, (e) => errors.push(e))
  assert.ok(reader)
  sock.emit('data', '{"type":"boom"}\n{"type":"after"}\n')
  assert.equal(sock.destroyed, false, 'handler bug is not a wire fault — socket survives')
  assert.equal(errors.length, 0, 'no ProtocolError must be fabricated for a dispatch error')
  assert.deepEqual(received.map(m => m.type), ['boom', 'after'], 'remaining buffered lines still processed')
  // Reader stays usable: a later torn line still severs with the honest reason.
  sock.emit('data', 'not json\n')
  assert.equal(sock.destroyed, true)
  assert.match(errors[0].message, /^bad JSON line:/)
})

test('D21 revert: transport.send emits ONE write per frame (body+newline concatenated)', () => {
  // The two-write variant was legal framing-wise but delivered the newline as its own TCP
  // segment on Linux, breaking naive per-data-event line parsers (snapshot mutual-busy harness
  // red on CI). The single concat write is the contract: exactly one segment per frame.
  const sock = fakeSocket()
  const ok = transport.send(sock, { type: 'ping' })
  assert.equal(ok, true, 'truthy contract on a healthy socket')
  assert.equal(sock.writes.length, 1, 'exactly one write: body terminated by the newline')
  assert.equal(sock.writes[0], JSON.stringify({ type: 'ping' }) + '\n', 'wire bytes are the frame plus one newline')
})

test('D21: transport.send still reports false on a dead socket', () => {
  const dead = fakeSocket()
  dead.destroyed = true
  assert.equal(transport.send(dead, { type: 'ping' }), false)
  const throwing = fakeSocket()
  throwing.write = () => { throw new Error('EPIPE') }
  assert.equal(transport.send(throwing, { type: 'ping' }), false)
})

test('D21 source pin: att-transfer spool routes through durable-fs writeFileDurable (finding 7)', () => {
  const src = readFileSync(require.resolve('../../../src/main/lan-sync/att-transfer.js'), 'utf8')
  assert.match(src, /writeFileDurable\(/, 'spool must use the shared durable writer (fsync before rename)')
  assert.doesNotMatch(src, /fs\.writeFileSync\(tmp/, 'bare spool writeFileSync must be gone')
})

test('D21 source pin: node-events guards loadPairedPeers per session (finding 6)', () => {
  const src = readFileSync(require.resolve('../../../src/main/lan-sync/node-events.js'), 'utf8')
  // The load must be inside a try that falls back to an empty table.
  assert.match(src, /try \{ pairedPeers = Object\.values\(loadPairedPeers\(\)\) \} catch/, 'loadPairedPeers must be guarded')
  assert.match(src, /for \(const p of pairedPeers\)/, 'restore iterates the guarded list')
})
