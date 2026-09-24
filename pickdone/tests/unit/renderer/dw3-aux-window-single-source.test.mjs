/**
 * Domain-3 renderer regressions (2026-09-24 wave).
 * Fixes covered:
 *   [F4] TomatoFloatPage ⋮-menu fallback list: day caliber changed from +dayjs().format('YYYYMMDD')
 *        (8-digit date, never equal to a t.dayStart midnight timestamp) to +dayjs().startOf('day').
 *   [F12] float "user explicitly closed" persists (localStorage tomatoFloatClosedByUser): main.js
 *         auto-show must not resurrect a closed float after restart; TomatoBar.toggleFloat is the writer.
 *   [F18] aux-window hash checks single-sourced: renderer main.js's two hand-copied regexes now go
 *         through utils/auxWindow.js (isAuxWindow / isFloatWindow).
 * Run: node --test tests/unit/renderer/dw3-aux-window-single-source.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')
const { dayjs } = await import('../../../renderer/js/utils/core.js')
const todayBounds = await import('../../../renderer/js/utils/todayBounds.js')
const auxWindow = await import('../../../renderer/js/utils/auxWindow.js')

/* ---------- [F4] day caliber ---------- */

test('[F4] fallback today uses the dayStart timestamp caliber (was an 8-digit YYYYMMDD)', () => {
  const asDate = +dayjs().format('YYYYMMDD') // the old expression
  const asTs = +dayjs().startOf('day') // the fixed expression
  assert.notEqual(asTs, asDate, 'precondition: the two calibers are different quantities (~10^5 apart)')
  assert.equal(asTs, todayBounds.dayStart(Date.now()), "startOf('day') matches the repo-wide t.dayStart caliber")
  const src = read('renderer/js/views/TomatoFloatPage.vue')
  assert.ok(src.includes("+window.dayjs().startOf('day') : 0"), 'tasks fallback resolves today as a midnight timestamp')
  assert.ok(!src.includes("+window.dayjs().format('YYYYMMDD')"), 'the never-matching 8-digit date caliber is gone from the float page')
})

/* ---------- [F12] closed-float persistence ---------- */

test('[F12] auto-show gate reads the DB meta marker owned by main-process tomato-float', () => {
  const mainSrc = read('renderer/js/main.js')
  assert.ok(mainSrc.includes("dbCall('getMeta', 'tomatoFloatClosedByUser')"), 'auto-show reads the marker via todo-db:call getMeta')
  assert.ok(mainSrc.includes("if (v === '1') return"), 'a user-closed float is not auto-resurrected 6s after start')
  assert.ok(mainSrc.includes('enableTomatoFloating === false'), 'the settings switch remains an independent condition')
  // adversarial-review round 2: a contextBridge object (window.todoAPI) is READ-ONLY — assigning
  // showTomatoFloat on it throws in strict-mode ESM and the wrapper never installs. Guarded so the
  // broken approach cannot come back.
  assert.ok(!mainSrc.includes('window.todoAPI.showTomatoFloat ='), 'no read-only contextBridge property assignment (throws in strict ESM)')
  // marker ownership lives in the main process where every open/close path converges
  const floatSrc = read('src/main/tomato-float.js')
  const hideIdx = floatSrc.indexOf('hide () {')
  assert.ok(floatSrc.includes('setUserClosed(false)') && floatSrc.indexOf('setUserClosed(false)', floatSrc.indexOf('undock ()')) > -1,
    'show() AND undock() clear the marker (SettingsModal/TomatoPanel IPC + tray undock covered)')
  assert.ok(floatSrc.indexOf('setUserClosed(true)', hideIdx) > hideIdx && hideIdx > -1, 'hide() marks "user closed"')
  // renderer side writes nothing anymore (the localStorage pair was bypass-prone and is gone)
  const barSrc = read('renderer/js/components/TomatoBar.vue')
  assert.ok(!barSrc.includes('tomatoFloatClosedByUser'), 'TomatoBar no longer writes/clears the marker (single owner in main process)')
  // dead field cleanup: no consumer left anywhere
  assert.ok(!read('renderer/js/store/tomato.js').includes('isEnabledFloatingWindow'), 'store/tomato.js: dead default field removed')
})

test('[F12] behavior: the gate flips exactly on the persisted marker value', () => {
  // mirrors the main.js gate (dbCall promise → suppress on '1') so the semantics are pinned;
  // the marker's real write/clear lifecycle is behavior-tested against a real DB in
  // tests/unit/main/dw3-aux-window-lifecycle.test.mjs ([F12] marker lifecycle).
  const gate = (settingsOn, markerPromise, show) => {
    if (settingsOn === false) return
    Promise.resolve(markerPromise).then(v => {
      if (v === '1') return
      show()
    }).catch(() => { /* err on the visible side */ })
  }
  const calls = []
  gate(true, Promise.resolve(null), () => calls.push('shown'))
  gate(true, Promise.resolve('1'), () => calls.push('shown'))
  gate(false, Promise.resolve(null), () => calls.push('shown'))
  return Promise.all([new Promise(r => setTimeout(r, 0))]).then(() => {
    assert.deepEqual(calls, ['shown'], "only the unset-marker case shows; '1' and switch-off suppress")
  })
})

/* ---------- [F18] aux-window single source ---------- */

test('[F18] isFloatWindow matches only the float route; isAuxWindow covers both aux routes', () => {
  const withHash = (hash, fn) => {
    const g = globalThis
    const old = g.window
    g.window = { location: { hash } }
    try { return fn() } finally { if (old === undefined) delete g.window; else g.window = old }
  }
  assert.equal(withHash('#/__tomato-float', () => auxWindow.isFloatWindow()), true, 'float route detected')
  assert.equal(withHash('#/__quick-add', () => auxWindow.isFloatWindow()), false, 'quick-add is NOT the float')
  assert.equal(withHash('#/__quick-add', () => auxWindow.isAuxWindow()), true, 'quick-add is an aux window')
  assert.equal(withHash('#/', () => auxWindow.isFloatWindow()), false, 'main shell is not the float')
  assert.equal(withHash('#/', () => auxWindow.isAuxWindow()), false)
  assert.equal(auxWindow.isFloatWindow(), false, 'non-browser env: false')
})

test('[F18] renderer main.js has no hand-copied hash regex left', () => {
  const mainSrc = read('renderer/js/main.js')
  assert.ok(mainSrc.includes("from './utils/auxWindow.js'"), 'imports the helper')
  assert.ok(mainSrc.includes('isFloatWindow()') && mainSrc.includes('!isAuxWindow()'), 'both role checks go through the helper')
  assert.ok(!mainSrc.includes('.test(window.location.hash)'), 'no inline hash regex test remains in main.js')
})
