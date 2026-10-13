import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Evaluate only the plain-JS proxy adapter from the actual Electron main
// source against an isolated fake dbm; never instantiate a real user database.
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../src/main/index.js'), 'utf8')
const begin = src.indexOf('function proxyDb ()')
const end = src.indexOf('let quitting =', begin)
assert(begin > 0 && end > begin, 'main-process DB adapter boundary missing')

function fixture() {
  const calls = []
  const dbm = {call(op, ...args) {
    calls.push([op, ...args])
    if (op === 'getMeta') return 'persisted-watermark'
    if (op === 'queryTodos') return []
    return {ok:true}
  }}
  // Narrow source slice contains only proxyDb() and dbApi(); no Electron
  // startup nor user data paths are evaluated.
  const api = new Function('dbm', src.slice(begin, end) + '\nreturn dbApi()')(dbm)
  return {api, calls}
}

test('real main dbApi exposes call for reminder watermark restoration', () => {
  const {api,calls} = fixture()
  assert.equal(typeof api.call, 'function', 'scheduler reload needs db.call(op,key)')
  assert.equal(api.call('getMeta', 'firedReminders:'), 'persisted-watermark')
  assert.deepEqual(calls, [['getMeta','firedReminders:']])
})

test('real main dbApi retains queryTodos and dynamic setMeta/getMeta operations', () => {
  const {api,calls} = fixture()
  assert.deepEqual(Array.from(api.queryTodos({complete:0})), [])
  api.setMeta(['reminderLastSeenAt','123'])
  assert.equal(api.getMeta('firedReminders:'), 'persisted-watermark')
  assert.deepEqual(calls, [
    ['queryTodos',{complete:0}],
    ['setMeta',['reminderLastSeenAt','123']],
    ['getMeta','firedReminders:']
  ])
})

test('main DB facade is not accidentally a Promise-like thenable', () => {
  const {api} = fixture()
  assert.equal(api.then, undefined)
})
