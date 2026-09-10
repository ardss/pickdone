import { test } from 'node:test'
import assert from 'node:assert/strict'

// Regression for the 2026-09-10 nav-gate restructure:
// - today-x previously had NO module switch of its own (developerMode was the only gate),
//   so users with developer mode left on from experiment reviews saw the Today Lab entry
//   permanently in the sidebar with no way to hide it short of dropping developer mode.
// - A same-day attempt to graduate projects onto its own switch alone was REVERTED by user
//   verdict (the module is still experimental): all of habit/projects/today-x stay under the
//   developer-mode master gate, each with its own module switch on top.
import { visibleNavRoutes } from '../renderer/js/utils/nav-gate.js'

const ORDER = ['todo-list-today', 'todo-list-today-x', 'todo-list-habit', 'todo-list-projects', 'todo-list-stats']
const nav = (st) => visibleNavRoutes(st, ORDER)

test('developer mode off hides every experimental entry regardless of module switches', () => {
  assert.deepEqual(nav({ developerMode: false, showTodayXModule: true, showHabitModule: true, showProjectsModule: false }),
    ['todo-list-today', 'todo-list-stats'])
})

test('today-x requires BOTH the master gate and its own module switch (two-layer doctrine)', () => {
  assert.ok(!nav({ developerMode: true, showTodayXModule: false }).includes('todo-list-today-x'),
    'developer mode alone must NOT surface today-x anymore')
  assert.ok(!nav({ developerMode: false, showTodayXModule: true }).includes('todo-list-today-x'))
  assert.ok(nav({ developerMode: true, showTodayXModule: true }).includes('todo-list-today-x'))
})

test('projects keeps the two-layer gate — graduation was reverted (module still experimental)', () => {
  assert.ok(!nav({ developerMode: false, showProjectsModule: true }).includes('todo-list-projects'),
    'projects must NOT survive developerMode=false')
  assert.ok(nav({ developerMode: true, showProjectsModule: true }).includes('todo-list-projects'))
  assert.ok(!nav({ developerMode: true, showProjectsModule: false }).includes('todo-list-projects'))
})

test('habit keeps the two-layer gate; missing/undefined switches read as off', () => {
  assert.ok(!nav({ developerMode: true }).includes('todo-list-habit'))
  assert.ok(nav({ developerMode: true, showHabitModule: true }).includes('todo-list-habit'))
  assert.ok(!nav({}).includes('todo-list-today-x'))
  assert.ok(!nav({}).includes('todo-list-habit'))
  assert.ok(!nav({}).includes('todo-list-projects'))
})
