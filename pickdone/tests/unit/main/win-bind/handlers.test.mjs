/** T7 slice-4 RED tests — the five win-bind:* IPC handlers (src/main/win-bind/index.js).
 *  Fake adapter + fake store injected through ctx.__winBindDeps; main-window gate and lock
 *  gate behavior follow handlers/tomato.js (assertMainWindow + isLocked throw). */
import { test } from '../../../pilot/runner-shim.mjs'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const winBindHandlers = require('../../../../src/main/win-bind/index.js')

const MAIN_WC = { id: 1, tag: 'main-wc' }
const OTHER_WC = { id: 2, tag: 'other-wc' }
const mainWin = { webContents: MAIN_WC, isDestroyed: () => false }
const eMain = { sender: MAIN_WC }
const eOther = { sender: OTHER_WC }
const quietLog = { warn: () => {}, error: () => {}, info: () => {} }

const REF = { processName: 'notepad', execPath: 'C:\\w\\notepad.exe', title: 'memo', pidHint: 45504, hwnd: 723854, boundAt: 0 }

function makeCtx ({ adapter, store, broadcasts } = {}) {
  const locked = { v: false }
  return {
    ctx: {
      log: quietLog,
      getMainWindow: () => mainWin,
      isLocked: () => locked.v,
      broadcastWinBindChanged: p => broadcasts.push(p),
      __winBindDeps: { adapter, store }
    },
    locked
  }
}

function fakeAdapter (over = {}) {
  const calls = { probe: 0, enum: 0, activate: [] }
  const a = {
    calls,
    async probeUnderCursor () { calls.probe++; return 'probe' in over ? over.probe() : { raw: { hwnd: 723854, pid: 45504, processName: 'Notepad.exe', execPath: 'C:\\w\\notepad.exe', title: 'memo' }, buttonDown: false } },
    async enumerate () { calls.enum++; return 'enum' in over ? over.enum() : [{ hwnd: 723854, pid: 45504, processName: 'Notepad.exe', execPath: 'C:\\w\\notepad.exe', title: 'memo' }] },
    async activateHwnd (h) { calls.activate.push(h); return 'activate' in over ? over.activate(h) : { wasIconic: false, setForeground: true, foregroundNow: true, flashed: false } },
    dispose () {}
  }
  return a
}

function fakeStore (over = {}) {
  const puts = []
  const removed = []
  const table = new Map(over.rows ? over.rows.map(([k, v]) => [k, v]) : [])
  return {
    puts, removed,
    list () { return [...table.values()] },
    get (id) { return table.has(id) ? table.get(id) : null },
    put (b) { puts.push(b); if (over.putFail) return false; table.set(b.taskId, b); return true },
    remove (id) { removed.push(id); if (!table.has(id)) return false; table.delete(id); return true }
  }
}

test('all five channels reject a non-main-window sender', async () => {
  const broadcasts = []
  const { ctx } = makeCtx({ adapter: fakeAdapter(), store: fakeStore(), broadcasts })
  const h = winBindHandlers(ctx)
  for (const ch of ['win-bind:identify', 'win-bind:bind', 'win-bind:activate', 'win-bind:unbind', 'win-bind:list']) {
    await assert.rejects(() => h[ch](eOther, 't1', REF), /forbidden: main window only/, ch)
  }
  assert.equal(broadcasts.length, 0)
})

test('locked state throws on every channel (no probe, no activate)', async () => {
  const adapter = fakeAdapter()
  const broadcasts = []
  const { ctx, locked } = makeCtx({ adapter, store: fakeStore(), broadcasts })
  const h = winBindHandlers(ctx)
  locked.v = true
  for (const [ch, args] of [['win-bind:identify', []], ['win-bind:bind', ['t1', REF]], ['win-bind:activate', ['t1']], ['win-bind:unbind', ['t1']], ['win-bind:list', []]]) {
    await assert.rejects(() => h[ch](eMain, ...args), /lock/i, ch)
  }
  assert.equal(adapter.calls.probe, 0)
  assert.equal(adapter.calls.enum, 0)
})

test('identify: adapter probe → decideIdentify pipeline (bindable window, normalized, boundAt 0)', async () => {
  const { ctx } = makeCtx({ adapter: fakeAdapter(), store: fakeStore(), broadcasts: [] })
  const h = winBindHandlers(ctx)
  const r = await h['win-bind:identify'](eMain)
  assert.equal(r.reason, null)
  assert.equal(r.window.processName, 'notepad')
  assert.equal(r.window.pidHint, 45504)
  assert.equal(r.window.boundAt, 0)
})

