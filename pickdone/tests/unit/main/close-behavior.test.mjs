import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const require = createRequire(import.meta.url)
const { isCloseToTray, shouldShowTrayNotice, closeIntent } = require('../../../src/main/close-behavior.js')
const srcRoot = join(fileURLToPath(import.meta.url), '..', '..', '..', '..')

test('isCloseToTray: default (missing key) means tray-minimize', () => {
  assert.equal(isCloseToTray({}), true)
  assert.equal(isCloseToTray({ closeActionMinimize: true }), true)
  assert.equal(isCloseToTray(null), true) // unreadable config must not turn X into a quit
  assert.equal(isCloseToTray({ closeActionMinimize: false }), false)
})

test('shouldShowTrayNotice: fires once, only on the tray path', () => {
  assert.equal(shouldShowTrayNotice({}), true) // first close-to-tray
  assert.equal(shouldShowTrayNotice({ closeTrayNotified: true }), false) // never repeats
  assert.equal(shouldShowTrayNotice({ closeActionMinimize: false, closeTrayNotified: false }), false) // quitting, not tray
  assert.equal(shouldShowTrayNotice({ closeActionMinimize: false, closeTrayNotified: true }), false)
})

test('closeIntent: quit already in flight → the window closes for real', () => {
  assert.equal(closeIntent({ quitByUser: true, closeToTray: true }), 'close')
  assert.equal(closeIntent({ quitByUser: true, closeToTray: false }), 'close')
})

test('closeIntent: tray mode (default) hides — 0.1.0 behavior unchanged', () => {
  assert.equal(closeIntent({ quitByUser: false, closeToTray: true }), 'hide')
})

test('closeIntent: exit mode routes X through the user-quit chain (F1)', () => {
  // The onboarding step-4 / Settings→General promise is "X quits the app"; the pre-F1
  // else-branch destroyed the window while window-all-closed stayed resident instead.
  assert.equal(closeIntent({ quitByUser: false, closeToTray: false }), 'quit')
})

test('F1 wiring anchor: windows.js preventDefaults BEFORE requestUserQuit, and index.js passes the chain', () => {
  const winSrc = readFileSync(join(srcRoot, 'src', 'main', 'windows.js'), 'utf8')
  assert.ok(winSrc.includes('closeBehavior.closeIntent('), 'close handler consults closeIntent')
  const quitIdx = winSrc.indexOf("intent === 'quit'")
  const pdIdx = winSrc.indexOf('e.preventDefault()', quitIdx)
  const rqIdx = winSrc.indexOf('requestUserQuit()', quitIdx)
  assert.ok(quitIdx !== -1 && pdIdx !== -1 && rqIdx !== -1, 'quit branch present in the close handler')
  assert.ok(pdIdx < rqIdx, 'preventDefault precedes the quit chain call (window survives the confirm)')
  const idxSrc = readFileSync(join(srcRoot, 'src', 'main', 'index.js'), 'utf8')
  assert.ok(/requestUserQuit:\s*quitFromTray/.test(idxSrc), 'index.js wires requestUserQuit to the guarded quitFromTray chain')
})

test('F2 regression anchor: taskbar thumbar fallback no longer borrows the tray QUIT label', () => {
  const tbSrc = readFileSync(join(srcRoot, 'src', 'main', 'tomato-taskbar.js'), 'utf8')
  assert.ok(!tbSrc.includes("mt('trayQuit')"), 'thumbar tooltip must not reuse the tray-quit (app exit) vocabulary')
  assert.ok(tbSrc.includes('thumbarGiveUpFocus') && tbSrc.includes('thumbarGiveUpRest'), 'phase-aware give-up fallback in place')
})
