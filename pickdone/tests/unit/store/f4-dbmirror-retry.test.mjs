/* F4 regression #5 (2026-09-15): dbMirror writeNow used `.catch(() => {})` and had already cleared the
 * pending blob — a failed setMeta (disk full / locked DB) silently dropped the mirror write while the
 * caller believed it persisted. Failures now re-queue the blob and retry on the next tick/call, with a
 * console.warn so the loss is visible. No electron required.
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const warns = []
const origWarn = console.warn
console.warn = (...a) => { warns.push(a.join(' ')) }

const calls = []
let failNext = 0
globalThis.window = {
  location: { hash: '' },
  todoAPI: { dbCall: async (op, params) => { calls.push([op, params]); if (failNext > 0) { failNext--; throw new Error('disk full') } return 'ok' } }
}
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }

beforeEach(() => { calls.length = 0; failNext = 0 })

const { mirrorToDb } = await import('../../../renderer/js/utils/dbMirror.js')

test('F4: a failed setMeta is re-queued and retried on the next mirrorToDb call', async () => {
  failNext = 1
  mirrorToDb('habitsState', { v: 1 }, true) // immediate write -> throws -> re-queued with a warn
  await new Promise(r => setTimeout(r, 20))
  assert.equal(calls.length, 1, 'first write attempted exactly once')
  assert.ok(warns.some(w => w.includes('habitsState')), 'failure is surfaced via console.warn, not swallowed')
  // Next change (new blob wins) retries and succeeds — the queued blob is not lost
  mirrorToDb('habitsState', { v: 2 }, true)
  await new Promise(r => setTimeout(r, 20))
  assert.equal(calls.length, 2, 'retry happens on the next call')
  assert.equal(JSON.parse(calls[1][1][1]).v, 2, 'latest blob wins on retry')
})

test('F4: a rejected promise (async failure) is also re-queued, not swallowed', async () => {
  const impl = globalThis.window.todoAPI.dbCall
  let rejectFirst = true
  globalThis.window.todoAPI.dbCall = async (op, params) => {
    calls.push([op, params])
    if (rejectFirst) { rejectFirst = false; return Promise.reject(new Error('db locked')) }
    return 'ok'
  }
  mirrorToDb('settingsState', { s: 1 }, true)
  await new Promise(r => setTimeout(r, 20))
  assert.equal(calls.length, 1)
  assert.ok(warns.some(w => w.includes('settingsState')), 'rejection logged')
  mirrorToDb('settingsState', { s: 2 }, true) // next change flushes the retried blob
  await new Promise(r => setTimeout(r, 20))
  assert.equal(calls.length, 2, 'requeued write retried')
  assert.equal(JSON.parse(calls[1][1][1]).s, 2)
  globalThis.window.todoAPI.dbCall = impl
  console.warn = origWarn
})
