/**
 * A11Y keyboard-activation helpers (maint/deep-r2 wave, 2026-10-02; maint/d26 Space-contract update).
 * Unit coverage for the shared handler factories in renderer/js/utils/roleButtonKey.js:
 *   - roleButtonActivate  (role=button spans accept Enter; Space is owned by the main.js
 *                          document-level capture handler — see the ownership contract comment
 *                          in roleButtonKey.js for why the helper must NOT also activate on Space)
 *   - roleCheckboxActivate (role=checkbox spans accept Enter + stopPropagation; Space ditto)
 *   - roleRadioActivate    (A2/A6: roving-tabindex radiogroup arrows + Space/Enter — the radio
 *                          role is NOT covered by the main.js capture handler, so Space stays here)
 * Template migrations are locked by source-anchor assertions at the bottom.
 * Run: node --test tests/unit/renderer/fix-a11y-key-activation.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { roleButtonActivate, roleCheckboxActivate, roleRadioActivate } from '../../../renderer/js/utils/roleButtonKey.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

/** Fake key event recording preventDefault/stopPropagation calls */
function mkKey (key) {
  return {
    key,
    currentTarget: null,
    prevented: false,
    stopped: false,
    preventDefault () { this.prevented = true },
    stopPropagation () { this.stopped = true }
  }
}

/* ===== roleButtonActivate ===== */

test('roleButtonActivate: fires on Enter ONLY, honors preventDefault, ignores other keys', () => {
  let calls = 0
  const handler = roleButtonActivate(function () { calls++; assert.equal(this.marker, 'ctx') })
  const ctx = { marker: 'ctx' }
  const enter = mkKey('Enter')
  handler.call(ctx, enter)
  assert.equal(calls, 1)
  assert.equal(enter.prevented, true, 'Enter must preventDefault (default scroll/submit suppression)')
  // [maint/d26] Space is owned by the main.js document-level capture handler (t.click()); the
  // helper must NOT also activate, or the two toggles cancel out (double-activation regression)
  const space = mkKey(' ')
  handler.call(ctx, space)
  assert.equal(calls, 1, 'Space must NOT activate here (main.js capture handler owns it)')
  assert.equal(space.prevented, false, 'Space must not be consumed by the helper')
  for (const k of ['a', 'Escape', 'Tab', 'ArrowDown', 'EnterShift']) handler.call(ctx, mkKey(k))
  assert.equal(calls, 1, 'no activation for non-activation keys')
})

test('roleButtonActivate: default does NOT stop propagation; { stop: true } does', () => {
  let calls = 0
  const plain = roleButtonActivate(function () { calls++ })
  const e1 = mkKey('Enter')
  plain.call({}, e1)
  assert.equal(e1.stopped, false, 'existing consumers keep their no-stop semantics')
  const stopping = roleButtonActivate(function () { calls++ }, { stop: true })
  const e2 = mkKey('Enter')
  stopping.call({}, e2)
  assert.equal(calls, 2)
  assert.equal(e2.stopped, true)
  assert.equal(e2.prevented, true)
})

/* ===== roleCheckboxActivate ===== */

test('roleCheckboxActivate: Enter toggles ONLY, other keys (incl. Space) do nothing', () => {
  let calls = 0
  const handler = roleCheckboxActivate(function () { calls++; assert.equal(this.marker, 'self') })
  const ctx = { marker: 'self' }
  handler.call(ctx, mkKey('Enter'))
  assert.equal(calls, 1)
  // [maint/d26] Space toggling here canceled the main.js capture handler's click() (net zero);
  // Space stays with the capture handler, the helper handles Enter only
  handler.call(ctx, mkKey(' '))
  assert.equal(calls, 1, 'Space must NOT toggle here (main.js capture handler owns it)')
  for (const k of ['a', 'Escape', 'Tab', 'ArrowUp']) handler.call(ctx, mkKey(k))
  assert.equal(calls, 1)
})

