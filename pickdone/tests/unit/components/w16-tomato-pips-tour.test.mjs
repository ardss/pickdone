/**
 * W16 P2 regression (2026-10-28) — TomatoBar pips onboarding must fire on a REAL 0→1 jump.
 *
 * Bug: `_prevTodayDone` was never initialized. On the first completion of the day the watcher
 * saw prev===undefined, which the `prev !== 0` guard blocked; every later completion was then
 * blocked by `todayDone < 1`. Net effect: the spotlight tour fired only on the
 * "complete -> undo -> complete again" loop, never on a genuine first tomato.
 *
 * Fix: mounted() seeds `_prevTodayDone` with the current count, so the watcher's first real
 * transition (0 -> 1) carries prev===0 and passes the guard.
 *
 * Run: node --test tests/unit/components/w16-tomato-pips-tour.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const src = fs.readFileSync(path.join(ROOT, 'renderer/js/components/TomatoBar.vue'), 'utf8')

// Load the component options (dynamic import of onboardingTours swapped for an injectable stub)
function loadComponent (tours) {
  const m = src.match(/<script[^>]*>([\s\S]*?)<\/script>/)
  assert.ok(m, 'TomatoBar.vue: <script> block not found')
  const code = m[1]
    .replace(/^\s*import[\s\S]*?from\s+'[^']+'\s*(\/\/[^\n]*)?$/mg, '')
    .replace(/import\('\.\.\/utils\/onboardingTours\.js'\)/, 'Promise.resolve(tours)')
    .replace(/\bas\s+any\b/g, '')
    .replace(/export\s+default\s*\{/, 'return {')
  return new Function('tours', 'roleButtonActivate', code)(tours, fn => fn)
}

const tick = () => new Promise(r => setTimeout(r, 850)) // maybePipsTour defers runTour by 800ms

function makeInstance (tours, seededDone) {
  const comp = loadComponent(tours)
  const inst = {
    todayDone: seededDone,
    _pipsTourDone: false,
    ...comp.methods
  }
  // Mirror mounted()'s seed line — the fix under test
  assert.ok(comp.mounted.toString().includes('this._prevTodayDone = this.todayDone'),
    'mounted must seed _prevTodayDone with the current count')
  inst._prevTodayDone = inst.todayDone
  return inst
}

test('W16: a genuine 0→1 first-completion jump pops the pips tour', async () => {
  const run = []
  const tours = { tourSeenState: () => ({ pips: false }), runTour: name => run.push(name) }
  const inst = makeInstance(tours, 0)
  inst.todayDone = 1 // the watch fires on the real transition
  inst.maybePipsTour()
  await tick(); await tick(); await tick()
  assert.deepEqual(run, ['pips'], 'first-ever completion in-session must trigger the tour')
  assert.equal(inst._pipsTourDone, true)
})

test('W16: users starting the session with existing completions get no popup (guard kept)', async () => {
  const run = []
  const tours = { tourSeenState: () => ({ pips: false }), runTour: name => run.push(name) }
  const inst = makeInstance(tours, 3)
  inst.todayDone = 4
  inst.maybePipsTour()
  await tick(); await tick(); await tick()
  assert.deepEqual(run, [], 'a 3→4 jump (no 0→1 transition) must not pop the tour')
})

test('W16: an already-seen pips tour never pops again', async () => {
  const run = []
  const tours = { tourSeenState: () => ({ pips: true }), runTour: name => run.push(name) }
  const inst = makeInstance(tours, 0)
  inst.todayDone = 1
  inst.maybePipsTour()
  await tick(); await tick(); await tick()
  assert.deepEqual(run, [])
  assert.equal(inst._pipsTourDone, true)
})
