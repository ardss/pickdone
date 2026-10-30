/** T7 slice-3 RED tests — resident-PowerShell window adapter (src/main/win-bind/adapter.js).
 *  Line protocol, lifecycle (error/exit listeners, respawn cap, per-query timeout, dispose) and
 *  response shaping are tested against an injected fake spawn; live PS probing is guarded on
 *  win32 in a separate file. */
import { test } from '../../../pilot/runner-shim.mjs'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createWinAdapter } = require('../../../../src/main/win-bind/adapter.js')

function fakeChild () {
  const c = new EventEmitter()
  c.stdin = { writes: [], write (s) { this.writes.push(s) } }
  c.stdout = new EventEmitter()
  c.stderr = new EventEmitter()
  c.killed = false
  c.exitCode = null
  c.kill = () => { c.killed = true; c.exitCode = 1; process.nextTick(() => c.emit('exit', 1)) }
  return c
}

/** Harness: records spawned children; auto-answers the boot ping; lets each case script replies. */
function harness ({ reply } = {}) {
  const spawned = []
  const spawnFn = (cmd, args, opts) => {
    const c = fakeChild()
    spawned.push(c)
    // auto-ack the boot ping as soon as it is written (keep-alive handshake)
    const origWrite = c.stdin.write.bind(c.stdin)
    c.stdin.write = s => {
      origWrite(s)
      try {
        const req = JSON.parse(String(s).trim())
        if (req.op === 'ping') {
          c.stdout.emit('data', Buffer.from(JSON.stringify({ id: req.id, ok: true, result: 'pong' }) + '\n'))
        } else if (typeof reply === 'function') {
          const resp = reply(req, c, spawned.length)
          if (resp) c.stdout.emit('data', Buffer.from(resp + '\n'))
        }
      } catch { /* test mis-scripting; case will surface it */ }
      return true
    }
    process.nextTick(() => c.emit('spawn')) // not strictly required by the adapter
    return c
  }
  return { spawned, spawnFn }
}

const quietLog = { warn: () => {}, error: () => {}, info: () => {} }

test('probeUnderCursor: request carries auto-incremented id + op, response shaped with normalized processName', async () => {
  const h = harness({
    reply: req => req.op === 'probe'
      ? JSON.stringify({ id: req.id, ok: true, result: { raw: { hwnd: 723854, pid: 45504, processName: 'Notepad.exe', execPath: 'C:\\w\\notepad.exe', title: 'x' }, buttonDown: false } })
      : null
  })
  const a = createWinAdapter({ spawn: h.spawnFn, timeoutMs: 1000, log: quietLog })
  const out = await a.probeUnderCursor()
  assert.equal(out.raw.processName, 'notepad')
  assert.equal(out.raw.hwnd, 723854)
  assert.equal(out.buttonDown, false)
  const sent = JSON.parse(h.spawned[0].stdin.writes.find(w => w.includes('"probe"')).trim())
  assert.equal(sent.op, 'probe')
  assert.ok(Number.isInteger(sent.id) && sent.id >= 1)
  a.dispose()
})

test('enumerate: normalizes every row, returns the array', async () => {
  const h = harness({
    reply: req => req.op === 'enum'
      ? JSON.stringify({ id: req.id, ok: true, result: [
        { hwnd: 1, pid: 10, processName: 'CHROME.exe', execPath: '', title: 'a' },
        { hwnd: 2, pid: 20, processName: 'explorer', execPath: '', title: 'Program Manager' }
      ] })
      : null
  })
  const a = createWinAdapter({ spawn: h.spawnFn, timeoutMs: 1000, log: quietLog })
  const rows = await a.enumerate()
  assert.equal(rows.length, 2)
  assert.equal(rows[0].processName, 'chrome')
  assert.equal(rows[1].processName, 'explorer')
  a.dispose()
})

test('activateHwnd: hwnd travels in the request; the four-flag result passes through', async () => {
  const h = harness({
    reply: req => req.op === 'activate'
      ? JSON.stringify({ id: req.id, ok: true, result: { wasIconic: true, setForeground: false, foregroundNow: false, flashed: true } })
      : null
  })
  const a = createWinAdapter({ spawn: h.spawnFn, timeoutMs: 1000, log: quietLog })
  const r = await a.activateHwnd(723854)
  assert.deepEqual(r, { wasIconic: true, setForeground: false, foregroundNow: false, flashed: true })
  const sent = JSON.parse(h.spawned[0].stdin.writes.find(w => w.includes('"activate"')).trim())
  assert.equal(sent.hwnd, 723854)
  a.dispose()
})

