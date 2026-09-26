/**
 * round3-ux-perf-5: DepView's window resize listener must not call drawWires directly —
 * drawWires reads getBoundingClientRect per card and rebuilds every SVG wire path, which ran
 * once per resize tick during a window drag. The listener is now rAF-coalesced
 * (onResizeWires), mirroring the pre-existing onGripMove pattern. Final rendered wires are
 * unchanged: the last scheduled frame draws with the final geometry.
 *
 * No component-mount harness exists for DepView in the node setup, so the test extracts the
 * ACTUAL onResizeWires method source from the SFC and drives it with a stubbed
 * requestAnimationFrame against a drawWires spy.
 * Run: node --test tests/depview-resize-raf.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(path.join(ROOT, 'renderer/js/components/DepView.vue'), 'utf8')

const m = src.match(/onResizeWires \(\) \{([\s\S]*?)\n {4}\},/)
assert.ok(m, 'onResizeWires method found in DepView')

function rig () {
  const frameQueue = []
  let rafId = 0
  globalThis.requestAnimationFrame = (cb) => { frameQueue.push({ id: ++rafId, cb }); return rafId }
  globalThis.cancelAnimationFrame = (id) => { const i = frameQueue.findIndex(f => f.id === id); if (i >= 0) frameQueue.splice(i, 1) }
  let draws = 0
  const ctx = {
    _rzRaf: 0,
    drawWires () { draws++ }
  }
  // run the real method body against the spy context
  const method = new Function('ctx', `with (ctx) { return function onResizeWires () { ${m[1]} } }`)(ctx)
  return { frameQueue, count: () => draws, call: () => method.call(ctx) }
}

test('a burst of resize events schedules ONE drawWires per frame, none synchronously', () => {
  const { frameQueue, count, call } = rig()
  for (let i = 0; i < 30; i++) call()
  assert.equal(frameQueue.length, 1, 'coalesced into a single scheduled frame')
  assert.equal(count(), 0, 'no synchronous drawWires per event')
  frameQueue[0].cb()
  assert.equal(count(), 1, 'exactly one draw per frame')
  call()
  assert.equal(frameQueue.length, 2, 'listener stays live after a frame fires')
})

test('the frame callback carries the final draw — later events redraw with fresh geometry', () => {
  const { frameQueue, count, call } = rig()
  call(); call()
  frameQueue[0].cb()
  call()
  frameQueue[1].cb()
  assert.equal(count(), 2, 'two frames -> two draws; direct-call wiring would have drawn four times')
})

test('unmount removes onResizeWires and cancels a pending frame (source pin)', () => {
  const unmount = src.match(/beforeUnmount \(\) \{[\s\S]*?\n {4}\},/)
  assert.ok(unmount, 'beforeUnmount found')
  assert.match(unmount[0], /removeEventListener\('resize', this\.onResizeWires\)/)
  assert.match(unmount[0], /if \(this\._rzRaf\) cancelAnimationFrame\(this\._rzRaf\)/)
  assert.ok(!/removeEventListener\('resize', this\.drawWires\)/.test(src), 'direct drawWires resize listener is gone')
})
