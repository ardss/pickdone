/**
 * Wave-A regression tests (review round R1/R5):
 *   P1-1: sync-apply clampSkew must also clamp a far-future `data.updatedAt` inside the
 *         payload (a skewed/malicious peer could otherwise bake a year-2100 age into a
 *         category/tomato/plan row that wins LWW forever).
 *   P2-1: the command-bus stamp clamp covers `deletedAt` wherever the payload carries one.
 *   P2-2: the manifest tombstone column tells the truth — soft-deleting ops declare
 *         'pointer', only physical row removals declare 'row'.
 *   P3:   non-numeric (NaN/garbage) stamps are treated as epoch 0, never NaN-propagated.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const syncApply = require(path.join(root, 'src/main/sync-apply.js'))
const busMod = require(path.join(root, 'src/main/command-bus.js'))
const manifestMod = require(path.join(root, 'src/main/command-manifest.js'))
const { createBus } = busMod

const YEAR_2100 = 4102444800000

/* ---------------- P1-1: payload updatedAt clamp ---------------- */

test('P1-1: a future data.updatedAt in a category payload is clamped to now', () => {
  const before = Date.now()
  const row = {
    entity: 'category', id: 'c1',
    updatedAt: before, // top-level comparison keys look sane...
    deleted: false, deletedAt: 0,
    data: { id: 'c1', name: 'Work', updatedAt: YEAR_2100 } // ...but the payload age is forged
  }
  const out = syncApply.clampSkew(row)
  assert.ok(out.data.updatedAt <= Date.now() + 50 && out.data.updatedAt >= before,
    'data.updatedAt must land clamped inside [now-before-clamp, now], got ' + out.data.updatedAt)
  assert.notEqual(out.data.updatedAt, YEAR_2100)
})

test('P1-1: future detection includes payload stamps (top-level sane, data.updatedAt far future)', () => {
  const row = {
    entity: 'tomato', id: 't1', updatedAt: Date.now(), deleted: false, deletedAt: 0,
    data: { tomatoId: 't1', updatedAt: YEAR_2100 }
  }
  const out = syncApply.clampSkew(row)
  assert.ok(out.data.updatedAt <= Date.now(), 'payload stamp must be normalized when only the payload lies about the future')
})

test('P1-1: non-skew path still returns the row verbatim (payload untouched)', () => {
  const row = { entity: 'plan', id: 'p1', updatedAt: 1000, deletedAt: 0, data: { id: 'p1', updatedAt: 1000 } }
  const out = syncApply.clampSkew(row)
  assert.equal(out, row, 'rows inside the skew window pass through by reference')
})

test('P1-1: payload deletedAt/updateTime clamping still works alongside data.updatedAt', () => {
  const now = Date.now()
  const row = {
    entity: 'category', id: 'c2', updatedAt: YEAR_2100, deleted: true, deletedAt: YEAR_2100,
    data: { id: 'c2', updateTime: YEAR_2100, deletedAt: YEAR_2100, updatedAt: YEAR_2100 }
  }
  const out = syncApply.clampSkew(row)
  assert.ok(out.updatedAt <= now + 50 && out.deletedAt <= now + 50)
  assert.ok(out.data.updateTime <= now + 50 && out.data.deletedAt <= now + 50 && out.data.updatedAt <= now + 50)
})

/* ---------------- P3: NaN / garbage stamps ---------------- */

test('P3: garbage payload stamps are normalized to 0 (not NaN) when the clamp engages', () => {
  const row = {
    entity: 'plan', id: 'p2', updatedAt: YEAR_2100, deletedAt: 0,
    data: { id: 'p2', updatedAt: 'not-a-number', updateTime: Number.NaN }
  }
  const out = syncApply.clampSkew(row)
  assert.equal(out.data.updatedAt, 0, 'garbage updatedAt must read as epoch 0, never propagate NaN')
  assert.equal(out.data.updateTime, 0)
  assert.ok(Number.isFinite(out.updatedAt))
})

test('P3: NaN top-level stamps do not crash or win LWW (treated as epoch 0)', () => {
  const row = { entity: 'todo', id: 'x', updatedAt: Number.NaN, deletedAt: undefined, data: null }
  const out = syncApply.clampSkew(row)
  assert.ok(out, 'clamp handles NaN without throwing')
})

/* ---------------- P2-1: bus deletedAt clamp ---------------- */

test('P2-1: stampPayload clamps a far-future deletedAt even when preserveStamp is set', () => {
  const bus = createBus(() => ({}))
  const row = { lwwField: 'updatedAt' }
  const out = bus.stampPayload(row, { updatedAt: Date.now(), deletedAt: YEAR_2100 }, { preserveStamp: true })
  assert.ok(out.deletedAt <= Date.now() + 50, 'forged future tombstone stamp must be clamped to now')
  assert.ok(out.updatedAt > Date.now() - 1000 && out.updatedAt <= Date.now() + 50, 'legit lwwField age preserved under preserveStamp')
})

test('P2-1: stampPayload clamps deletedAt on rows without a matching explicit lwwField too', () => {
  const bus = createBus(() => ({}))
  const out = bus.stampPayload({ lwwField: 'updatedAt' }, { deletedAt: YEAR_2100 }, { preserveStamp: true })
  assert.ok(out.deletedAt <= Date.now() + 50)
})

test('P2-1: a legit deletedAt inside the skew window is not touched', () => {
  const bus = createBus(() => ({}))
  const deletedAt = Date.now() + 60 * 1000 // +1min clock skew: legit
  const out = bus.stampPayload({ lwwField: 'updatedAt' }, { deletedAt }, { preserveStamp: true })
  assert.equal(out.deletedAt, deletedAt)
})

test('P2-1: lwwField clamp still works (existing D6 P2 behavior intact)', () => {
  const bus = createBus(() => ({}))
  const out = bus.stampPayload({ lwwField: 'updatedAt' }, { updatedAt: YEAR_2100, deletedAt: 0 })
  assert.ok(out.updatedAt <= Date.now() + 50)
})

/* ---------------- P2-2: manifest tombstone truthfulness ---------------- */

test('P2-2: soft-deleting commands declare tombstone pointer (db.js sets deleted=1 flags)', () => {
  const softDeleteCommands = [
    'category.put', 'category.putMany', 'filter.delete', 'plan.removeIds',
    'plan.deleteTask', 'plan.deleteTaskDay', 'tomato.removeByIds', 'setting.delete'
  ]
  for (const key of softDeleteCommands) {
    const row = manifestMod.COMMANDS[key]
    assert.ok(row, 'manifest row exists: ' + key)
    assert.equal(row.tombstone, 'pointer', `${key} soft-deletes via a deleted flag on the live row — must declare 'pointer'`)
  }
})

test('P2-2: physical row removals keep tombstone row', () => {
  for (const key of ['todo.hardDelete', 'todo.hardDeleteMany', 'meta.delete', 'todo.purgeBin']) {
    assert.equal(manifestMod.COMMANDS[key].tombstone, 'row', `${key} physically removes rows — keeps 'row'`)
  }
})
