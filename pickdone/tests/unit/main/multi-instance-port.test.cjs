'use strict'
// TODO_SYNC_PORT override unit (src/main/lan-sync/transport.js resolveSyncPort) — plain resolver,
// no server is started here.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { resolveSyncPort, DEFAULT_PORT } = require('../../../src/main/lan-sync/transport')

test('unset/garbage env keeps the historical fixed 58471', () => {
  assert.equal(resolveSyncPort(undefined), 58471)
  assert.equal(resolveSyncPort({}), 58471)
  assert.equal(resolveSyncPort({ TODO_SYNC_PORT: '' }), 58471)
  assert.equal(resolveSyncPort({ TODO_SYNC_PORT: 'abc' }), 58471)
  assert.equal(resolveSyncPort({ TODO_SYNC_PORT: '0' }), 58471)
  assert.equal(resolveSyncPort({ TODO_SYNC_PORT: '-1' }), 58471)
  assert.equal(resolveSyncPort({ TODO_SYNC_PORT: '65536' }), 58471)
  assert.equal(resolveSyncPort({ TODO_SYNC_PORT: '58471.5' }), 58471)
})

test('a valid override wins', () => {
  assert.equal(resolveSyncPort({ TODO_SYNC_PORT: '58472' }), 58472)
  assert.equal(resolveSyncPort({ TODO_SYNC_PORT: '1' }), 1)
  assert.equal(resolveSyncPort({ TODO_SYNC_PORT: '65535' }), 65535)
})

test('module-load DEFAULT_PORT follows this process env (node default: 58471)', () => {
  // This test process does not set TODO_SYNC_PORT, so the module constant must be the canonical port.
  assert.equal(DEFAULT_PORT, resolveSyncPort(process.env))
})
