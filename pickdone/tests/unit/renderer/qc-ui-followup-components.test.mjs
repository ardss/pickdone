/**
 * QC follow-up round 3 (renderer components/utils) — behavior regression guards.
 * Fixes covered:
 *   [U-13] ViewMoreMenu calendar menu no longer opens with a leading separator
 *   [U-15] highlightHTML wraps the query match (TodoItem title highlighting)
 *   [U-16] DayDateStrip calMonth sync: calMonthFor resolves the popover month from the selected day
 *   [U-17] listenStopNoiseEvent wires 'tomato-stop-noise' to the player's stop
 *   [U-18] getMetaManyWithFallback: batch op consumed; absent/misaligned op falls back to the per-key loop
 *   [U-20] noisePlayer decoded cache is LRU-capped (13th entry evicts the oldest; hits refresh recency)
 * Run: node --test tests/unit/renderer/qc-ui-followup-components.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

/** Evaluate a "[component-fixes] pure-start/end" marked block from an SFC and return its functions */
function pureFns (file, names) {
  const src = read(file)
  const m = src.match(/\/\/ \[component-fixes\] pure-start[^\n]*\n([\s\S]*?)\/\/ \[component-fixes\] pure-end/)
  assert.ok(m, `${file}: pure block markers missing`)
  const dayjs = globalThis.window.dayjs
  const fn = new Function('dayjs', m[1] + `\nreturn { ${names.join(', ')} }`)
  return fn(dayjs)
}

const noisePlayer = await import('../../../renderer/js/utils/noisePlayer.js')
const core = await import('../../../renderer/js/utils/core.js')
const search = await import('../../../renderer/js/utils/search.js')

/* ---------- [U-13] ViewMoreMenu calendar menu: no leading separator ---------- */

test('[U-13] MENUS["todo-list-calendar"] first entry is a real item, not a separator', () => {
  const { MENUS } = pureFns('renderer/js/components/ViewMoreMenu.vue', ['MENUS'])
  const cal = MENUS['todo-list-calendar']
  assert.ok(Array.isArray(cal) && cal.length, 'calendar menu has entries')
  assert.equal(cal[0].sep, undefined, 'first entry is NOT a separator (used to open on a stray line)')
  assert.ok(cal[0].labelKey, 'first entry is a real menu item')
  // the other menus never regressed either
  for (const [route, items] of Object.entries(MENUS)) {
    assert.equal(items[0].sep, undefined, `${route} menu must not start with a separator`)
  }
})

/* ---------- [U-15] highlightHTML wraps the match ---------- */

test('[U-15] hl wraps the query match and escapes the rest (safe for v-html)', () => {
  const out = search.highlightHTML('hello world', 'world')
  assert.ok(out.includes('<span class="search-highlight">world</span>'), 'the match is wrapped')
  assert.ok(out.startsWith('hello '), 'the non-matching prefix is untouched')
  const evil = search.highlightHTML('<img src=x onerror=alert(1)>', 'img')
  assert.ok(!evil.includes('<img'), 'HTML-looking content stays escaped')
  assert.equal(search.highlightHTML('plain', ''), 'plain', 'empty query → unchanged text')
})

test('[U-15] TodoItem renders the highlight when the query prop is set', () => {
  const src = read('renderer/js/components/TodoItem.vue')
  assert.ok(src.includes('<span v-if="query" v-html="highlightedTitle">'), 'title uses v-html only under a non-empty query')
  assert.ok(src.includes('highlightHTML('), 'the highlight util is wired into the component')
})

/* ---------- [U-16] DayDateStrip calMonth sync ---------- */

test('[U-16] calMonthFor resolves the popover month from the selected day (month-cross safe)', () => {
  const { calMonthFor } = pureFns('renderer/js/components/DayDateStrip.vue', ['calMonthFor'])
  // a day near a month boundary: the week strip can show next-month days after an arrow shift
  const ts = globalThis.window.dayjs('2026-03-01').startOf('day').valueOf()
  assert.equal(calMonthFor(ts), '2026-03', 'popover month follows the selected day, not a stale month')
  const ts2 = globalThis.window.dayjs('2026-12-31').startOf('day').valueOf()
  assert.equal(calMonthFor(ts2), '2026-12', 'year boundary handled')
  // the open-watcher actually syncs through the helper
  const src = read('renderer/js/components/DayDateStrip.vue')
  assert.ok(src.includes('this.calMonth = calMonthFor(this.selectedTs)'), 'popover open syncs calMonth to the selected day')
})

