/** Contract tests for two extracted-pure modules that had fallen out of every suite's reach:
 *  - cli/lib-sync.cjs (the `sync` command group: status/pair/pair-respond/unpair — plain vs
 *    --json emit, CliError usage/sync/app-not-running paths, ack null vs !ok);
 *  - renderer/js/views/statistics/csv.js (formula-injection neutralization + export table shape).
 * Run: node --test tests/unit/cli/lib-sync-and-csv.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const runSync = require('../../../cli/lib-sync.cjs')

class CliError extends Error { constructor (msg, code) { super(msg); this.code = code } }

/** Fake lib: programmable ack per written seq + captured commands. */
function makeLib ({ acks = {}, status = null } = {}) {
  const cmds = []
  return {
    cmds,
    CliError,
    writeSyncCmd (cmd) { cmds.push(cmd); return cmds.length },
    waitForSyncAck: async seq => (seq in acks) ? acks[seq] : { ok: true, status },
    resolveTask: () => ({}),
  }
}

/** Capture console.log during fn(). */
async function captureLogs (fn) {
  const logs = []
  const orig = console.log
  console.log = (...a) => logs.push(a.join(' '))
  try { await fn() } finally { console.log = orig }
  return logs
}

test('sync status: plain output lists device/peers/lastRound; --json emits the status object', async () => {
  const st = {
    deviceName: 'desk', deviceId: 'd1', enabled: true, listening: true, port: 58471,
    pendingPair: { deviceName: 'lap', host: '192.168.0.9', deviceId: 'd2' },
    peers: [{ name: 'lap', deviceId: 'd2', host: '192.168.0.9', port: 58471, online: true, peerState: 'ready', pendingCount: 0, lastRoundAt: Date.now() }],
    lastRoundAt: Date.now(),
  }
  const lib = makeLib({ status: st })
  const logs = await captureLogs(() => runSync({ opts: { _: ['status'] }, lib, emit: null }))
  assert.ok(logs[0].includes('device: desk (d1)'))
  assert.ok(logs[0].includes('sync: enabled  listening: yes :58471'))
  assert.ok(logs[0].includes('pending pair request from lap (d2)'))
  assert.ok(logs[0].includes('peer: lap'))
  assert.ok(logs[0].includes('lastRound:'))

  const lib2 = makeLib({ status: st })
  const emitted = []
  await runSync({ opts: { _: ['status'], json: true }, lib: lib2, emit: v => emitted.push(v) })
  assert.deepEqual(emitted[0].deviceId, 'd1')
})

test('sync status: null ack → APP_NOT_RUNNING; !ok ack → SYNC_ERROR; empty peers → "(none)"', async () => {
  const lib = makeLib({ acks: { 1: null } })
  await assert.rejects(() => runSync({ opts: { _: ['status'] }, lib, emit: null }),
    e => e.code === 'APP_NOT_RUNNING' && /did not consume the command/.test(e.message))
  const lib2 = makeLib({ acks: { 1: { ok: false, error: 'boom' } } })
  await assert.rejects(() => runSync({ opts: { _: ['status'] }, lib: lib2, emit: null }),
    e => e.code === 'SYNC_ERROR')
  const lib3 = makeLib({ status: { deviceId: 'd1' } })
  const logs = await captureLogs(() => runSync({ opts: { _: ['status'] }, lib: lib3, emit: null }))
  assert.ok(logs[0].includes('peers: (none)'))
})

test('sync pair: missing host → USAGE; ok ack logs peers; json emits result; own pairing code is announced', async () => {
  const lib = makeLib()
  await assert.rejects(() => runSync({ opts: { _: ['pair'] }, lib, emit: null }), e => e.code === 'USAGE')
  const st = { peers: [{ name: 'lap', deviceId: 'd2', host: 'h', port: 1, online: false }] }
  const lib2 = makeLib({ acks: { 1: { ok: true, code: { code: '123456' } }, 2: { ok: true, status: st } } })
  const logs = await captureLogs(() => runSync({ opts: { _: ['pair'], host: 'h' }, lib: lib2, emit: null }))
  assert.ok(logs[0].includes('pairing code 123456'))
  assert.ok(logs[1].includes('✓ paired with h'))
  assert.ok(logs[2].includes('peer: lap'))
  const lib3 = makeLib({ acks: { 1: { ok: true, code: { code: '123456' } }, 2: { ok: true, status: st } } })
  const emitted = []
  await runSync({ opts: { _: ['pair'], host: 'h', port: 58471, json: true }, lib: lib3, emit: v => emitted.push(v) })
  assert.deepEqual(emitted[0], { paired: true, host: 'h', port: 58471, status: st })
})

test('sync pair: null ack → APP_NOT_RUNNING with timeout text; !ok → SYNC_ERROR', async () => {
  const lib = makeLib({ acks: { 2: null } })
  await assert.rejects(() => runSync({ opts: { _: ['pair'], host: 'h', timeout: 15 }, lib, emit: null }),
    e => e.code === 'APP_NOT_RUNNING' && /did not confirm within 15s/.test(e.message))
  const lib2 = makeLib({ acks: { 2: { ok: false, error: 'rejected' } } })
  await assert.rejects(() => runSync({ opts: { _: ['pair'], host: 'h' }, lib: lib2, emit: null }),
    e => e.code === 'SYNC_ERROR')
})

