/**
 * dw wave5 P2 (2026-09-24) — the flush handshake round (broadcast → ack → bounded wait →
 * flushMain) existed twice (index.js will-quit + updater.js flushOnceOnReady) with drifted caps
 * (2000 vs 1500ms). Converged into quit-ack.runFlushRound / awaitFlushAcks.
 * Run: node --test tests/unit/main/dw5-flush-round-convergence.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const require_ = createRequire(import.meta.url)
const { createQuitAckTracker, runFlushRound, awaitFlushAcks, FLUSH_ACK_CAP_MS } = require_(path.join(ROOT, 'src/main/quit-ack.js'))

function fakeWindow (id, sent) {
  return {
    isDestroyed: () => false,
    webContents: { id, send: (ch, p) => sent.push([id, ch, p]) }
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

test('runFlushRound: broadcasts one tokenized round to live windows only, then flushes after acks', async () => {
  const sent = []
  const w1 = fakeWindow(11, sent)
  const w2 = fakeWindow(12, sent)
  const dead = { isDestroyed: () => true, webContents: { id: 99, send: () => sent.push([99, 'x', null]) } }
  const tracker = createQuitAckTracker()
  let flushed = 0
  const token = runFlushRound({
    tracker,
    getWindows: () => [w1, dead, w2],
    flushMain: () => { flushed++ },
    capMs: 500
  })
  assert.equal(sent.length, 2, 'dead windows get no broadcast')
  assert.deepEqual(sent.map(s => s[1]), ['app-quitting-flush', 'app-quitting-flush'])
  assert.ok(sent.every(s => s[2].token === token), 'both windows received the same round token')
  // renderer acks; flush fires only after both expected senders acked
  assert.equal(tracker.ack(token, 11), true)
  assert.equal(flushed, 0, 'no flush before all acks')
  assert.equal(tracker.ack(token, 12), true)
  await sleep(120)
  assert.equal(flushed, 1, 'flushMain ran once all live windows acked')
})

test('runFlushRound: bounded cap fires flushMain even when no renderer ever acks', async () => {
  const sent = []
  const tracker = createQuitAckTracker()
  let flushed = 0
  runFlushRound({
    tracker,
    getWindows: () => [fakeWindow(7, sent)],
    flushMain: () => { flushed++ },
    capMs: 100
  })
  await sleep(300)
  assert.equal(flushed, 1, 'a hung renderer cannot block the flush beyond the cap')
})

test('awaitFlushAcks: cap unified on 2000ms', () => {
  assert.equal(FLUSH_ACK_CAP_MS, 2000)
})

test('awaitFlushAcks: abandoned (dead) senders take the fast path — no full-cap wait', async () => {
  const tracker = createQuitAckTracker()
  const token = tracker.nextToken()
  tracker.beginRound([1, 2], token)
  let flushed = 0
  tracker.abandon(1)
  tracker.abandon(2)
  awaitFlushAcks({ tracker, capMs: 5000, flushMain: () => { flushed++ } })
  await sleep(100)
  assert.equal(flushed, 1, 'zero expected senders → allAcked → flush without waiting the cap')
})

test('source shape: updater.js no longer carries its own poll loop; index.js waits via the shared helper', async () => {
  const code = p => fs.readFileSync(path.join(ROOT, p), 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  const updater = code('src/main/updater.js')
  assert.match(updater, /runFlushRound\(/, 'updater delegates the round to quit-ack')
  assert.doesNotMatch(updater, /setInterval\(/, 'no hand-rolled poll loop left in updater.js')
  const index = code('src/main/index.js')
  assert.match(index, /awaitFlushAcks\(/, 'index.js will-quit uses the shared bounded wait')
  assert.doesNotMatch(code('src/main/quit-ack.js').replace(/awaitFlushAcks[\s\S]*$/, ''), /setInterval\(/)
})
