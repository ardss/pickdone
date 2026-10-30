/**
 * w16 (2026-10-28): the Windows taskbar progress bar must track the REAL pomodoro countdown.
 *
 * Regression matrix (table-driven, plain node:test — fake mainWin stub records setProgressBar):
 *   A. per-second pushes (the renderer's TomatoBar interval, post-fix) advance the progress
 *      monotonically — before the caller-chain fix the sig gate only pushed per minute, so the
 *      bar sat frozen near the origin; before the update() defense a missing totalSec degraded
 *      to total=1 → value clamped 0 → a frozen stub at the origin.
 *   B. missing/zero/negative totalSec while running must NOT write a bogus progress value
 *      (no false full flash, no reset-to-zero jitter) — the set is skipped, last progress kept.
 *   C. phase switches emit the right mode: idle → -1/mode 'none', rest → mode 'paused',
 *      focus → mode 'normal'.
 *   D. debounce preserved: sub-threshold deltas emit nothing.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import Module from 'node:module'

const require_ = createRequire(import.meta.url)

const ELECTRON_STUB = {
  nativeImage: { createFromBuffer: () => ({}) } // thumbar icon composition (win32 branch)
}
const stubs = {
  electron: ELECTRON_STUB,
  'electron-log': { warn () {}, info () {}, error () {} },
  './log-isolation': {}, // side-effect-only require; test isolation shim not needed in plain node
  './i18n': { mt: () => 'Pickdone' },
  './core/pixel-icons': { drawTrayPixels: () => null, drawBadgePixels: () => null, BRAND_WORK: [0, 0, 0], BRAND_REST: [0, 0, 0] }
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (stubs[request]) return stubs[request]
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

function freshTaskbar () {
  const resolved = require_.resolve('../../../src/main/tomato-taskbar.js')
  delete require_.cache[resolved]
  return require_('../../../src/main/tomato-taskbar.js')
}

function fakeWin () {
  const calls = []
  return {
    calls,
    isDestroyed: () => false,
    getTitle: () => 'Pickdone',
    setProgressBar (v, o) { calls.push({ kind: 'progress', v, o: o && o.mode }) },
    setTitle () {},
    setOverlayIcon () {},
    setThumbarButtons () {},
    webContents: { send () {} }
  }
}
const progressCalls = win => win.calls.filter(c => c.kind === 'progress')

// A. per-second push: 25:00 → 24:50 (11 pushes, 10s of countdown) must move monotonically
// A. per-second push over a full minute: the bar must leave the origin and every emitted
//    value must advance (the 0.004 debounce legitimately swallows ~5s sub-threshold ticks)
test('w16 taskbar: per-second countdown pushes advance progress monotonically (mode normal)', () => {
  const tb = freshTaskbar()
  const win = fakeWin()
  tb.init(win)
  let prev = -1
  for (let r = 1500; r >= 1440; r--) { // 60 per-second pushes: 25:00 → 24:00
    tb.update({ status: 'startTomatoTime', totalSec: 1500, remainSec: r })
    const calls = progressCalls(win)
    assert.ok(calls.length, 'the first per-second push must emit a progress set')
    const lastV = calls[calls.length - 1].v
    assert.ok(lastV >= prev, `emitted progress must never regress (got ${lastV}, prev ${prev})`)
    prev = lastV
    assert.equal(calls[calls.length - 1].o, 'normal')
  }
  assert.ok(prev > 0.03, `after a minute of a 25:00 focus the bar must be well past the origin (got ${prev})`)
})

// B. missing / zero / negative totalSec while running: no bogus write (no false-full, no reset)
test('w16 taskbar: missing or non-positive totalSec while running must not write a wrong progress', () => {
  const badTotal = [undefined, null, 0, -1, NaN]
  for (const totalSec of badTotal) {
    const tb = freshTaskbar()
    const win = fakeWin()
    tb.init(win)
    // seed a valid progress, then a caller that omits/breaks totalSec
    tb.update({ status: 'startTomatoTime', totalSec: 1500, remainSec: 1500 })
    const seeded = progressCalls(win).length
    assert.equal(seeded, 1, 'seed push must emit one progress set')
    const seededV = progressCalls(win)[0].v
    tb.update({ status: 'startTomatoTime', totalSec, remainSec: 1400 })
    const calls = progressCalls(win)
    assert.equal(calls.length, seeded, `totalSec=${totalSec}: no further setProgressBar may fire`)
    for (const c of calls) {
      assert.ok(c.v >= 0 && c.v <= 1, `totalSec=${totalSec}: value must stay in [0,1]`)
      assert.notEqual(c.v, 1, `totalSec=${totalSec}: no false full-bar flash`)
    }
    assert.equal(seededV, 0, 'sanity: seed itself was at origin')
  }
})

// C. phase switches: idle clears (-1/none), rest is paused-mode, focus is normal-mode
test('w16 taskbar: phase switches emit the correct progress mode', () => {
  const tb = freshTaskbar()
  const win = fakeWin()
  tb.init(win)
  tb.update({ status: 'startTomatoTime', totalSec: 1500, remainSec: 1500 }) // warm-up: a live phase first (init→idle emits nothing by design)
  const table = [
    [{ status: 'default', totalSec: 1500, remainSec: 1500 }, -1, 'none'],
    [{ status: 'startTomatoTime', totalSec: 1500, remainSec: 1500 }, 0, 'normal'],
    [{ status: 'startRestTime', totalSec: 300, remainSec: 300 }, 0, 'paused']
  ]
  for (const [p, v, mode] of table) {
    tb.update(p)
    const calls = progressCalls(win)
    const last = calls[calls.length - 1]
    assert.equal(last.v, v, `payload ${JSON.stringify(p)}: expected value ${v}`)
    assert.equal(last.o, mode, `payload ${JSON.stringify(p)}: expected mode ${mode}`)
  }
})

// D. debounce: a sub-threshold delta (<=0.004) emits nothing new
test('w16 taskbar: sub-threshold deltas are debounced, no per-tick flicker', () => {
  const tb = freshTaskbar()
  const win = fakeWin()
  tb.init(win)
  // 0.004 * 1500 = 6s; a 5s jump stays under the threshold
  tb.update({ status: 'startTomatoTime', totalSec: 1500, remainSec: 1500 })
  tb.update({ status: 'startTomatoTime', totalSec: 1500, remainSec: 1495 })
  assert.equal(progressCalls(win).length, 1, 'sub-threshold delta must not re-emit')
  tb.update({ status: 'startTomatoTime', totalSec: 1500, remainSec: 1490 })
  assert.equal(progressCalls(win).length, 2, 'supra-threshold delta must emit')
})