test('roleCheckboxActivate: Enter prevents default and stops propagation (nested-in-row toggles)', () => {
  const handler = roleCheckboxActivate(function () {})
  const e = mkKey('Enter')
  handler.call({}, e)
  assert.equal(e.prevented, true, 'Enter must be consumed')
  assert.equal(e.stopped, true, 'Enter must not reach the wrapping row\'s activation')
  const space = mkKey(' ')
  handler.call({}, space)
  assert.equal(space.prevented, false, 'Space must not be consumed by the helper')
  assert.equal(space.stopped, false, 'Space must keep propagating (the capture handler listens on document)')
})

/* ===== roleRadioActivate ===== */

/** Fake radiogroup DOM: radios know their group + siblings so closest/querySelectorAll/focus work */
function fakeRadio (name, group) {
  const el = {
    name,
    focused: false,
    focus () { this.focused = true },
    getAttribute (attr) { return attr === 'data-key' ? this.name : null },
    closest (sel) { return sel === '[role="radiogroup"]' ? group : null }
  }
  return el
}
function fakeGroup (names) {
  const radios = []
  const group = {
    radios,
    querySelectorAll () { return radios }
  }
  for (const name of names) radios.push(fakeRadio(name, group))
  return { group, radios }
}

test('roleRadioActivate: Space/Enter select the focused radio, other keys are ignored', () => {
  const { radios } = fakeGroup(['day', 'week'])
  let selected = null
  const handler = roleRadioActivate(function (el) { selected = el; assert.equal(this.marker, 'comp') })
  const ctx = { marker: 'comp' }
  const e = mkKey(' ')
  e.currentTarget = radios[0]
  handler.call(ctx, e)
  assert.equal(selected, radios[0])
  assert.equal(e.prevented, true)
  const e2 = mkKey('Enter')
  e2.currentTarget = radios[1]
  handler.call(ctx, e2)
  assert.equal(selected, radios[1])
  assert.equal(e2.prevented, true)
  const e3 = mkKey('Home')
  e3.currentTarget = radios[0]
  handler.call(ctx, e3)
  assert.equal(selected, radios[1], 'non-mapped keys are no-ops')
})

test('roleRadioActivate: arrows move focus AND select, wrapping at both ends', () => {
  const { radios } = fakeGroup(['a', 'b', 'c'])
  let selected = null
  const handler = roleRadioActivate(el => { selected = el })

  const down = mkKey('ArrowDown'); down.currentTarget = radios[0]
  handler.call({}, down)
  assert.equal(radios[1].focused, true, 'ArrowDown focuses the next radio')
  assert.equal(selected, radios[1], 'ArrowDown also selects it (roving-tabindex radiogroup)')
  assert.equal(down.prevented, true)

  const right = mkKey('ArrowRight'); right.currentTarget = radios[1]
  handler.call({}, right)
  assert.equal(selected, radios[2])

  const rightWrap = mkKey('ArrowRight'); rightWrap.currentTarget = radios[2]
  handler.call({}, rightWrap)
  assert.equal(selected, radios[0], 'ArrowDown/Right wraps past the last radio')

  const up = mkKey('ArrowUp'); up.currentTarget = radios[0]
  handler.call({}, up)
  assert.equal(selected, radios[2], 'ArrowUp wraps back to the last radio')

  const left = mkKey('ArrowLeft'); left.currentTarget = radios[2]
  handler.call({}, left)
  assert.equal(selected, radios[1])
  assert.equal(left.prevented, true)
})

test('roleRadioActivate: element outside a radiogroup never navigates on arrows', () => {
  const lone = fakeRadio('solo', null)
  let selected = null
  const handler = roleRadioActivate(el => { selected = el })
  const e = mkKey('ArrowDown')
  e.currentTarget = lone
  handler.call({}, e)
  assert.equal(selected, null, 'no group -> no neighbor, selection unchanged')
  assert.equal(e.prevented, true, 'the arrow is still consumed so the page does not scroll')
})

/* ===== Source-anchor locks: every listed site routes through the shared helpers ===== */