test('identify: own-window / buttonDown / adapter-failure paths', async () => {
  const own = fakeAdapter({ probe: () => ({ raw: { hwnd: 1, pid: process.pid, processName: 'x', execPath: '', title: 't' }, buttonDown: false }) })
  const btn = fakeAdapter({ probe: () => ({ raw: { hwnd: 1, pid: 999, processName: 'x', execPath: '', title: 't' }, buttonDown: true }) })
  const boom = { async probeUnderCursor () { throw new Error('ps died') }, async enumerate () { return [] }, async activateHwnd () { return {} }, dispose () {} }
  const h1 = winBindHandlers(makeCtx({ adapter: own, store: fakeStore(), broadcasts: [] }).ctx)
  assert.deepEqual(await h1['win-bind:identify'](eMain), { window: null, reason: 'OWN_WINDOW' })
  const h2 = winBindHandlers(makeCtx({ adapter: btn, store: fakeStore(), broadcasts: [] }).ctx)
  assert.deepEqual(await h2['win-bind:identify'](eMain), { window: null, reason: 'BUTTON_DOWN' })
  const h3 = winBindHandlers(makeCtx({ adapter: boom, store: fakeStore(), broadcasts: [] }).ctx)
  assert.deepEqual(await h3['win-bind:identify'](eMain), { window: null, reason: 'ADAPTER_ERROR' })
})

test('bind: BAD_ARGS on bad taskId / missing or malformed ref', async () => {
  const { ctx } = makeCtx({ adapter: fakeAdapter(), store: fakeStore(), broadcasts: [] })
  const h = winBindHandlers(ctx)
  assert.deepEqual(await h['win-bind:bind'](eMain, '', REF), { ok: false, reason: 'BAD_ARGS' })
  assert.deepEqual(await h['win-bind:bind'](eMain, 'x'.repeat(129), REF), { ok: false, reason: 'BAD_ARGS' })
  assert.deepEqual(await h['win-bind:bind'](eMain, 't1', null), { ok: false, reason: 'BAD_ARGS' })
  assert.deepEqual(await h['win-bind:bind'](eMain, 't1', { processName: 'n', title: 't' }), { ok: false, reason: 'BAD_ARGS' }) // missing pidHint/hwnd/execPath
})

test('bind: STALE_REF when the enumerated snapshot has no hwnd+pid match (incl. own window)', async () => {
  const gone = fakeAdapter({ enum: () => [{ hwnd: 1, pid: 2, processName: 'notepad', execPath: '', title: 'x' }] })
  const ownWin = fakeAdapter({ enum: () => [{ hwnd: REF.hwnd, pid: process.pid, processName: 'notepad', execPath: '', title: 'x' }] })
  const h1 = winBindHandlers(makeCtx({ adapter: gone, store: fakeStore(), broadcasts: [] }).ctx)
  assert.deepEqual(await h1['win-bind:bind'](eMain, 't1', REF), { ok: false, reason: 'STALE_REF' })
  const h2 = winBindHandlers(makeCtx({ adapter: ownWin, store: fakeStore(), broadcasts: [] }).ctx)
  assert.deepEqual(await h2['win-bind:bind'](eMain, 't1', REF), { ok: false, reason: 'STALE_REF' })
})

test('bind ok: fresh normalized ref stamped with boundAt, persisted, broadcast {reason:bind}', async () => {
  const broadcasts = []
  const store = fakeStore()
  const { ctx } = makeCtx({ adapter: fakeAdapter(), store, broadcasts })
  const h = winBindHandlers(ctx)
  const before = Date.now()
  const r = await h['win-bind:bind'](eMain, 't1', { ...REF, processName: 'NotePad.EXE' })
  const after = Date.now()
  assert.equal(r.ok, true)
  assert.equal(r.binding.taskId, 't1')
  assert.equal(r.binding.ref.processName, 'notepad')
  assert.ok(r.binding.ref.boundAt >= before && r.binding.ref.boundAt <= after)
  assert.deepEqual(store.puts, [r.binding])
  assert.deepEqual(broadcasts, [{ reason: 'bind', taskId: 't1' }])
})

test('bind: store failure → STORE_ERROR, no broadcast', async () => {
  const broadcasts = []
  const store = fakeStore({ putFail: true })
  const { ctx } = makeCtx({ adapter: fakeAdapter(), store, broadcasts })
  const h = winBindHandlers(ctx)
  assert.deepEqual(await h['win-bind:bind'](eMain, 't1', REF), { ok: false, reason: 'STORE_ERROR' })
  assert.equal(broadcasts.length, 0)
})

test('activate: NO_BINDING when the store has no such taskId', async () => {
  const adapter = fakeAdapter()
  const { ctx } = makeCtx({ adapter, store: fakeStore(), broadcasts: [] })
  const h = winBindHandlers(ctx)
  assert.deepEqual(await h['win-bind:activate'](eMain, 'ghost'), { ok: false, reason: 'NO_BINDING' })
  assert.equal(adapter.calls.enum, 0)
})