/* ---------- [U-17] stop-noise event wiring ---------- */

test('[U-17] dispatching tomato-stop-noise stops the player', () => {
  const listeners = {}
  const fakeTarget = { addEventListener: (name, fn) => { listeners[name] = fn } }
  noisePlayer.listenStopNoiseEvent(fakeTarget)
  assert.ok(typeof listeners['tomato-stop-noise'] === 'function', 'the event handler is registered')
  // inject a live source through the test seam, then dispatch the event: the handler must stop it
  const { setCurrent, getCurrent } = noisePlayer._testInternals
  const stopped = []
  setCurrent({ src: { stop: () => stopped.push('stop') }, gain: { gain: { value: .5 } }, key: 'k' })
  listeners['tomato-stop-noise']()
  assert.deepEqual(stopped, ['stop'], 'the live source was stopped')
  assert.equal(getCurrent(), null, 'the playing slot is cleared (noise stopped)')
})

/* ---------- [U-18] getMetaManyWithFallback ---------- */

test('[U-18] batch op is consumed when present; per-key loop is the fallback', async () => {
  const savedTodoAPI = globalThis.window.todoAPI
  try {
    // 1) batch op present: ONE call, aligned values returned
    let batchCalls = 0
    globalThis.window.todoAPI = {
      getMetaMany: async keys => { batchCalls++; return keys.map(k => ({ key: k, value: k === 'a' ? '1' : null })) },
      dbCall: async () => { throw new Error('per-key loop must not run when the batch op exists') }
    }
    assert.deepEqual(await core.getMetaManyWithFallback(['a', 'b']), ['1', null], 'aligned values from the batch op')
    assert.equal(batchCalls, 1, 'exactly one batch IPC')
    // 2) op absent: falls back to the per-key loop
    globalThis.window.todoAPI = { dbCall: async (op, k) => (op === 'getMeta' && k === 'a' ? 'x' : null) }
    assert.deepEqual(await core.getMetaManyWithFallback(['a', 'b']), ['x', null], 'fallback loop returns per-key values')
    // 3) op present but MISALIGNED length → fallback, never a wrong mapping
    globalThis.window.todoAPI = { getMetaMany: async () => [{ key: 'a', value: 'wrong' }], dbCall: async (op, k) => (k === 'a' ? 'right' : null) }
    assert.deepEqual(await core.getMetaManyWithFallback(['a', 'b']), ['right', null], 'misaligned batch response falls back')
    // 4) batch op throws → fallback
    globalThis.window.todoAPI = { getMetaMany: async () => { throw new Error('ipc down') }, dbCall: async (op, k) => (k === 'a' ? 'ok' : null) }
    assert.deepEqual(await core.getMetaManyWithFallback(['a']), ['ok'], 'batch failure falls back')
  } finally {
    globalThis.window.todoAPI = savedTodoAPI
  }
})

test('[U-18] consumers use the shared helper (category flag union + auth delta fold)', () => {
  assert.ok(read('renderer/js/store/category.js').includes('getMetaManyWithFallback(rows.map(r => projectFlagKey(r.categoryId)))'),
    'category init batches the flag reads')
  assert.ok(read('renderer/js/store/auth.js').includes('await getMetaManyWithFallback(keys)'),
    'auth gamification fold batches the delta reads')
})

/* ---------- [U-20] decoded cache LRU cap ---------- */

test('[U-20] the 13th decoded entry evicts the oldest; a cache hit refreshes recency', () => {
  const { decoded, MAX_DECODED, cacheDecoded } = noisePlayer._testInternals
  decoded.clear()
  const buf = i => ({ id: i })
  for (let i = 1; i <= MAX_DECODED; i++) cacheDecoded('k' + i, buf(i))
  assert.equal(decoded.size, MAX_DECODED, 'at cap')
  // touch k1 (oldest) through the cache seam — like getBuffer's hit path does
  const hit = decoded.get('k1')
  cacheDecoded('k1', hit)
  assert.equal(hit.id, 1, 'hit returns the cached buffer')
  cacheDecoded('k-new', buf(99))
  assert.equal(decoded.size, MAX_DECODED, 'cap holds after insert')
  assert.equal(decoded.has('k1'), true, 'touched k1 survived (recency refreshed)')
  assert.equal(decoded.has('k2'), false, 'untouched oldest (k2) was evicted')
  assert.equal(decoded.get('k-new').id, 99, 'the new entry is cached')
  decoded.clear()
})
