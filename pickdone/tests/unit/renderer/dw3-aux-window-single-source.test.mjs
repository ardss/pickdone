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

test('[F12] auto-show gate respects tomatoFloatClosedByUser; TomatoBar writes/clears it', () => {
  const mainSrc = read('renderer/js/main.js')
  assert.ok(mainSrc.includes("localStorage.getItem('tomatoFloatClosedByUser')"), 'auto-show reads the dedicated key')
  assert.ok(mainSrc.includes('!closedByUser'), 'a user-closed float is not auto-resurrected 6s after start')
  // the settings switch stays a separate semantic (must NOT be reused as the close flag)
  assert.ok(mainSrc.includes('enableTomatoFloating !== false'), 'the settings-switch condition is unchanged')
  const barSrc = read('renderer/js/components/TomatoBar.vue')
  assert.ok(barSrc.includes("localStorage.setItem('tomatoFloatClosedByUser', '1')"), 'hide path persists the close')
  assert.ok(barSrc.includes("localStorage.removeItem('tomatoFloatClosedByUser')"), 'show path clears it')
  // dead field cleanup: no consumer left anywhere
  const dead = ['renderer/js/store/tomato.js']
  for (const f of dead) assert.ok(!read(f).includes('isEnabledFloatingWindow'), `${f}: dead default field removed`)
})

test('[F12] behavior: the gate logic flips exactly on the persisted key', () => {
  // mirrors the main.js gate condition so the semantics are pinned, not just the source text
  const gate = (settingsOn, lsValue) => {
    let closedByUser = false
    try { closedByUser = lsValue === '1' } catch { /* storage unavailable */ }
    return settingsOn !== false && !closedByUser
  }
  assert.equal(gate(true, null), true, 'fresh install: auto-show')
  assert.equal(gate(true, '1'), false, 'user closed it last run: stays closed')
  assert.equal(gate(false, null), false, 'settings switch off: still off')
  assert.equal(gate(true, '0'), true, "any other value than '1' is not a close")
})

test('[F12] bypass re-open paths clear the stale close marker (adversarial-review follow-up)', () => {
  // The float can be re-opened without TomatoBar.toggleFloat: SettingsModal.setTomatoFloat and
  // TomatoPanel.openFloatWindow both call todoAPI.showTomatoFloat; the tray undock goes through
  // main-process tomatoFloat.undock (invisible to renderer show calls). Each path must clear
  // 'tomatoFloatClosedByUser' or a restart suppresses auto-show despite last action = "open".
  const mainSrc = read('renderer/js/main.js')
  const wrapIdx = mainSrc.indexOf('window.todoAPI.showTomatoFloat = ')
  const rmIdx = mainSrc.indexOf("localStorage.removeItem('tomatoFloatClosedByUser')", wrapIdx)
  assert.ok(wrapIdx > -1 && rmIdx > wrapIdx, 'main.js wraps todoAPI.showTomatoFloat and clears the marker inside (SettingsModal/TomatoPanel paths)')
  const barSrc = read('renderer/js/components/TomatoBar.vue')
  const syncIdx = barSrc.indexOf('tomatoFloatShown()')
  const syncRm = barSrc.indexOf("localStorage.removeItem('tomatoFloatClosedByUser')", syncIdx)
  assert.ok(syncIdx > -1 && syncRm > syncIdx, 'TomatoBar 15s visibility sync clears the marker when the float is seen open (tray undock path)')
  // behavior mirror of the wrapper: any explicit show wipes the marker
  const ls = { v: '1', removeItem (k) { if (k === 'tomatoFloatClosedByUser') this.v = null } }
  const origShow = () => 'shown'
  const wrapped = (...a) => { try { ls.removeItem('tomatoFloatClosedByUser') } catch { /* */ } return origShow(...a) }
  wrapped()
  assert.equal(ls.v, null, 'an explicit re-open leaves no stale close marker behind')
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
