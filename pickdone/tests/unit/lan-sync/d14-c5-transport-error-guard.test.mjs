/* D14 C5 regression — transport client: the socket 'error' re-emit is guarded like the timeout
 * path. A caller without an 'error' listener gets the 'close' signal (the contract every caller
 * already handles) instead of an uncaught 'error' event that crashes the process.
 * Run: node --test tests/unit/lan-sync/d14-c5-transport-error-guard.test.mjs
 */
import { test } from 'node:test'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)

test('C5: connect to a refused port WITHOUT an error listener → close, no uncaught error', async () => {
  const transport = require_('../../../src/main/lan-sync/transport.js')
  await new Promise((resolve, reject) => {
    const em = transport.connect('127.0.0.1', 1, { deviceId: 'd14c5', authCode: 'x', pairingSecret: 'y', timeoutMs: 3000 })
    const timer = setTimeout(() => reject(new Error('no close within 5s')), 5000)
    em.on('close', () => { clearTimeout(timer); resolve() })
    em.on('ready', () => { clearTimeout(timer); reject(new Error('unexpected ready')) })
    // NOTE: deliberately NO 'error' listener — an unguarded re-emit crashes the test process
  })
})

test('C5: WITH an error listener the error event still fires (contract preserved)', async () => {
  const transport = require_('../../../src/main/lan-sync/transport.js')
  await new Promise((resolve, reject) => {
    const em = transport.connect('127.0.0.1', 1, { deviceId: 'd14c5b', authCode: 'x', pairingSecret: 'y', timeoutMs: 3000 })
    const timer = setTimeout(() => reject(new Error('no error within 5s')), 5000)
    em.on('error', () => { clearTimeout(timer); resolve() })
    em.on('close', () => { /* after the error; fine */ })
  })
})