test('chunked stdout reassembly and out-of-order ids both resolve to the right caller', async () => {
  const h = harness()
  const a = createWinAdapter({ spawn: h.spawnFn, timeoutMs: 1000, log: quietLog })
  const p1 = a.probeUnderCursor()
  const p2 = a.enumerate()
  const c = h.spawned[0]
  await new Promise(r => setImmediate(r)) // let the two request lines land after the boot ping
  const w1 = JSON.parse(c.stdin.writes[1].trim())
  const w2 = JSON.parse(c.stdin.writes[2].trim())
  // reply for the SECOND request first, split across two chunks; then the first
  const second = JSON.stringify({ id: w2.id, ok: true, result: [] })
  c.stdout.emit('data', Buffer.from(second.slice(0, 8)))
  c.stdout.emit('data', Buffer.from(second.slice(8) + '\n'))
  const first = JSON.stringify({ id: w1.id, ok: true, result: { raw: null, buttonDown: null } })
  c.stdout.emit('data', Buffer.from(first + '\n'))
  assert.deepEqual(await p1, { raw: null, buttonDown: null })
  assert.deepEqual(await p2, [])
  a.dispose()
})

test('adapter-side error reply rejects the query (ok:false carries the error text)', async () => {
  const h = harness({ reply: req => JSON.stringify({ id: req.id, ok: false, error: 'native explosion' }) })
  const a = createWinAdapter({ spawn: h.spawnFn, timeoutMs: 1000, log: quietLog })
  await assert.rejects(() => a.enumerate(), /native explosion/)
  a.dispose()
})

test('per-query timeout rejects, kills the wedged child, and the next call respawns (bounded by maxRespawn)', async () => {
  const h = harness() // never answers non-ping ops
  const a = createWinAdapter({ spawn: h.spawnFn, timeoutMs: 40, maxRespawn: 2, log: quietLog })
  await assert.rejects(() => a.enumerate(), /timeout/i)
  assert.equal(h.spawned[0].killed, true)
  const second = await a.enumerate().then(() => 'resolved', e => 'rejected:' + e.message)
  assert.match(second, /^rejected:.*timeout/) // child #2 also wedged → killed
  assert.equal(h.spawned.length, 2)
  // respawn #3 exceeds maxRespawn=2 → structural refusal, no more spawns
  const third = await a.enumerate().then(() => 'resolved', e => 'rejected:' + e.message)
  assert.match(third, /rejected:.*(cap|respawn).*/i)
  assert.equal(h.spawned.length, 2)
  a.dispose()
})

test('unexpected child exit rejects in-flight queries; next use respawns and answers', async () => {
  const h = harness()
  const a = createWinAdapter({ spawn: h.spawnFn, timeoutMs: 5000, maxRespawn: 5, log: quietLog })
  const p = a.enumerate()
  h.spawned[0].emit('exit', 1)
  await assert.rejects(() => p, /exit|closed|adapter/i)
  // second call respawns; answer its enum by hand once the request line lands
  const later = a.enumerate().then(rows => rows, err => { throw err })
  setImmediate(() => {
    const c2 = h.spawned[1]
    const reqLine = c2.stdin.writes.find(w => w.includes('"enum"'))
    if (reqLine) {
      const req = JSON.parse(reqLine.trim())
      c2.stdout.emit('data', Buffer.from(JSON.stringify({ id: req.id, ok: true, result: [{ hwnd: 9, pid: 9, processName: 'x', execPath: '', title: '' }] }) + '\n'))
    }
  })
  const rows = await later
  assert.equal(rows.length, 1)
  a.dispose()
})

test("spawn 'error' (ENOENT-class) rejects instead of crashing (D13 C4 lesson)", async () => {
  const h = harness()
  const a = createWinAdapter({ spawn: h.spawnFn, timeoutMs: 200, log: quietLog })
  process.nextTick(() => h.spawned[0].emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })))
  await assert.rejects(() => a.enumerate(), /ENOENT|adapter/i)
  a.dispose()
})

test('dispose kills the child, rejects later calls, is idempotent', async () => {
  const h = harness()
  const a = createWinAdapter({ spawn: h.spawnFn, timeoutMs: 1000, log: quietLog })
  await a.prewarm()
  a.dispose()
  assert.equal(h.spawned[0].killed, true)
  await assert.rejects(() => a.enumerate(), /dispose/i)
  a.dispose() // no throw
})

test('boot handshake has its own (longer) budget: un-acked ping fails at bootTimeoutMs', async () => {
  // a harness whose children NEVER answer anything (not even ping)
  const spawned = []
  const spawnFn = () => { const c = fakeChild(); spawned.push(c); return c }
  const a = createWinAdapter({ spawn: spawnFn, timeoutMs: 30_000, bootTimeoutMs: 80, log: quietLog })
  await assert.rejects(() => a.enumerate(), /timeout/i)
  a.dispose()
})

test('PROBE_OPS advertises the wire ops for diagnostics', () => {
  const { PROBE_OPS } = require('../../../../src/main/win-bind/adapter.js')
  assert.ok(Array.isArray(PROBE_OPS) && PROBE_OPS.includes('probe') && PROBE_OPS.includes('enum') && PROBE_OPS.includes('activate'))
})
