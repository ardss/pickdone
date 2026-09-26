/**
 * Round-3 perf (startup-perf-finding-2): undo history snapshots moved from a whole-table
 * JSON.stringify per HISTORY_ACTION to a per-row fragment cache (renderer/js/store/helpers/
 * snapshotString.js), wired into store/index.js's subscribeAction before-hook and
 * deleteTodosMany's pre-batch snapshot.
 *
 * Guards:
 *   [1] byte-identical output vs the old `JSON.stringify({ todoList, recycleList })` across
 *       randomized add / edit / complete / soft-delete / restore / reorder sequences
 *   [2] O(changed rows) serialization: only rows whose updateTime/version changed are re-stringified
 *   [3] in-place mutation invalidation — both store write shapes:
 *         (a) normal writes bump updateTime (upsertLocal Object.assign of a merged row)
 *         (b) syncTodos stamps status+version IN PLACE without bumping updateTime
 *   [4] undo roundtrip: parse(snapshot) deep-equals the live state, and the string stays
 *       withEpoch-compatible (ends with `}` so undo.js's suffix splice keeps working)
 *   [5] string-length invariant: undo.js's byte budget accounts on snapRaw.length, which must
 *       equal the old whole-table stringify length (covered exactly by [1])
 *
 * Run: node --test test/store-snapshot-string.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { snapshotString } from '../renderer/js/store/helpers/snapshotString.js'

let idSeq = 0
const mkRow = patch => ({
  taskId: 'tid-' + (++idSeq),
  taskContent: 'task ' + idSeq,
  dayStart: 0,
  todoTime: 0,
  complete: false,
  delete: false,
  updateTime: 1000 + idSeq,
  version: 0,
  status: 'add',
  ...patch
})

/* ---------- [1] byte-identical across randomized op sequences ---------- */
test('snapshotString is byte-identical to whole-table JSON.stringify across random op sequences', () => {
  // Deterministic PRNG (mulberry32) so the sequence is reproducible
  let seed = 0x12345678
  const rnd = () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  let todoList = []
  let recycleList = []
  let clock = 5000
  const edit = row => {
    // mirrors upsertLocal's Object.assign(list[i], merged) — in-place write, updateTime bumped
    clock += 7
    Object.assign(row, {
      taskContent: row.taskContent + '*',
      updateTime: clock,
      status: 'update'
    })
  }
  for (let step = 0; step < 500; step++) {
    const roll = rnd()
    if (roll < 0.25) {
      clock += 3
      todoList.push(mkRow({ updateTime: clock, dayStart: rnd() < 0.5 ? 86400000 * Math.floor(rnd() * 5) : 0 }))
    } else if (roll < 0.45 && todoList.length) {
      edit(todoList[Math.floor(rnd() * todoList.length)])
    } else if (roll < 0.55 && todoList.length) {
      edit(todoList[Math.floor(rnd() * todoList.length)]) // toggle-complete via updateTodoFields shape
    } else if (roll < 0.65 && todoList.length) {
      const i = Math.floor(rnd() * todoList.length)
      clock += 3
      const [row] = todoList.splice(i, 1)
      Object.assign(row, { delete: true, updateTime: clock, status: 'delete', version: 0 })
      recycleList.push(row)
    } else if (roll < 0.75 && recycleList.length) {
      const i = Math.floor(rnd() * recycleList.length)
      clock += 3
      const [row] = recycleList.splice(i, 1)
      Object.assign(row, { delete: false, updateTime: clock, status: 'update' })
      todoList.push(row)
    } else if (roll < 0.85 && todoList.length > 1) {
      // reorder: swap two rows (reorderTodos bumps taskSort + updateTime on replaced objects)
      const a = Math.floor(rnd() * todoList.length)
      const b = Math.floor(rnd() * todoList.length)
      ;[todoList[a], todoList[b]] = [todoList[b], todoList[a]]
      clock += 3
      todoList[a] = { ...todoList[a], taskSort: rnd() * 1000, updateTime: clock }
      todoList[b] = { ...todoList[b], taskSort: rnd() * 1000, updateTime: clock }
    } else if (roll < 0.9 && recycleList.length) {
      recycleList.splice(Math.floor(rnd() * recycleList.length), 1) // purge
    }
    const got = snapshotString(todoList, recycleList)
    const want = JSON.stringify({ todoList, recycleList })
    assert.equal(got, want, `step ${step}: snapshot diverged from whole-table stringify`)
    assert.equal(got.length, want.length, 'byte budget (snapRaw.length) must match exactly')
  }
})

