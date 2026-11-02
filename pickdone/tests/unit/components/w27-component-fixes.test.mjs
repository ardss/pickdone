/**
 * [w27 P3 2026-11-01] component fixes round — source-level assertion paradigm (same as
 * f6-fixes.test.mjs / w1-depview-keyboard.test.mjs):
 *
 *   1. TomatoFocusRecordModal.vue — timeline segs carry a numeric uLeft and sort on it (the old
 *      a.left-b.left compared undefined-undefined=NaN, voiding the comparator so the 0-24h bar
 *      rendered in reverse data-source order); seg v-for uses the stable seg.tomatoId key.
 *   2. DepView.vue — projectInfo's today0 reads the store's todayTimestamp (reactive, flipped by
 *      the 60s setTodayTs tick) instead of a bare unreactive dayjs().
 *   3. StatisticsView.vue — the achievements computed registers the nowTick dependency so
 *      streak/today counters re-evaluate across midnight like the KPI tiles.
 *   4. WeatherWidget.vue — unmount tombstone (_dead) stops an in-flight fetch from re-entering
 *      fetchWeather via the finally block / retry chain after beforeUnmount.
 *
 * Run: node --test tests/unit/components/w27-component-fixes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')
const tfrVue = read('renderer/js/components/TomatoFocusRecordModal.vue')
const depVue = read('renderer/js/components/DepView.vue')
const statsVue = read('renderer/js/views/StatisticsView.vue')
const weatherVue = read('renderer/js/components/WeatherWidget.vue')

/* ---------------- 1. TomatoFocusRecordModal timeline segs ---------------- */

test('w27 tfr: timeline segs push a numeric uLeft and sort on it (not the nonexistent seg.left)', () => {
  const push = tfrVue.match(/segs\.push\(\{[\s\S]*?\}\)/)[0]
  assert.match(push, /uLeft,/, 'seg object must carry the numeric uLeft used for sorting')
  assert.match(tfrVue, /segs\.sort\(\(a, b\) => a\.uLeft - b\.uLeft\)/,
    'sort must use the carried numeric uLeft — a.left/b.left never existed (NaN comparator)')
  assert.ok(!tfrVue.includes('a.left - b.left'), 'the void NaN comparator must be gone')
})

test('w27 tfr: timeline seg v-for uses the stable seg.tomatoId key (not the index)', () => {
  assert.match(tfrVue, /v-for="seg in timeline\.segs" :key="seg\.tomatoId"/)
  assert.ok(!tfrVue.includes('v-for="(seg,i) in timeline.segs"'), 'index key removed')
})

/* ---------------- 2. DepView reactive today0 ---------------- */

test('w27 depview: projectInfo today0 reads store todayTimestamp (reactive midnight flip)', () => {
  const pi = depVue.match(/projectInfo \(\) \{[\s\S]*?\n {4}\},/)[0]
  assert.match(pi, /this\.\$store\.state\.todo\.todayTimestamp/,
    'today0 must depend on the reactive store todayTimestamp, not a bare dayjs()')
  assert.match(pi, /\|\| \+dayjs\(\)\.startOf\('day'\)/, 'dayjs kept only as an absent-value fallback')
})

/* ---------------- 3. StatisticsView achievements nowTick ---------------- */

test('w27 stats: achievements computed registers the nowTick dependency (same as metrics)', () => {
  const ach = statsVue.match(/achievements \(\) \{[\s\S]*?\n {4}\},/)[0]
  assert.match(ach, /void this\.nowTick/, 'achievements must re-evaluate on the nowTick timer')
})

/* ---------------- 4. WeatherWidget unmount tombstone ---------------- */

test('w27 weather: beforeUnmount sets the _dead tombstone; every fetchWeather re-entry checks it', () => {
  const unmount = weatherVue.match(/beforeUnmount \(\) \{[\s\S]*?\n {2}\},/)[0]
  assert.match(unmount, /this\._dead = true/, 'unmount must tombstone the widget')
  const fetch = weatherVue.match(/async fetchWeather \(\) \{[\s\S]*?return \/\/ re-entry guard/)[0]
  assert.match(fetch, /this\._dead/, 'fetchWeather entry must bail when dead')
  const retry = weatherVue.match(/this\._retryTimer = setTimeout\(\(\) => \{[\s\S]*?30 ?000\)/)[0]
  assert.match(retry, /!this\._dead/, 'retry chain must not re-enter after unmount')
  assert.match(weatherVue, /if \(this\._pendingFetch && !this\._dead\) \{/,
    'finally pendingFetch re-run must not re-enter after unmount')
  assert.match(weatherVue, /this\._dead = false/, 'a re-mounted instance must clear the tombstone')
})
