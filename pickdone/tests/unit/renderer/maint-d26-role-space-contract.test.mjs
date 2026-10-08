/**
 * [maint/d26] Role-element Space ownership contract.
 *
 * Root fix for the double-activation regression: the document-level capture-phase Space
 * handler in renderer/js/main.js dispatches t.click() on role-bearing elements, and the SAME
 * event then bubbles to the element's own @keydown handler bound via roleButtonActivate /
 * roleCheckboxActivate. When the helpers also activated on Space, each press toggled twice
 * and canceled out (task checkbox, subtasks, EditPanel rows, habit check-ins, ...).
 * Contract: the capture handler owns Space; the helpers own Enter only.
 *
 * The executing test extracts the real capture handler callback from main.js source and runs
 * a capture->bubble simulation against a fake role=checkbox target, asserting a Space press
 * activates EXACTLY ONCE (and that the pre-fix double activation would have been caught).
 *
 * Run: node --test tests/unit/renderer/maint-d26-role-space-contract.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

import { roleButtonActivate, roleCheckboxActivate } from '../../../renderer/js/utils/roleButtonKey.js'

/** Extract the document-level capture handler callback source out of main.js and evaluate it */
function loadCaptureHandler () {
  const src = read('renderer/js/main.js')
  const m = src.match(/document\.addEventListener\('keydown', (\([\s\S]*?\}), true\)/)
  assert.ok(m, 'main.js: document keydown capture handler not found')
  return new Function(`return ${m[1]}`)()
}

/** Fake role=checkbox target: click() models the Vue @click binding (the activation path) */
function fakeTarget (role = 'checkbox') {
  const t = {
    tagName: 'SPAN',
    isContentEditable: false,
    clicks: 0,
    getAttribute (attr) { return attr === 'role' ? role : null },
    click () { this.clicks++ }
  }
  return t
}

function fakeEvent (target) {
  return {
    key: ' ',
    ctrlKey: false, altKey: false, metaKey: false, repeat: false,
    target,
    prevented: false, stopped: false,
    preventDefault () { this.prevented = true },
    stopPropagation () { this.stopped = true }
  }
}

test('capture handler exists and covers role=checkbox/button with the click() path', () => {
  const handler = loadCaptureHandler()
  const t = fakeTarget('checkbox')
  const e = fakeEvent(t)
  handler(e)
  assert.equal(t.clicks, 1, 'capture handler activates via click()')
  assert.equal(e.prevented, true, 'page scroll suppressed')
})

test('[root regression] Space on a role=checkbox activates EXACTLY ONCE (capture + helper)', () => {
  const capture = loadCaptureHandler()
  // What the element's own keydown binding runs when the same bubbled event arrives
  const toggles = []
  const elHandler = roleCheckboxActivate(function () { toggles.push(1) })
  const t = fakeTarget()
  const e = fakeEvent(t)
  capture(e) // phase 1: document capture handler
  elHandler.call({}, e) // phase 2: element @keydown handler sees the same event
  assert.equal(t.clicks, 1, 'capture handler clicked exactly once')
  assert.equal(toggles.length, 0, 'helper must not re-activate on the Space the capture handler consumed')
})

test('[root regression] Space on a role=button activates EXACTLY ONCE (capture + helper)', () => {
  const capture = loadCaptureHandler()
  let activations = 0
  const elHandler = roleButtonActivate(function () { activations++ })
  const t = fakeTarget('button')
  const e = fakeEvent(t)
  capture(e)
  elHandler.call({}, e)
  assert.equal(activations + t.clicks, 1, 'one press, one activation — the old code produced two, netting zero for toggles')
})

test('Enter still activates through the helper (Space contract must not eat Enter)', () => {
  let calls = 0
  const btn = roleButtonActivate(function () { calls++ })
  const chk = roleCheckboxActivate(function () { calls++ })
  btn.call({}, { key: 'Enter', preventDefault () {}, stopPropagation () {} })
  chk.call({}, { key: 'Enter', preventDefault () {}, stopPropagation () {} })
  assert.equal(calls, 2, 'Enter activation preserved for both helpers')
})

test('source anchors: helpers document the ownership contract; main.js handler unchanged', () => {
  const helperSrc = read('renderer/js/utils/roleButtonKey.js')
  assert.match(helperSrc, /ENTER ONLY/, 'helper doc comment states Enter-only ownership')
  assert.match(helperSrc, /capture-phase/, 'helper doc names the main.js capture handler as the Space owner')
  const mainSrc = read('renderer/js/main.js')
  assert.match(mainSrc, /must NOT also bind @keydown\.space/, 'main.js warning about double-binding stays in place')
})
