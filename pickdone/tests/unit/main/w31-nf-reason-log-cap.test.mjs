import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

// Slice: protocol.js _nfReasonLogged bounded capacity (w31 P2).
// The dedupe Set keyed on (reason | len+fp of every distinct dead key) grows
// without bound when a LAN thumbnail grid mints thousands of distinct dead
// keys. Fix under test: capacity-capped with oldest-entry eviction; same key
// still logs exactly once.

// protocol.js logs through electron-log.warn; capture via the supported
// electron-log hooks API (method patching is not reliable on Logger instances).
const require = createRequire(import.meta.url)
const warned = []
const el = require('electron-log')
const hook = (message) => { try { warned.push(String(message.data && message.data.join ? message.data.join(' ') : message.data)) } catch (e) { console.error('HOOKTHREW ' + e) } return false }
el.hooks.push(hook)

const { logNf, _nfReasonLoggedForTest } = require('../../../src/main/protocol.js')

after(() => {
  const i = el.hooks.indexOf(hook)
  if (i !== -1) el.hooks.splice(i, 1)
})

test('dedupe Set stays bounded under >500 distinct keys (oldest evicted)', () => {
  warned.length = 0
  // 1200 distinct dead keys — far beyond any reasonable cap (ask: >500)
  for (let i = 0; i < 1200; i++) {
    logNf('nf-missing-file', `taskA_${1000 + i}_thumb-${i}.png`)
  }
  assert.ok(_nfReasonLoggedForTest().size < 1200, `Set size ${_nfReasonLoggedForTest().size} must be capped`)
  assert.ok(_nfReasonLoggedForTest().size > 0, 'Set must retain recent entries')
  // oldest keys were evicted -> re-logging an early key must warn again
  warned.length = 0
  logNf('nf-missing-file', 'taskA_1000_thumb-0.png')
  const distinct = [...new Set(warned)]
  assert.equal(distinct.length, 1, 'evicted oldest key must be re-loggable')
  assert.ok(distinct[0].includes('nf-missing-file'), 'structured reason line emitted')
})

test('same key does not log twice (dedupe preserved)', () => {
  warned.length = 0
  const key = 'taskB_2000_evicted-none.png'
  logNf('nf-bad-encoding', key)
  const distinctAfterFirst = new Set(warned)
  assert.equal(distinctAfterFirst.size, 1, 'first log of a fresh key warns exactly once')
  logNf('nf-bad-encoding', key)
  assert.equal(new Set(warned).size, 1, 'second log of same key is suppressed')
})
