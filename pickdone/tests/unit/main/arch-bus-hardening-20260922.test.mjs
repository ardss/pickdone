/**
 * Arch review 2026-09-22 (adversarial report) — regression tests for the 5 recommendations:
 *   R1 twin-door convergence: sync-apply's flush/ingress writes route through an injected
 *      hookless bus (busWrite → bus.commitOp preserveStamp) — payload-verbatim, manifest-validated.
 *   R2 manifest expressiveness: capture column declares oplog suppression (todo.commitBatch);
 *      meta.put/meta.delete lwwField is null (the bus can never reshape a meta payload).
 *   R3 unified stamp clamp: ONE shared constant imported by BOTH doors.
 *   R5 ls-mirror observability: a failed notifySyncChange kick is counted/deferred and retried.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const busMod = require(path.join(root, 'src/main/command-bus.js'))
const syncApply = require(path.join(root, 'src/main/sync-apply.js'))
const manifestMod = require(path.join(root, 'src/main/command-manifest.js'))
const shared = require(path.join(root, 'src/main/handlers/shared.js'))
const { createBus } = busMod

/* ---------------- R3: unified stamp clamp ---------------- */

test('R3: command-bus and sync-apply share ONE stamp-clamp constant (10min) and both import it', () => {
  const { STAMP_CLAMP_MS } = require(path.join(root, 'src/main/stamp-clamp.js'))
  assert.equal(STAMP_CLAMP_MS, 10 * 60 * 1000)
  assert.equal(busMod.STAMP_SKEW_MS, STAMP_CLAMP_MS, 'bus door aliases the shared constant')
  for (const rel of ['src/main/command-bus.js', 'src/main/sync-apply.js']) {
    const src = readFileSync(path.join(root, rel), 'utf8')
    assert.match(src, /require\(['"]\.\/stamp-clamp['"]\)/, rel + ' must import the shared constant')
    assert.doesNotMatch(src, /=\s*(5|10)\s*\*\s*60\s*\*\s*1000/, rel + ' must not hand-roll the window')
  }
})

test('R3: sync-apply clampSkew uses the same window as the bus clamp (boundary semantics intact)', () => {
  const realNow = Date.now
  const t = realNow()
  Date.now = () => t
  try {
    const edge = t + busMod.STAMP_SKEW_MS
    const notClamped = syncApply.clampSkew({ updatedAt: edge, deletedAt: 0 })
    assert.equal(notClamped.updatedAt, edge, 'exactly now+window is NOT clamped (strict >)')
    const clamped = syncApply.clampSkew({ updatedAt: edge + 1, deletedAt: 0 })
    assert.equal(clamped.updatedAt, t, 'one ms past the window clamps to now')
  } finally { Date.now = realNow }
})

/* ---------------- R1: twin-door convergence (injected ingress bus) ---------------- */

function mockState (tables = {}) {
  const calls = []
  const state = {
    db: {
      calls,
      call (op, params) {
        calls.push({ op, params })
        if (tables[op]) return tables[op](params)
        return null
      },
    },
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
  }
  return { state, calls }
}

test('R1: busWrite dispatches through the injected bus with payload VERBATIM (preserveStamp)', () => {
  const { state, calls } = mockState()
  // Array payload (setMeta pair) passes through unreshaped — the bus must NOT re-stamp or clone it.
  syncApply.busWrite(state, 'setMeta', ['k', 'v'])
  assert.deepEqual(calls, [{ op: 'setMeta', params: ['k', 'v'] }])
  // Plain-object payload with NO age: preserveStamp keeps it unstamped (the db layer owns the stamp).
  syncApply.busWrite(state, 'settingsRowDelete', { key: 'sync.x' })
  assert.deepEqual(calls[1], { op: 'settingsRowDelete', params: { key: 'sync.x' } })
  // A manifest-unknown op THROWS (the raw db.call accepted anything — the bus is stricter).
  assert.throws(() => syncApply.busWrite(state, 'notAnOp', {}))
})

test('R1: busFor caches one hookless bus per state — the global bus fanout does NOT fire on ingress', () => {
  const { state } = mockState()
  const b1 = syncApply.busFor(state)
  const b2 = syncApply.busFor(state)
  assert.equal(b1, b2, 'one bus per state object')
  assert.notEqual(b1, require(path.join(root, 'src/main/command-bus.js')), 'NOT the global bus instance')
  let hooks = 0
  // the ls-mirror/undo-barrier subscribers live on the GLOBAL bus (registered by registerIpc);
  // ingress writes through the injected instance must never fire them.
  const off = require(path.join(root, 'src/main/command-bus.js')).onCommit('arch-probe', () => { hooks++ })
  try {
    syncApply.busWrite(state, 'setMeta', ['k', 'v'])
    assert.equal(hooks, 0, 'global-bus fanout does not observe injected-instance commits')
  } finally { off() }
})

test('R1: flushPendingWrites still lands buffered rows through the SAME recorded db surface', () => {
  const { state, calls } = mockState()
  state.pendingWrites.todos.push({ taskId: 't1', taskContent: 'x', updateTime: 5 })
  state.pendingWrites.settings.push({ key: 'theme', value: '"dark"', updatedAt: 5 })
  const r = syncApply.flushPendingWrites(state)
  assert.equal(r.ok, true)
  const ops = calls.map(c => c.op)
  assert.ok(ops.includes('upsertMany') && ops.includes('settingsRowPutMany'), 'bulk ops dispatched (manifest-routed, same op names)')
  assert.deepEqual(state.pendingWrites.todos, [], 'buffer cleared')
})

/* ---------------- R2: manifest expressiveness ---------------- */

test('R2: todo.commitBatch declares capture suppression; capture enum is validated', () => {
  const row = manifestMod.COMMANDS['todo.commitBatch']
  assert.equal(row.capture, 'none', 'the sync-ack echo path mints no oplog rows (db.call skips capture)')
  const VALID = new Set([undefined, 'oplog', 'none', 'gc'])
  for (const [k, r] of Object.entries(manifestMod.COMMANDS)) {
    assert.ok(VALID.has(r.capture), 'manifest ' + k + ' capture invalid: ' + r.capture)
  }
})

test('R2: meta.put/meta.delete lwwField is null — the bus can never stamp a meta payload', () => {
  assert.equal(manifestMod.COMMANDS['meta.put'].lwwField, null)
  assert.equal(manifestMod.COMMANDS['meta.delete'].lwwField, null)
  // Even a plain-object payload (abuse shape) passes through the meta door VERBATIM.
  const b = createBus((op, p) => ({ op, p }))
  const out = b.commit('meta', 'put', { key: 'k', value: 'v' })
  assert.deepEqual(out, { op: 'setMeta', p: { key: 'k', value: 'v' } }, 'no updatedAt injected')
})

test('R2: a bus-stamped age on a bump payload cannot tamper with the ledger', () => {
  // bumpSnow's db impl destructures only { taskId, minutes, dedupKey } and stamps the row's
  // updatedAt itself — asserted here at the contract level: the bus MAY stamp the payload,
  // but the payload's age field is not part of bumpSnow's write surface (documented in the
  // manifest row; the db impl re-stamps with its own now).
  const manifestRow = manifestMod.COMMANDS['todo.bump']
  const dbSrc = readFileSync(path.join(root, 'src/main/db.js'), 'utf8')
  const impl = dbSrc.match(/bumpSnow:\s*\(\{\s*taskId, minutes, dedupKey[\s\S]{0,200}/)
  assert.ok(impl, 'bumpSnow impl found')
  assert.ok(!impl[0].includes('updatedAt'), 'bumpSnow destructures no updatedAt from the payload')
  // Bus-stamps fix (2026-09-22): lwwField is 'updateTime' — the todo row's real age column.
  assert.equal(manifestRow.lwwField, 'updateTime', 'bus still clamps forged explicit stamps (defense in depth)')
})

/* ---------------- R5: ls-mirror kick observability ---------------- */

test('R5: a failed notifySyncChange kick is deferred and retried (next kick + short timer)', async () => {
  let fails = 4
  const kicks = []
  const timers = []
  const kick = shared.makeSyncKick(op => {
    if (fails > 0) { fails--; throw new Error('sync pipeline busy') }
    kicks.push(op)
  }, {
    timerMs: 5,
    setTimeout: (fn, ms) => { timers.push(fn); return { unref () {} } },
    clearTimeout: () => {},
  })
  kick.kick('setMeta') // fails → deferred, timer armed
  assert.equal(kicks.length, 0)
  assert.equal(timers.length, 1, 'a retry timer is armed')
  kick.kick('settingsRowPut') // first retries the lost 'setMeta' (fails again, re-queued), then the new op also fails
  assert.equal(kicks.length, 0)
  timers[0]() // timer fires: retry setMeta → still failing (fails=0 now? no: fails=0 → success)
  assert.equal(fails, 0)
  // drain remaining timer retries
  for (const t of timers.slice(1)) t()
  await new Promise(r => setTimeout(r, 20))
  assert.ok(kicks.includes('setMeta') || kicks.includes('settingsRowPut'), 'the lost kick eventually lands: ' + kicks.join(','))
  assert.ok(kick.deferredCount >= 1, 'failures are COUNTED for observability')
})

test('R5: a healthy kick path is unchanged (notify called synchronously, no timer)', () => {
  const kicks = []
  const kick = shared.makeSyncKick(op => kicks.push(op), {
    setTimeout: () => { assert.fail('no timer on the happy path'); return { unref () {} } },
    clearTimeout: () => {},
  })
  kick.kick('deleteMeta')
  assert.deepEqual(kicks, ['deleteMeta'])
})