test('sync pair-respond: code must be 6 digits; accept/reject paths; json emit', async () => {
  const lib = makeLib()
  await assert.rejects(() => runSync({ opts: { _: ['pair-respond'], code: 'abc' }, lib, emit: null }),
    e => e.code === 'USAGE' && /6 digits/.test(e.message))
  const lib2 = makeLib({ acks: { 1: { ok: true, result: { peers: [{ name: 'p', deviceId: 'd', host: 'h', port: 2, online: true }] } } } })
  const logs = await captureLogs(() => runSync({ opts: { _: ['pair-respond'], code: '123456' }, lib: lib2, emit: null }))
  assert.ok(logs[0].includes('accepted'))
  assert.ok(logs[0].includes('code flow'))
  assert.deepEqual(lib2.cmds[0], { action: 'pair-respond', code: '123456', accept: true })
  const lib3 = makeLib({ acks: { 1: { ok: true } } })
  const logs3 = await captureLogs(() => runSync({ opts: { _: ['pair-respond'], reject: true }, lib: lib3, emit: null }))
  assert.ok(logs3[0].includes('rejected'))
  assert.deepEqual(lib3.cmds[0].accept, false)
  const lib4 = makeLib({ acks: { 1: { ok: true, result: { peers: [] } } } })
  const emitted = []
  await runSync({ opts: { _: ['pair-respond'], json: true }, lib: lib4, emit: v => emitted.push(v) })
  assert.deepEqual(emitted[0], { responded: true, accept: true, result: { peers: [] } })
})

test('sync unpair: missing device → USAGE; ok paths plain + json; unknown op → usage error', async () => {
  const lib = makeLib()
  await assert.rejects(() => runSync({ opts: { _: ['unpair'] }, lib, emit: null }), e => e.code === 'USAGE')
  const lib2 = makeLib()
  const logs = await captureLogs(() => runSync({ opts: { _: ['unpair'], device: 'd9' }, lib: lib2, emit: null }))
  assert.ok(logs[0].includes('✓ unpaired d9'))
  const lib3 = makeLib({ acks: { 1: { ok: true, result: { ok: 1 } } } })
  const emitted = []
  await runSync({ opts: { _: ['unpair'], device: 'd9', json: true }, lib: lib3, emit: v => emitted.push(v) })
  assert.deepEqual(emitted[0], { unpaired: 'd9', result: { ok: 1 } })
  await assert.rejects(() => runSync({ opts: { _: ['nonsense'] }, lib: makeLib(), emit: null }),
    e => e.code === 'USAGE' && /status\|enable.*pair/.test(e.message))
})

/* ---------- renderer/js/views/statistics/csv.js ---------- */

const { neutralizeCsvCell, csvField, buildExportRows } = require('../../../renderer/js/views/statistics/csv.js')

test('neutralizeCsvCell / csvField: formula prefixes are neutralized; quotes are doubled and wrapped', () => {
  assert.equal(neutralizeCsvCell('plain'), 'plain')
  assert.equal(neutralizeCsvCell(''), '')
  assert.equal(neutralizeCsvCell(null), '')
  for (const p of ['=cmd', '+1', '-1', '@x', '\tx', '\rx']) assert.equal(neutralizeCsvCell(p), "'" + p)
  assert.equal(csvField('a"b'), '"a""b"')
  assert.equal(csvField('=cmd'), '"\'=cmd"')
})

test('buildExportRows: KPI/baseline/narrative/series shape matches the review-export contract', () => {
  const t = k => k
  const m = {
    label: 'this week', done: 12, added: 9, planned: 20, doneRate: 0.6, focusMins: 130.5,
    tomatoCount: 14, giveUps: 1,
    doneByDay: [{ label: 'Mon', value: 2 }, { label: 'Tue', value: 4 }],
    focusByDay: [{ value: 25 }, null],
    baseline: { done: 10, doneRate: 0.5, focus: 90.25, giveUps: null },
  }
  const rows = buildExportRows(m, t, 'headline', ['insight one', 'insight two'])
  assert.deepEqual(rows[0], ['csvPeriod', 'this week'])
  assert.ok(rows.some(r => r[0] === 'kpiDone' && r[1] === 12 && r[2] === '10'))
  assert.ok(rows.some(r => r[0] === 'kpiRate' && r[1] === '60%' && r[2] === '50%'))
  assert.ok(rows.some(r => r[0] === 'csvFocusMins' && r[2] === '90.3')) // fractional baseline keeps 1 decimal
  assert.ok(rows.some(r => r[0] === 'kpiGiveup' && r[2] === '')) // null baseline → empty cell
  assert.deepEqual(rows.find(r => r[0] === 'csvNarrative'), ['csvNarrative'])
  assert.ok(rows.some(r => r[0] === 'Mon' && r[2] === 25))
  assert.ok(rows.some(r => r[0] === 'Tue' && r[2] === 0)) // null focus day → 0
  assert.ok(rows.filter(r => r[0] === 'insight one').length === 1)
})