test('activate: matcher ladder wired — NOT_FOUND / AMBIGUOUS(candidates) / FOUND→activateHwnd(hwnd)', async () => {
  const binding = { taskId: 't1', ref: { ...REF, boundAt: 1 } }
  const none = fakeAdapter({ enum: () => [{ hwnd: 1, pid: 2, processName: 'chrome', execPath: '', title: 'c' }] })
  const amb = fakeAdapter({ enum: () => ([
    { hwnd: 11, pid: 900, processName: 'notepad', execPath: '', title: 'memo' },
    { hwnd: 12, pid: 901, processName: 'notepad', execPath: '', title: 'memo' }
  ]) })
  const h1 = winBindHandlers(makeCtx({ adapter: none, store: fakeStore({ rows: [['t1', binding]] }), broadcasts: [] }).ctx)
  assert.deepEqual(await h1['win-bind:activate'](eMain, 't1'), { ok: false, reason: 'NOT_FOUND' })
  const h2 = winBindHandlers(makeCtx({ adapter: amb, store: fakeStore({ rows: [['t1', binding]] }), broadcasts: [] }).ctx)
  const r2 = await h2['win-bind:activate'](eMain, 't1')
  assert.equal(r2.ok, false); assert.equal(r2.reason, 'AMBIGUOUS'); assert.equal(r2.candidates.length, 2)
  const adapter = fakeAdapter() // default enum matches REF → FOUND
  const h3 = winBindHandlers(makeCtx({ adapter, store: fakeStore({ rows: [['t1', binding]] }), broadcasts: [] }).ctx)
  const r3 = await h3['win-bind:activate'](eMain, 't1')
  assert.deepEqual(r3, { ok: true })
  assert.deepEqual(adapter.calls.activate, [REF.hwnd])
})

test('activate: foreground failure → ACTIVATE_FAILED with flashed flag; adapter crash → ADAPTER_ERROR', async () => {
  const binding = { taskId: 't1', ref: { ...REF, boundAt: 1 } }
  const flash = fakeAdapter({ activate: () => ({ wasIconic: true, setForeground: false, foregroundNow: false, flashed: true }) })
  const boom = { async probeUnderCursor () { return { raw: null, buttonDown: null } }, async enumerate () { throw new Error('ps died') }, async activateHwnd () { return {} }, dispose () {} }
  const h1 = winBindHandlers(makeCtx({ adapter: flash, store: fakeStore({ rows: [['t1', binding]] }), broadcasts: [] }).ctx)
  assert.deepEqual(await h1['win-bind:activate'](eMain, 't1'), { ok: false, reason: 'ACTIVATE_FAILED', flashed: true })
  const h2 = winBindHandlers(makeCtx({ adapter: boom, store: fakeStore({ rows: [['t1', binding]] }), broadcasts: [] }).ctx)
  assert.deepEqual(await h2['win-bind:activate'](eMain, 't1'), { ok: false, reason: 'ADAPTER_ERROR' })
})

test('unbind: removed flag mirrors the store; broadcast {reason:unbind}; never throws', async () => {
  const broadcasts = []
  const store = fakeStore({ rows: [['t1', { taskId: 't1', ref: REF }]] })
  const { ctx } = makeCtx({ adapter: fakeAdapter(), store, broadcasts })
  const h = winBindHandlers(ctx)
  assert.deepEqual(await h['win-bind:unbind'](eMain, 't1'), { ok: true, removed: true })
  assert.deepEqual(await h['win-bind:unbind'](eMain, 't1'), { ok: true, removed: false })
  assert.deepEqual(await h['win-bind:unbind'](eMain, 'ghost'), { ok: true, removed: false })
  assert.deepEqual(broadcasts, [{ reason: 'unbind', taskId: 't1' }, { reason: 'unbind', taskId: 't1' }, { reason: 'unbind', taskId: 'ghost' }])
})

test('list: passes the store rows through', async () => {
  const rows = [['a', { taskId: 'a', ref: REF }], ['b', { taskId: 'b', ref: REF }]]
  const { ctx } = makeCtx({ adapter: fakeAdapter(), store: fakeStore({ rows }), broadcasts: [] })
  const h = winBindHandlers(ctx)
  const r = await h['win-bind:list'](eMain)
  assert.deepEqual(r, { bindings: [{ taskId: 'a', ref: REF }, { taskId: 'b', ref: REF }] })
})

test('disposeForQuit exists and is a safe no-throw even with nothing live', () => {
  const fn = winBindHandlers.disposeForQuit
  assert.equal(typeof fn, 'function')
  assert.doesNotThrow(() => fn())
})
