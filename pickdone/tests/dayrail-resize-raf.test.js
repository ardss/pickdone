/**
 * round3-ux-perf-4: DayRail's window resize handler must coalesce fitRail+measureAxis to one
 * animation frame. Uncoalesced, every resize event re-read offsetTop/offsetHeight for the ~25
 * [data-vrange] rows right after fitRail's style.height write — layout thrash during a window
 * drag. Behavior preserved: both methods re-read the live DOM at execution time, so deferring
 * by <=1 frame cannot change the final layout values.
 *
 * No component-mount harness exists for DayRail in the node setup, so this test extracts the
 * ACTUAL registered listener source from the SFC and drives it with a stubbed
 * requestAnimationFrame against spy counters.
 * Run: node --test tests/dayrail-resize-raf.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(path.join(ROOT, 'renderer/js/components/DayRail.vue'), 'utf8')

// Pull the exact arrow function assigned to _onResize in mounted(); rewritten as a function
// expression so it can be .bind()-bound to the spy context (arrows capture lexical `this`).
const m = src.match(/this\._onResize = (\(\) => \{[\s\S]*?\n {4}\})\)/)
assert.ok(m, 'resize listener arrow function found in DayRail mounted()')
const makeListener = new Function('return ' + m[1].replace('() =>', 'function ()'))

function rig () {
  const frameQueue = []
  let rafId = 0
  globalThis.requestAnimationFrame = (cb) => { frameQueue.push({ id: ++rafId, cb }); return rafId }
  globalThis.cancelAnimationFrame = (id) => { const i = frameQueue.findIndex(f => f.id === id); if (i >= 0) frameQueue.splice(i, 1) }
  const calls = { fitRail: 0, measureAxis: 0 }
  const ctx = {
    _resizeRaf: 0,
    fitRail () { calls.fitRail++ },
    measureAxis () { calls.measureAxis++ }
  }
  return { frameQueue, calls, listener: makeListener().bind(ctx), ctx }
}

test('a burst of N resize events yields exactly ONE fitRail+measureAxis run per frame', () => {
  const { frameQueue, calls, listener } = rig()
  for (let i = 0; i < 50; i++) listener() // one drag-frame's worth of resize events
  assert.equal(frameQueue.length, 1, 'all coalesced into a single scheduled frame')
  assert.equal(calls.fitRail + calls.measureAxis, 0, 'nothing runs synchronously per event')
  frameQueue[0].cb() // the frame fires
  assert.equal(calls.fitRail, 1)
  assert.equal(calls.measureAxis, 1)
  // events after the frame run schedule a new frame (listener stays live, no sticky suppression)
  listener()
  assert.equal(frameQueue.length, 2, 'a new frame is scheduled for post-frame events')
})

test('the scheduled frame runs once even if the frame callback path re-enters the listener', () => {
  const { frameQueue, calls, listener } = rig()
  listener(); listener(); listener()
  assert.equal(frameQueue.length, 1)
  frameQueue[0].cb()
  listener()
  frameQueue[1].cb()
  assert.equal(calls.fitRail, 2, 'two frames, two runs — never three runs for four events')
})

test('unmount cancels a pending coalesced frame (no post-destroy layout work)', () => {
  // source pin on the beforeUnmount cleanup, mirroring the rAF teardown contract
  assert.match(src, /if \(this\._resizeRaf\) cancelAnimationFrame\(this\._resizeRaf\)/)
})
