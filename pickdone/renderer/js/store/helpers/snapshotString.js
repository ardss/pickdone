/**
 * Whole-table snapshot serializer with per-row fragment caching.
 *
 * Round-3 perf (startup-perf-finding-2): the undo before-hook (store/index.js) used to
 * JSON.stringify the ENTIRE todoList + recycleList on every HISTORY_ACTION (each 350ms-debounced
 * EditPanel save, each checkbox click) — ~1MB per push at thousand-task scale on the UI thread,
 * even when the 400ms merge window (undo.js historyPush) discards the stack growth, the
 * serialization cost was still paid in full.
 *
 * Fix: cache each row's JSON fragment in a WeakMap keyed by row-object identity, invalidated by
 * the store's write invariant — every row write bumps `updateTime` (updateTodoFields/addTodo/
 * deleteTodo/reorderTodos all stamp it; undo.js:203 relies on the same invariant for diffing).
 * `version` is part of the key too: syncTodos stamps `t.status`/`t.version` IN PLACE without
 * bumping updateTime (store/todo.js syncTodos finally-mark loop), so a row whose sync ack landed
 * would otherwise serve a stale fragment.
 *
 * Output is byte-identical to `JSON.stringify({ todoList, recycleList })`: deterministic
 * JSON.stringify per row, assembled in array order with the same separators (no spaces), so
 * undo.js's string-length byte accounting (HISTORY_BYTES budget) and the `withEpoch` suffix
 * splice (which assumes the snapshot ends with `}`) are untouched.
 *
 * PRECONDITION (documented invariant, guarded by tests): a row's serialized content only changes
 * together with `updateTime` (normal writes replace the row object via upsertLocal) or with an
 * in-place `version` stamp (syncTodos ack). A mutation that edits a row in place without touching
 * either would serve a stale fragment — do not add such writes.
 */

const fragCache = new WeakMap() // row object -> { key, json }

function rowKey (t) {
  return (t.updateTime || 0) + '|' + (t.version || 0)
}

function rowFragment (t) {
  const key = rowKey(t)
  const hit = fragCache.get(t)
  if (hit && hit.key === key) return hit.json
  const json = JSON.stringify(t)
  fragCache.set(t, { key, json })
  return json
}

/** Byte-identical equivalent of `JSON.stringify({ todoList, recycleList })` with per-row caching. */
export function snapshotString (todoList, recycleList) {
  let out = '{"todoList":['
  for (let i = 0; i < todoList.length; i++) {
    if (i) out += ','
    out += rowFragment(todoList[i])
  }
  out += '],"recycleList":['
  for (let i = 0; i < recycleList.length; i++) {
    if (i) out += ','
    out += rowFragment(recycleList[i])
  }
  return out + ']}'
}