const sites = [
  // A8 checkbox sites (roleCheckboxActivate)
  ['renderer/js/components/TodoItem.vue', /@keydown="onCheckKey"/, 'td-check'],
  ['renderer/js/components/TodoItem.vue', /@keydown="onSubKey\(s, \$event\)"/, 'td-sub'],
  ['renderer/js/views/HabitView.vue', /@keydown="onCheckKey\(h, \$event\)"/, 'habit-check'],
  ['renderer/js/components/MatrixGrid.vue', /@keydown="onCheckKey\(t, \$event\)"/, 'matrix td-check'],
  ['renderer/js/components/DayDeck.vue', /@keydown="onCheckKey\(t, \$event\)"/, 'deck checkboxes (both lists share the anchor)'],
  ['renderer/js/views/RecycleBinView.vue', /@keydown="onCheckKey\(t, \$event\)"/, 'recycle td-check'],
  // A9 button sites (roleButtonActivate)
  ['renderer/js/views/SearchView.vue', /@keydown="onClearKey"/, 'search clear chip'],
  ['renderer/js/views/TodayView.vue', /@keydown="onProjTriggerKey"/, 'project filter trigger'],
  ['renderer/js/views/TodoBoxView.vue', /@keydown="onTriggerKey"/, 'todo box dropdown triggers (x3 share the anchor)'],
  ['renderer/js/views/ProjectOverviewView.vue', /@keydown="onStatusKey\(p, \$event\)"/, 'project status pill'],
  ['renderer/js/views/StatisticsView.vue', /@keydown="onRangeActivateKey"/, 'custom-range trigger'],
  ['renderer/js/components/QuickAdd.vue', /@keydown="onClearDateKey"/, 'quick-add date chip'],
  // A2/A6 radiogroups
  ['renderer/js/views/StatisticsView.vue', /:tabindex="period===p\.key \? 0 : -1"/, 'period pill roving tabindex'],
  ['renderer/js/views/StatisticsView.vue', /@keydown="onPeriodRadioKey"/, 'period pill arrow handler'],
  ['renderer/js/views/StatisticsView.vue', /:tabindex="heatRange===r\.key \? 0 : -1"/, 'heatmap range roving tabindex'],
  ['renderer/js/views/StatisticsView.vue', /@keydown="onHeatRadioKey"/, 'heatmap range arrow handler'],
  // A10 dropdown trigger state
  ['renderer/js/views/TodoBoxView.vue', /aria-haspopup="listbox" :aria-expanded="openDd === 'sort' \? 'true' : 'false'"/, 'sort trigger state'],
  ['renderer/js/views/TodoBoxView.vue', /aria-haspopup="listbox" :aria-expanded="openDd === 'order' \? 'true' : 'false'"/, 'order trigger state'],
  ['renderer/js/views/TodoBoxView.vue', /aria-haspopup="listbox" :aria-expanded="openDd === 'cat' \? 'true' : 'false'"/, 'category trigger state']
]

for (const [file, anchor, label] of sites) {
  test(`anchor: ${label} (${file})`, () => {
    assert.match(read(file), anchor)
  })
}

test('A7: TodoBoxView and FilterView rows no longer carry role=button (demoted to the content)', () => {
  for (const f of ['renderer/js/views/TodoBoxView.vue', 'renderer/js/views/FilterView.vue']) {
    const src = read(f)
    // The row div keeps its focus/keys but must not announce itself as a button
    assert.doesNotMatch(src, /class="todo-box-list-item"[\s\S]{0,200}role="button"/, `${f}: row demoted`)
    // The content is the reachable button carrying the task name
    assert.match(src, /todo-box-list-item__content" role="button" tabindex="0" :aria-label="t\.taskContent"/, `${f}: content promoted`)
  }
})

test('no hand-rolled Enter-only checkbox/button bindings remain in the migrated files', () => {
  for (const f of [
    'renderer/js/components/TodoItem.vue',
    'renderer/js/components/MatrixGrid.vue',
    'renderer/js/components/DayDeck.vue',
    'renderer/js/views/HabitView.vue',
    'renderer/js/views/RecycleBinView.vue',
    'renderer/js/views/TodoBoxView.vue',
    'renderer/js/views/FilterView.vue'
  ]) {
    const src = read(f)
    assert.doesNotMatch(src, /@keydown\.enter\.prevent(?:\.stop)?="(?:onCheckClick|toggleSub|check|completeTask|toggle|toggleComplete|completeItem)\(/, `${f}: no Enter-only checkbox bindings left`)
  }
})
