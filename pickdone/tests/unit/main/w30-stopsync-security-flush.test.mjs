/* W30 (P3) stopSync node-less early return must still drain the throttled security persist.
 * stopSync used to open with `if (!state.node) return` — BEFORE the securityPersistTimer flush /
 * clearTimeout block — so any stop entering with a torn-down node left the pending throttle timer
 * armed (its callback later hit the `!state.node` guard and silently dropped the ring entries it
 * was holding). Fix: the flush+clear moved above the early return, guarded as before (a live node
 * + non-degraded store still required for the actual write).
 * Harness: Module._load stubs (electron / electron-log), TODO_DB_DIR/TODO_USER_DATA_DIR pointed
 * at temp dirs so log-isolation never touches real %APPDATA%. clearTimeout is spied at the
 * global to observe the timer drain (the module calls the bare global identifier). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Module from 'module'
import { createRequire } from 'module'

const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'w30-stopsync-ud-'))
process.env.TODO_DB_DIR = path.join(UD, 'db')
process.env.TODO_USER_DATA_DIR = UD
fs.mkdirSync(process.env.TODO_DB_DIR, { recursive: true })

const ELECTRON_STUB = { app: { getPath: () => UD, getVersion: () => '0.0.0-test', relaunch: () => {}, exit: () => {}, quit: () => {} }, BrowserWindow () { return {} } }
const LOG_STUB = { info: () => {}, warn: () => {}, error: () => {} }
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB
  if (request === 'electron-log') return LOG_STUB
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const require_ = createRequire(import.meta.url)
const lsb = require_('../../../src/main/lan-sync-bootstrap.js')
const { stopSync, scheduleSecurityPersist, setState } = lsb.__test

const baseState = () => ({ node: null, timers: [], pendingPair: null, peerWatermarks: null, engine: null, applyCache: null, getWindowSenders: () => [] })

function spyClearTimeout () {
  const cleared = []
  const orig = global.clearTimeout
  global.clearTimeout = h => { cleared.push(h); return orig(h) }
  return { cleared, restore () { global.clearTimeout = orig } }
}

test('stopSync with node=null still clears a pending securityPersistTimer (early return no longer skips it)', async () => {
  setState(baseState())
  scheduleSecurityPersist() // arm the 1s throttle timer
  const spy = spyClearTimeout()
  try {
    await stopSync()
  } finally { spy.restore() }
  assert.ok(spy.cleared.length >= 1, 'stopSync must clearTimeout the armed security persist timer even without a node')
})

test('stopSync with node=null and NO armed timer does not throw and stays a no-op', async () => {
  setState(baseState())
  const spy = spyClearTimeout()
  try {
    await stopSync()
  } finally { spy.restore() }
  assert.ok(true)
})

test('stopSync with a live node keeps the full teardown contract (flush attempted, node nulled, timers cleared)', async () => {
  let stopCalls = 0
  const node = {
    getStatus: () => ({ security: ['e1', 'e2'] }),
    stop: async () => { stopCalls++ },
  }
  const t = setTimeout(() => {}, 10_000)
  setState({ ...baseState(), node, timers: [t], pendingPair: { respond: () => {} } })
  const spy = spyClearTimeout()
  try {
    await stopSync()
  } finally { spy.restore() }
  assert.equal(stopCalls, 1, 'node.stop() awaited')
  assert.ok(spy.cleared.length >= 1, 'round timers + security persist timer cleared')
})

test('stopSync with a live node nulls state.node / pendingPair / engine / applyCache', async () => {
  let stopCalls = 0
  const node = { getStatus: () => ({ security: [] }), stop: async () => { stopCalls++ } }
  const stateRef = { ...baseState(), node, engine: { x: 1 }, applyCache: { y: 2 }, pendingPair: { respond: () => {} } }
  setState(stateRef)
  await stopSync()
  assert.equal(stateRef.node, null)
  assert.equal(stateRef.pendingPair, null)
  assert.equal(stateRef.engine, null)
  assert.equal(stateRef.applyCache, null)
  assert.equal(stopCalls, 1)
})
