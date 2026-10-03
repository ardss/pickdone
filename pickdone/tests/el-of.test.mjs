import { test } from 'node:test'
import assert from 'node:assert/strict'
import { $elOf } from '../renderer/js/utils/el.js'

// Class contract: any component ref resolving to a host Element must go through
// $elOf — it returns the element itself for element nodes, the parent element for
// comment/text nodes ($el may be a comment under Element Plus), and null when the
// ref renders nothing usable. Callers may then querySelector without a typeof guard.

test('$elOf returns the element for an element-node $el', () => {
  const el = { nodeType: 1, querySelector: () => 'input' }
  assert.equal($elOf({ $el: el }), el)
})

test('$elOf falls back to parentElement for a comment/text node', () => {
  const parent = { querySelector: () => 'input' }
  assert.equal($elOf({ $el: { nodeType: 8, parentElement: parent } }), parent)
  assert.equal($elOf({ $el: { nodeType: 3, parentElement: parent } }), parent)
})

test('$elOf returns null for unusable refs', () => {
  assert.equal($elOf(undefined), null)
  assert.equal($elOf(null), null)
  assert.equal($elOf({}), null)
  assert.equal($elOf({ $el: null }), null)
  assert.equal($elOf({ $el: { nodeType: 8, parentElement: null } }), null)
})
