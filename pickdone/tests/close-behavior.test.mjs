import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { isCloseToTray, shouldShowTrayNotice } = require('../src/main/close-behavior.js')

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
