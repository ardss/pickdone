/**
 * [win-bind RED] Geometry gate — pure predicate deciding whether a dragend release
 * happened OUTSIDE the current window (window-binding intent) or inside (plain
 * reorder semantics, unchanged behavior).
 *
 * Contract (T8): isReleaseOutsideViewport(pt, win) compares event.screenX/Y against
 * window.screenX/outerWidth/outerHeight — one CSS-pixel space including multi-monitor
 * negative coordinates, no DIP/physical conversion.
 *
 * Run: node --test --test-force-exit tests/unit/renderer/win-bind/winbind-geometry.test.mjs
 */
import '../../../setup.mjs'
import { test } from '../../../pilot/runner-shim.mjs'
import assert from 'node:assert/strict'

const { isReleaseOutsideViewport, isCompletedDragRelease, isRejectedDropRelease } = await import('../../../../renderer/js/utils/winbindGeometry.js')

const WIN = { screenX: 100, screenY: 200, outerWidth: 800, outerHeight: 600 } // spans x[100,900] y[200,800]

test('inside release (center) is NOT outside — reorder semantics preserved', () => {
  assert.equal(isReleaseOutsideViewport({ screenX: 500, screenY: 500 }, WIN), false)
})

test('all four edges and corners count as INSIDE (inclusive bounds)', () => {
  assert.equal(isReleaseOutsideViewport({ screenX: 100, screenY: 200 }, WIN), false, 'top-left corner')
  assert.equal(isReleaseOutsideViewport({ screenX: 900, screenY: 800 }, WIN), false, 'bottom-right corner')
  assert.equal(isReleaseOutsideViewport({ screenX: 100, screenY: 500 }, WIN), false, 'left edge')
  assert.equal(isReleaseOutsideViewport({ screenX: 900, screenY: 500 }, WIN), false, 'right edge')
  assert.equal(isReleaseOutsideViewport({ screenX: 500, screenY: 200 }, WIN), false, 'top edge')
  assert.equal(isReleaseOutsideViewport({ screenX: 500, screenY: 800 }, WIN), false, 'bottom edge')
})

test('one pixel beyond each edge IS outside', () => {
  assert.equal(isReleaseOutsideViewport({ screenX: 99, screenY: 500 }, WIN), true, 'left')
  assert.equal(isReleaseOutsideViewport({ screenX: 901, screenY: 500 }, WIN), true, 'right')
  assert.equal(isReleaseOutsideViewport({ screenX: 500, screenY: 199 }, WIN), true, 'top')
  assert.equal(isReleaseOutsideViewport({ screenX: 500, screenY: 801 }, WIN), true, 'bottom')
})

test('multi-monitor negative coordinates share the same single coordinate space', () => {
  // secondary monitor left of primary: window fully in negative screen space
  const winNeg = { screenX: -1920, screenY: 0, outerWidth: 1280, outerHeight: 720 } // x[-1920,-640]
  assert.equal(isReleaseOutsideViewport({ screenX: -1900, screenY: 300 }, winNeg), false, 'inside neg monitor')
  assert.equal(isReleaseOutsideViewport({ screenX: -1930, screenY: 300 }, winNeg), true, 'left of neg monitor')
  assert.equal(isReleaseOutsideViewport({ screenX: 0, screenY: 300 }, winNeg), true, 'back on primary = outside this window')
})

test('non-finite or missing coordinates never claim outside (fail-closed: no accidental bind)', () => {
  assert.equal(isReleaseOutsideViewport({ screenX: NaN, screenY: 500 }, WIN), false)
  assert.equal(isReleaseOutsideViewport({ screenX: 500, screenY: undefined }, WIN), false)
  assert.equal(isReleaseOutsideViewport({}, WIN), false)
  assert.equal(isReleaseOutsideViewport(null, WIN), false)
  // a degenerate window object must not fabricate an "outside" verdict either
  assert.equal(isReleaseOutsideViewport({ screenX: 500, screenY: 500 }, null), false)
  assert.equal(isReleaseOutsideViewport({ screenX: 500, screenY: 500 }, {}), false)
  assert.equal(isReleaseOutsideViewport({ screenX: Infinity, screenY: 500 }, WIN), false)
})

/* [QA r1 #3] accepted-release gate: dragend.dropEffect 'move' = the OLE target under the cursor
 * accepted the text/move offer → dispatch immediately. */
test('isCompletedDragRelease: move = accepted release, none = not accepted (fail-closed)', () => {
  assert.equal(isCompletedDragRelease({ dataTransfer: { dropEffect: 'move' } }), true, 'outside release reports move')
  assert.equal(isCompletedDragRelease({ dataTransfer: { dropEffect: 'none' } }), false, 'Esc-cancel reports none')
  // fail-closed: missing/odd shapes never claim completion
  assert.equal(isCompletedDragRelease({}), false)
  assert.equal(isCompletedDragRelease(null), false)
  assert.equal(isCompletedDragRelease({ dataTransfer: null }), false)
  assert.equal(isCompletedDragRelease({ dataTransfer: { dropEffect: undefined } }), false)
  assert.equal(isCompletedDragRelease({ dataTransfer: { dropEffect: 'copy' } }), false, 'foreign-accepted copy also fails closed')
  assert.equal(isCompletedDragRelease({ dataTransfer: { dropEffect: 'link' } }), false)
})

/* [QA r1-P1] rejected-release gate: dropEffect 'none' is NOT only the Esc cancel — it is
 * negotiated with the release-point OLE target, so a REAL release onto a target that refuses
 * text/move (measured live: mspaint) reports 'none' too. The predicate flags the case; the
 * cancelled-vs-completed split is TodoItem's Escape-key evidence + the store's re-check window
 * (this event object alone cannot decide it — that is the whole point of the fix). */
test('isRejectedDropRelease: none = the ambiguous case (rejected release OR Esc-cancel), anything else false', () => {
  assert.equal(isRejectedDropRelease({ dataTransfer: { dropEffect: 'none' } }), true, 'mspaint-style rejected release / Esc cancel')
  assert.equal(isRejectedDropRelease({ dataTransfer: { dropEffect: 'move' } }), false, 'accepted release is NOT rejected')
  // fail-closed on odd shapes: never flag what is not a clear 'none'
  assert.equal(isRejectedDropRelease({}), false)
  assert.equal(isRejectedDropRelease(null), false)
  assert.equal(isRejectedDropRelease({ dataTransfer: null }), false)
  assert.equal(isRejectedDropRelease({ dataTransfer: { dropEffect: undefined } }), false)
  assert.equal(isRejectedDropRelease({ dataTransfer: { dropEffect: 'copy' } }), false)
  assert.equal(isRejectedDropRelease({ dataTransfer: { dropEffect: 'link' } }), false)
})

/* The two predicates partition the dropEffect space: exactly one of them fires for any well-formed
 * dragend, none for a malformed one. */
test('isCompletedDragRelease and isRejectedDropRelease are mutually exclusive', () => {
  for (const eff of ['move', 'none', 'copy', 'link', undefined]) {
    const e = { dataTransfer: { dropEffect: eff } }
    assert.ok(!(isCompletedDragRelease(e) && isRejectedDropRelease(e)), 'both fired for dropEffect=' + eff)
  }
})
