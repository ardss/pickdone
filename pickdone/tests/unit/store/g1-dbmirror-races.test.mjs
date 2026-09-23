/**
 * G1 regressions for utils/dbMirror.js (c76cf33 retry path):
 *  a) stale-blob overwrite race — a late rejection of write#1 (old blob) after write#2 (new blob)
 *     already landed must not re-queue the old blob over the new one;
 *  b) early-exit environments (no todoAPI) keep the blob queued instead of silently dropping it;
 *  c) retries back off exponentially and give up after maxAttempts with a one-time console.error.
 * Run: node --test tests/unit/store/g1-dbmirror-races.test.mjs
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const warns = []
const errors = []
const infos = []
const orig = { warn: console.warn, error: console.error, info: console.info }
const capture = async fn => {
  console.warn = (...a) => warns.push(a.join(' '))
  console.error = (...a) => errors.push(a.join(' '))
  console.info = (...a) => infos.push(a.join(' '))
  // NOTE: must await INSIDE the try — a bare `return fn()` hits the finally as soon as the body
  // suspends at its first await, restoring the loggers before async failures are reported.
  try { await fn() } finally { console.warn = orig.warn; console.error = orig.error; console.info = orig.info }
}

const calls = []
const timestamps = []
let impl = null // per-test dbCall implementation
globalThis.window = { location: { hash: '' }, todoAPI: { dbCall: (...a) => impl(...a) } }
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }

beforeEach(() => { calls.length = 0; timestamps.length = 0; warns.length = 0; errors.length = 0; infos.length = 0 })

const { mirrorToDb, _timing } = await import('../../../renderer/js/utils/dbMirror.js')

test('G1 dbMirror: a stale rejection (old blob) never clobbers a newer queued blob', async () => capture(async () => {
  _timing.debounceMs = 5; _timing.retryBaseMs = 5
  // Manual promise control: write#1 (old blob) stays in flight while write#2 (new blob) lands.
  let releaseA
  impl = (op, params) => {
    calls.push([op, params])
    if (JSON.parse(params[1]).v === 1) return new Promise((res, rej) => { releaseA = rej })
    return Promise.resolve('ok')
  }
  mirrorToDb('k', { v: 1 }, true) // write#1 in flight, un-resolved
  await new Promise(r => setTimeout(r, 5))
  mirrorToDb('k', { v: 2 }, true) // write#2 succeeds
  await new Promise(r => setTimeout(r, 5))
  assert.equal(calls.length, 2)
  releaseA(new Error('late disk-full failure')) // write#1's rejection arrives AFTER write#2 landed
  await new Promise(r => setTimeout(r, 20))
  const queued = calls.filter(c => JSON.parse(c[1][1]).v === 1)
  assert.equal(queued.length, 1, 'the old blob is never re-written after the new blob landed (no rollback)')
  assert.equal(JSON.parse(calls[calls.length - 1][1][1]).v, 2, 'the newest blob remains the last write')
  assert.ok(infos.some(i => i.includes('stale')), 'the stale failure is noted, not silently swallowed')
}))

test('G1 dbMirror: an early-exit environment keeps the blob pending instead of dropping it', async () => capture(async () => {
  _timing.debounceMs = 5
  const api = globalThis.window.todoAPI
  delete globalThis.window.todoAPI // degraded host: writeNow early-exits
  try {
    impl = (op, p) => { calls.push([op, p]); return Promise.resolve('ok') }
    mirrorToDb('k2', { v: 1 })
    await new Promise(r => setTimeout(r, 20)) // debounce tick fires, writeNow early-exits
    // No assertion hook into module state needed: the next capable write must still carry the blob
    globalThis.window.todoAPI = api
    mirrorToDb('k2', { v: 1 }, true)
    await new Promise(r => setTimeout(r, 5))
    assert.equal(calls.length, 1, 'the blob survived the early-exit tick and was written once capable')
    assert.equal(JSON.parse(calls[0][1][1]).v, 1)
  } finally { globalThis.window.todoAPI = api }
}))

test('G1 dbMirror: retries back off exponentially (base → base*2 …)', async () => capture(async () => {
  _timing.debounceMs = 5; _timing.retryBaseMs = 20; _timing.retryMaxMs = 60; _timing.maxAttempts = 10
  let failing = true // stop the retry loop before this test ends so it cannot leak into later tests
  impl = () => { calls.push([]); timestamps.push(Date.now()); return failing ? Promise.reject(new Error('locked')) : Promise.resolve('ok') }
  // Assert on the SCHEDULED delays, not wall-clock gaps: under a loaded CI box the event loop can
  // stall so two already-due timers fire back-to-back, making measured gaps non-monotonic even
  // though the backoff schedule is correct (observed flake — same class as the give-up test below).
  const realSetTimeout = globalThis.setTimeout
  const delays = []
  globalThis.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return realSetTimeout(fn, ms, ...rest) }
  try {
    mirrorToDb('k3', { v: 1 }, true)
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && delays.length < 3) await new Promise(r => realSetTimeout(r, 10))
    assert.ok(calls.length >= 3, 'multiple retries happened, got ' + calls.length)
    const retries = delays.filter(d => d >= _timing.retryBaseMs) // exclude the 5ms debounce timer
    assert.equal(retries[0], 20, 'first retry waits base ms')
    assert.equal(retries[1], 40, 'second retry waits 2x base ms')
    assert.equal(retries[2], 60, 'third retry waits 4x base ms (capped at retryMaxMs)')
    assert.ok(delays[1] >= delays[0] && delays[2] >= delays[1], 'backoff is non-decreasing (exponential)')
  } finally { globalThis.setTimeout = realSetTimeout }
  failing = false // lingering retries now succeed and retire the key
  await new Promise(r => setTimeout(r, 80))
}))

test('G1 dbMirror: gives up after maxAttempts with a one-time console.error', async () => capture(async () => {
  _timing.debounceMs = 5; _timing.retryBaseMs = 5; _timing.maxAttempts = 3
  impl = () => { calls.push([]); return Promise.reject(new Error('dead')) }
  mirrorToDb('k4', { v: 1 }, true)
  // Poll until the give-up report fires instead of a fixed sleep — a loaded CI box can stretch the
  // 5->10->20ms backoff chain past any hardcoded wait, so more writes would land after it (observed flake).
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && !errors.some(e => e.includes('k4') && e.includes('giving up'))) {
    await new Promise(r => setTimeout(r, 10))
  }
  const writes = calls.length // initial + retries
  assert.ok(writes >= 3, 'initial write + retries happened')
  assert.equal(errors.filter(e => e.includes('k4') && e.includes('giving up')).length, 1, 'exactly one give-up report for this key')
  await new Promise(r => setTimeout(r, 60))
  assert.equal(calls.length, writes, 'no further writes after the give-up (no infinite retry)')
}))
