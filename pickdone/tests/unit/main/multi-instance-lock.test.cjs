'use strict'
// Multi-instance opt-in decision unit (src/main/multi-instance.js) — plain module, no Electron.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  isMultiEnabled, dirScopeHash, lockRequestArgs, shouldQuitOnLockLoss, titleSuffix
} = require('../../../src/main/multi-instance')

test('default mode (no env) is byte-identical to the historical global lock call', () => {
  assert.equal(isMultiEnabled({}), false)
  assert.equal(isMultiEnabled(undefined), false)
  assert.deepEqual(lockRequestArgs({}, 'K:/any/dir'), [])
  // no arguments -> the historical app.requestSingleInstanceLock() call shape
  assert.equal(shouldQuitOnLockLoss({ granted: false }), true)
  assert.equal(titleSuffix({}, 'K:/any/dir'), '')
})

test('PICKDONE_MULTI=1 opts in; other values do not', () => {
  assert.equal(isMultiEnabled({ PICKDONE_MULTI: '1' }), true)
  for (const v of ['0', 'true', '', 'yes', 1]) assert.equal(isMultiEnabled({ PICKDONE_MULTI: v }), false)
})

test('scoped lock tags the lock holder with the data-dir hash', () => {
  const args = lockRequestArgs({ PICKDONE_MULTI: '1' }, 'K:/tmp/duo-a')
  assert.equal(args.length, 1)
  assert.equal(args[0].pickdoneMultiScope, dirScopeHash('K:/tmp/duo-a'))
  assert.match(args[0].pickdoneMultiScope, /^[0-9a-f]{8}$/)
  // different dirs -> different scopes (the whole point)
  assert.notEqual(dirScopeHash('K:/tmp/duo-a'), dirScopeHash('K:/tmp/duo-b'))
  // stable across restarts (same dir -> same scope)
  assert.equal(dirScopeHash('K:/tmp/duo-a'), dirScopeHash('K:/tmp/duo-a'))
})

test('a lost lock still quits in multi mode: it means a same-dir duplicate', () => {
  assert.equal(shouldQuitOnLockLoss({ granted: true }), false)
  assert.equal(shouldQuitOnLockLoss({ granted: false }), true)
})

test('title suffix extends the [TEST] badge path only in multi mode', () => {
  const dir = 'K:/tmp/duo-b'
  assert.equal(titleSuffix({ PICKDONE_MULTI: '1' }, dir), ' [#' + dirScopeHash(dir) + ']')
  assert.equal(titleSuffix({}, dir), '')
})
