/**
 * D17 (2026-10-02) — LineReader chunked accumulation. `buffer += chunk` was O(n²) across the
 * many small socket reads of one large authenticated line (~1MB segments-chunks). Chunks now
 * accumulate in an array and are joined only when a newline arrives; byte accounting
 * (bufferBytes / _accountedBytes / aggregate budget) must stay EXACT.
 * Run: node --test tests/unit/lan-sync/d17-line-reader-chunking.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { LineReader, lineBufferState, __setLineBufferBudget } = require('../../../src/main/lan-sync/line-reader.js')

function fakeSocket () {
  const s = new EventEmitter()
  s.destroyed = false
  s.destroy = () => { s.destroyed = true; s.emit('close') }
  s.setEncoding = () => {}
  return s
}

test('D17: a large line delivered in many small chunks parses exactly once, with exact byte accounting', () => {
  const socket = fakeSocket()
  const messages = []
  const reader = new LineReader(socket, (m) => messages.push(m), () => { throw new Error('unexpected onError') }, 1024 * 1024)
  reader.setLimit(1024 * 1024)
  const payload = 'x'.repeat(200 * 1024)
  const line = JSON.stringify({ type: 'segments-chunk', payload }) + '\n'
  // 300 chunks of ~700B — pre-fix this was O(n²) string re-copying; correctness must not change.
  const savedTotal = lineBufferState.total
  try {
    for (let i = 0; i < 300; i++) socket.emit('data', line.slice(i * 700, Math.min(line.length, (i + 1) * 700)))
    assert.equal(messages.length, 1)
    assert.equal(messages[0].payload, payload, 'the joined line is byte-exact')
    assert.equal(reader.bufferBytes, 0, 'every consumed byte left the accounting')
    assert.equal(lineBufferState.total, savedTotal, 'the process-wide budget total is restored exactly (no drift)')
  } finally {
    socket.destroy()
  }
})

test('D17: multiple lines within ONE chunk all parse (join path), leftover partial stays buffered', () => {
  const socket = fakeSocket()
  const messages = []
  const reader = new LineReader(socket, (m) => messages.push(m), () => { throw new Error('unexpected onError') })
  socket.emit('data', '{"a":1}\n{"b":2}\n{"c":')
  assert.deepEqual(messages, [{ a: 1 }, { b: 2 }])
  assert.equal(reader.bufferBytes, Buffer.byteLength('{"c":', 'utf8'))
  socket.emit('data', '3}\n')
  assert.deepEqual(messages, [{ a: 1 }, { b: 2 }, { c: 3 }])
  assert.equal(reader.bufferBytes, 0)
  socket.destroy()
})

test('D17: over-limit and bad-JSON destroy paths still fire, with accounting reconciled', () => {
  const socket = fakeSocket()
  const errors = []
  new LineReader(socket, () => {}, (e) => errors.push(e), 100)
  socket.emit('data', 'y'.repeat(101)) // no newline: over-limit on the fast path
  assert.equal(socket.destroyed, true)
  assert.match(String(errors[0]), /line exceeds/)
  assert.equal(lineBufferState.total, 0, 'the destroyed reader released its bytes')

  const socket2 = fakeSocket()
  const errors2 = []
  new LineReader(socket2, () => {}, (e) => errors2.push(e))
  socket2.emit('data', '{"broken' + '\n')
  assert.equal(socket2.destroyed, true)
  assert.match(String(errors2[0]), /bad JSON line/)
})

test('D17: the aggregate budget gate still evicts the offending reader under chunked feeds', () => {
  __setLineBufferBudget(8 * 1024)
  try {
    const socket = fakeSocket()
    const errors = []
  new LineReader(socket, () => {}, (e) => errors.push(e), 64 * 1024)
    // Two 5KB unterminated chunk sets: the second feed pushes the aggregate past the 8KB cap.
    socket.emit('data', 'a'.repeat(5 * 1024))
    assert.equal(socket.destroyed, false)
    socket.emit('data', 'b'.repeat(5 * 1024))
    assert.equal(socket.destroyed, true)
    assert.match(String(errors[0]), /aggregate line-buffer budget exceeded/)
  } finally {
    __setLineBufferBudget(64 * 1024 * 1024)
  }
})
