/**
 * Bus-stamps fix round (2026-09-22) — regressions for the sharp-review bus-stamps findings:
 *   bus-1  the D6 future-stamp clamp covers the REAL age field: todo rows carry updateTime
 *          (manifest lwwField corrected) and tomato.updateById's age arrives inside
 *          payload.patch — forged future stamps in both places are clamped to local now
 *   bus-2  row-list payloads (todo.putMany arrays, todo.commitBatch { rows } envelopes) no
 *          longer bypass the bus clamp — every plain-object row is stamped/clamped
 *   bus-3  clampSkew normalizes data.updatedAt too (tomato/plan/filter/category hydrate their
 *          data as the RAW ROW carrying the same updatedAt the comparison key came from)
 *   bus-4  preserveStamp contract documented truthfully: it never MINTS a stamp, but an
 *          explicit future stamp is still clamped on every door
 * Pure bus/clamp instances — no electron, no db.
 * Run: node --test tests/unit/main/bus-stamps-fix-20260922.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const root = require_.resolve('../../../package.json')
const path = require_('path')
const busMod = require_('../../../src/main/command-bus.js')
const syncApply = require_('../../../src/main/sync-apply.js')

const FUTURE = 4102444800000 // 2100-01-01 — far beyond any legit clock skew
const SKEW = busMod.STAMP_SKEW_MS

function makeBus () {
  const calls = []
  const bus = busMod.createBus((op, params) => { calls.push({ op, params }); return { ok: true } })
  return { bus, calls }
}

test('bus-1: a forged future updateTime on todo.put is clamped (real age field, not updatedAt)', () => {
  const { bus, calls } = makeBus()
  bus.commit('todo', 'put', { taskId: 'x', updateTime: FUTURE })
  assert.equal(calls[0].op, 'upsert')
  assert.ok(Math.abs(calls[0].params.updateTime - Date.now()) < 5000,
    'future updateTime clamped to ~now, got ' + calls[0].params.updateTime)
  assert.notEqual(calls[0].params.updateTime, FUTURE)
  // input never mutated in place
})

test('bus-1: a forged future patch.updatedAt on tomato.updateById is clamped (nested patch)', () => {
  const { bus, calls } = makeBus()
  bus.commit('tomato', 'updateById', { tomatoId: 't1', patch: { endTime: '2100-01-01 00:00:00', updatedAt: FUTURE } })
  assert.equal(calls[0].op, 'tomatoUpdateById')
  assert.ok(Math.abs(calls[0].params.patch.updatedAt - Date.now()) < 5000,
    'patch.updatedAt clamped to ~now, got ' + calls[0].params.patch.updatedAt)
  assert.equal(calls[0].params.tomatoId, 't1', 'rest of the payload preserved')
})

test('bus-1: an in-window explicit stamp still survives verbatim on both shapes', () => {
  const { bus, calls } = makeBus()
  const peerAge = Date.now() + SKEW - 60000 // legit clock drift, inside the skew window
  bus.commit('todo', 'put', { taskId: 'a', updateTime: peerAge })
  assert.equal(calls[0].params.updateTime, peerAge)
  bus.commit('tomato', 'updateById', { tomatoId: 'b', patch: { updatedAt: peerAge } })
  assert.equal(calls[1].params.patch.updatedAt, peerAge)
})

test('bus-2: todo.putMany array rows can no longer smuggle future stamps past the bus', () => {
  const { bus, calls } = makeBus()
  bus.commit('todo', 'putMany', [{ taskId: 'y', updateTime: FUTURE }, { taskId: 'z', updateTime: 1234567890123 }])
  assert.equal(calls[0].op, 'upsertMany')
  assert.ok(Math.abs(calls[0].params[0].updateTime - Date.now()) < 5000, 'row 0 future stamp clamped')
  assert.equal(calls[0].params[1].updateTime, 1234567890123, 'row 1 legit age preserved')
})

test('bus-2: todo.commitBatch { rows } envelope rows are clamped, not the envelope', () => {
  const { bus, calls } = makeBus()
  bus.commit('todo', 'commitBatch', { rows: [{ taskId: 'w', updateTime: FUTURE }], version: 7 })
  assert.equal(calls[0].op, 'commitSyncBatch')
  assert.equal(calls[0].params.version, 7)
  assert.ok(Math.abs(calls[0].params.rows[0].updateTime - Date.now()) < 5000, 'envelope row clamped')
  assert.equal(calls[0].params.updateTime, undefined, 'envelope itself never stamped')
})

test('bus-3: clampSkew normalizes a future data.updatedAt (raw-row data shapes)', () => {
  const now = Date.now()
  const row = {
    entity: 'tomato', id: 'r1', updatedAt: now + SKEW + 1000, deletedAt: 0,
    data: { tomatoId: 'r1', endTime: 'x', updatedAt: now + SKEW + 1000 }
  }
  const out = syncApply.clampSkew(row)
  assert.ok(Math.abs(out.updatedAt - Date.now()) < 5000, 'comparison key clamped')
  assert.ok(Math.abs(out.data.updatedAt - Date.now()) < 5000,
    'data.updatedAt clamped — the flush path persists it verbatim (tomatoAppendMany)')
  assert.equal(row.data.updatedAt, now + SKEW + 1000, 'input row never mutated in place')
})

test('bus-3: clampSkew leaves in-window data.updatedAt verbatim (non-skew path intact)', () => {
  const age = 1234567890123
  const out = syncApply.clampSkew({ entity: 'plan', id: 'p1', updatedAt: age, deletedAt: 0, data: { id: 'p1', updatedAt: age } })
  assert.equal(out.updatedAt, age)
  assert.equal(out.data.updatedAt, age)
})

test('bus-4: preserveStamp never MINTS a stamp but a forged future age is STILL clamped (documented contract)', () => {
  const { bus, calls } = makeBus()
  bus.commit('setting', 'put', { key: 'k', value: 'v' }, { preserveStamp: true })
  assert.equal(calls[0].params.updatedAt, undefined, 'no fresh stamp minted')
  bus.commit('setting', 'put', { key: 'k2', value: 'v', updatedAt: FUTURE }, { preserveStamp: true })
  assert.ok(Math.abs(calls[1].params.updatedAt - Date.now()) < 5000, 'future stamp clamped even under preserveStamp')
})

test('manifest drift guard: todo commands declare updateTime, the column todoToRow actually binds', () => {
  const manifest = require_(path.dirname(root) + '/src/main/command-manifest.js')
  for (const key of ['todo.put', 'todo.putMany', 'todo.commitBatch', 'todo.bump']) {
    assert.equal(manifest.COMMANDS[key].lwwField, 'updateTime', key + ' lwwField')
  }
})
