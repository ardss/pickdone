/* w29 P3 regression: SearchView unmount race baked a half-typed keyword into the global search.
 *
 * Bug: beforeUnmount FLUSHED the pending debounced keystroke (`commit('todo/setSearch', qText)`).
 * Navigating away mid-typing (before the 180ms debounce fired) committed a fragment like "mee"
 * as the global search state — every other view inherited the stale filter, with results that
 * looked arbitrarily filtered.
 *
 * Fix: teardown only CANCELS the pending debounce and drops the un-executed tail (the input
 * buffer reverts to the last CONFIRMED store value). A search the debounced watcher already
 * committed during the visit IS confirmed and survives; only the never-executed tail is lost.
 *
 * The hook is exercised exactly as Vue would call it, bound to a stub `this` carrying the same
 * instance fields the component uses — asserting user-visible state (the store's search value),
 * not internals.
 *
 * Run: node --test tests/unit/components/w29-searchview-unmount-race.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const SFC_PATH = path.join(ROOT, 'renderer/js/views/SearchView.vue')

/** Extract the beforeUnmount method from the SFC and compile it standalone (brace-matched). */
function loadBeforeUnmount () {
  const src = fs.readFileSync(SFC_PATH, 'utf8')
  const start = src.indexOf('beforeUnmount (')
  assert.ok(start > 0, 'beforeUnmount hook found in SearchView.vue')
  const open = src.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break } }
  }
  assert.ok(end > 0, 'beforeUnmount body brace-matched')
  const body = src.slice(start, end + 1)
  return new Function(`return { ${body} }`).call(null).beforeUnmount
}

const beforeUnmount = loadBeforeUnmount()

function makeVm ({ storeSearch, qText, pendingTimer }) {
  const commits = []
  const vm = {
    qText,
    _qTimer: pendingTimer ? 123 : null, // truthy = a debounce is pending
    _dayCheckTimer: null,
    $store: {
      state: { todo: { search: storeSearch } },
      commit (mut, payload) { commits.push({ mut, payload }) }
    }
  }
  return { vm, commits }
}

test('P3: unmounting with a PENDING debounce does NOT commit the half-typed fragment', () => {
  const { vm, commits } = makeVm({ storeSearch: 'prev', qText: 'mee', pendingTimer: true })
  beforeUnmount.call(vm)
  assert.equal(commits.length, 0, 'no setSearch commit on teardown — the fragment is dropped')
  assert.equal(vm.$store.state.todo.search, 'prev', 'the store keeps the last confirmed value')
  assert.equal(vm.qText, 'prev', 'the input buffer reverts to the confirmed value')
  assert.equal(vm._qTimer, null, 'the pending debounce is cancelled')
})

test('P3: unmounting with NO pending debounce (search already confirmed by the watcher) leaves the store alone', () => {
  const { vm, commits } = makeVm({ storeSearch: 'confirmed query', qText: 'confirmed query', pendingTimer: false })
  beforeUnmount.call(vm)
  assert.equal(commits.length, 0, 'no redundant commit')
  assert.equal(vm.$store.state.todo.search, 'confirmed query', 'an executed search survives unmount')
})

test('P3: teardown never re-introduces the OLD flush path (commit of qText)', () => {
  const src = fs.readFileSync(SFC_PATH, 'utf8')
  const start = src.indexOf('beforeUnmount (')
  const end = src.indexOf('watch:', start)
  const hook = src.slice(start, end)
  assert.ok(!hook.includes("commit('todo/setSearch'"), 'beforeUnmount must not commit setSearch (the flush race)')
  assert.match(hook, /clearTimeout\(this\._qTimer\)/, 'the pending debounce must still be cancelled')
})
