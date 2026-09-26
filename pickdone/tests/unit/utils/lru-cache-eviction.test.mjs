/**
 * round3-startup-perf-15: pinyinCache / _subtasksCache in renderer/js/utils/core.js must
 * evict LRU (oldest-inserted) at the 5000 cap instead of wholesale clear().
 *
 * Why it matters: SearchView's `matched` computed calls matchText -> toPinyinLower per
 * Chinese field for the ENTIRE todoList on every keystroke. With the old clear(), the first
 * distinct string past the cap dropped all ~5000 hot entries, so the following keystroke
 * synchronously recomputed every conversion on the UI thread (repeating jank cliff).
 *
 * Behavior-preservation contract: toPinyinLower output for every key is IDENTICAL before and
 * after eviction; only the eviction victim changes (and re-queried keys stay cached).
 * Run: node --test tests/unit/utils/lru-cache-eviction.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// Wrap the pinyin-pro UMD global BEFORE importing core.js — core.js captures the function
// reference at module load, so this counting spy sees every real conversion attempt.
let pinyinCalls = 0
const realPinyin = globalThis.window.pinyinPro.pinyin
globalThis.window.pinyinPro.pinyin = (...a) => { pinyinCalls++; return realPinyin(...a) }

// Same trick for _subtasksCache: count JSON.parse invocations (the cache's reason to exist).
let parseCalls = 0
const realParse = JSON.parse
JSON.parse = (...a) => { parseCalls++; return realParse(...a) }

const { toPinyinLower, parseSubtasks } = await import('../../../renderer/js/utils/core.js')

test('toPinyinLower: an entry re-queried before the cap survives bulk insertion (no wholesale clear)', () => {
  // warm the hot entry
  const hot = '任务热键'
  const hotBefore = toPinyinLower(hot)
  const callsAfterWarm = pinyinCalls
  assert.equal(toPinyinLower(hot), hotBefore)
  assert.equal(pinyinCalls, callsAfterWarm, 'second query is served from cache')

  // re-touch the hot entry MID-bulk (marks it most-recent), then finish the 5001-key bulk.
  // LRU: only the 2001 oldest of the mid-bulk keys are evicted — the touched entry survives.
  // wholesale clear(): the cap crossing drops EVERYTHING, including the just-touched entry.
  assert.equal(toPinyinLower(hot), hotBefore)
  for (let i = 0; i < 3000; i++) toPinyinLower(`条目${i}号`)
  assert.equal(toPinyinLower(hot), hotBefore)
  for (let i = 3000; i < 5001; i++) toPinyinLower(`条目${i}号`)

  assert.equal(toPinyinLower(hot), hotBefore)
  assert.equal(pinyinCalls - callsAfterWarm, 5001, 'exactly the 5001 new keys are computed; the recently-used entry is served from cache')
})

test('toPinyinLower: output identical after eviction; recently inserted keys stay cached (zero recomputes)', () => {
  const bulk = []
  for (let i = 0; i < 5001; i++) bulk.push(`溢出键${i}`)
  const before = bulk.map(toPinyinLower)
  // the tail of the bulk is the most-recent set — LRU must keep all of it cached
  const c0 = pinyinCalls
  assert.deepEqual(bulk.slice(-100).map(toPinyinLower), before.slice(-100), 'outputs identical')
  assert.equal(pinyinCalls - c0, 0, 'the 100 most-recent keys are served from cache — clear() would recompute all 100')
})

test('parseSubtasks: a re-queried entry survives bulk insertion (no wholesale clear, fewer re-parses)', () => {
  const hot = JSON.stringify([{ title: '热条目', done: false }])
  parseSubtasks(hot)
  const c0 = parseCalls
  parseSubtasks(hot)
  assert.equal(parseCalls, c0, 'second query is served from cache')

  // re-touch mid-bulk, then finish — LRU keeps the touched entry; clear() drops it
  parseSubtasks(hot)
  for (let i = 0; i < 3000; i++) parseSubtasks(JSON.stringify([{ title: `填充${i}` }]))
  parseSubtasks(hot)
  for (let i = 3000; i < 5001; i++) parseSubtasks(JSON.stringify([{ title: `填充${i}` }]))

  parseSubtasks(hot)
  assert.equal(parseCalls - c0, 5001, 'exactly the 5001 new keys are parsed; the touched entry is served from cache')
  // per-item shallow clone contract preserved
  const rows = parseSubtasks(hot)
  assert.deepEqual(rows, [{ title: '热条目', done: false }])
  rows[0].done = true
  assert.deepEqual(parseSubtasks(hot), [{ title: '热条目', done: false }], 'clones still handed out, cache not corruptible')
})