test('empty lists serialize exactly like JSON.stringify', () => {
  assert.equal(snapshotString([], []), '{"todoList":[],"recycleList":[]}')
})

/* ---------- [2] O(changed rows): only changed rows are re-stringified ---------- */
test('unchanged rows reuse cached fragments — only the changed row is serialized', () => {
  const todoList = Array.from({ length: 300 }, () => mkRow({}))
  const recycleList = [mkRow({ delete: true })]
  snapshotString(todoList, recycleList) // warm the cache

  const rowCalls = []
  const origStringify = JSON.stringify
  JSON.stringify = function counting (v, r, s) {
    if (v && typeof v === 'object' && !Array.isArray(v) && 'taskId' in v) rowCalls.push(v.taskId)
    return origStringify.call(JSON, v, r, s)
  }
  try {
    // one edit burst: bump one row's updateTime in place (the 350ms-debounced save shape)
    const victim = todoList[150]
    victim.taskContent = 'edited'
    victim.updateTime += 1
    const out = snapshotString(todoList, recycleList)
    assert.deepEqual(rowCalls, [victim.taskId],
      'a 1-row edit must re-stringify exactly 1 row, not the whole 301-row table')
    // output still equals the fresh whole-table stringify
    assert.equal(out, origStringify({ todoList, recycleList }))
  } finally {
    JSON.stringify = origStringify
  }
})

/* ---------- [3] in-place mutation invalidation (both store write shapes) ---------- */
test('in-place updateTime bump invalidates the fragment', () => {
  const row = mkRow({})
  const before = snapshotString([row], [])
  row.taskContent = 'changed without identity change'
  row.updateTime += 5
  const after = snapshotString([row], [])
  assert.notEqual(before, after)
  assert.ok(after.includes('changed without identity change'))
  assert.equal(after, JSON.stringify({ todoList: [row], recycleList: [] }))
})

test('in-place syncTodos ack (status+version, no updateTime bump) invalidates the fragment', () => {
  const row = mkRow({})
  snapshotString([row], [])
  // mirrors syncTodos' finally-mark loop: t.status = 'sync'; t.version = serverV (in place)
  row.status = 'sync'
  row.version = 42
  const after = snapshotString([row], [])
  assert.ok(after.includes('"version":42'), 'version stamp must appear in the snapshot')
  assert.ok(after.includes('"status":"sync"'))
  assert.equal(after, JSON.stringify({ todoList: [row], recycleList: [] }))
})

/* ---------- [4] undo roundtrip + withEpoch compatibility ---------- */
test('snapshot parses back to the exact live state and stays withEpoch-compatible', () => {
  const todoList = Array.from({ length: 5 }, () => mkRow({ subtasks: JSON.stringify([{ t: 1 }]) }))
  const recycleList = [mkRow({ delete: true })]
  const raw = snapshotString(todoList, recycleList)
  const parsed = JSON.parse(raw)
  assert.deepEqual(parsed, { todoList, recycleList })
  // undo.js withEpoch does snapRaw.slice(0, -1) + ',"_e":N}' — requires a trailing '}'
  assert.ok(raw.endsWith('}'))
  const tagged = JSON.parse(raw.slice(0, -1) + ',"_e":3}')
  assert.equal(tagged._e, 3)
  assert.equal(tagged.todoList.length, 5)
})
