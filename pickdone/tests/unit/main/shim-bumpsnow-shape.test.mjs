/* browser shim bumpSnow contract (browser-dev/todo-browser-shim.js), aligned with src/main/db.js
   bumpSnow: 600-minute storage clamp (shared/limits.mjs FOCUS_MAX_MINUTES), dedupKey idempotency
   ({ ok:true, minutes:0, deduped:true } on replay), landing on todos.focusMinutes (used to go to a
   meta-only bucket — stats always read 0), and structured { ok:false, reason:'missing'|'deleted' }.
   Isolated vm sandbox like the pre-2026-09-28 version of this file.
   Run: node --test tests/unit/main/shim-bumpsnow-shape.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'module'
import { ANCHORS, REPO_ROOT } from '../../lib/source-anchors.mjs'

async function makeShim () {
  const require_ = createRequire(import.meta.url)
  const store = new Map()
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k)
  }
  const sandbox = {
    console: { log () {}, warn () {}, error () {} },
    localStorage,
    URLSearchParams,
    location: { search: '' },
    Date, JSON, Math, Number, String, Object, Array, Set, RegExp, isNaN,
    encodeURIComponent, decodeURIComponent,
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    unescape, escape,
    window: null
  }
  sandbox.window = { dayjs: require_('dayjs'), todoAPI: undefined }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, ANCHORS.browserShim), 'utf8'), sandbox)
  return sandbox.window.todoAPI
}

const mkRow = over => Object.assign({
  taskId: 'shim_snow_1', userId: 840001, taskContent: 'x', taskDescribe: '',
  complete: false, delete: false, createTime: Date.now(), updateTime: Date.now(), syncTime: Date.now(),
  reminderTime: 0, taskSort: 0, todoTime: 0, dayStart: 0, status: 'add', version: 0
}, over)

test('shim bumpSnow clamps to 600, lands on todos.focusMinutes, structured missing/deleted', async () => {
  const api = await makeShim()
  await api.dbCall('upsert', mkRow({}))

  // clamp: over-cap and negative both clamp like db.js Math.max(0, Math.min(600, floor(m)))
  const r1 = await api.dbCall('bumpSnow', { taskId: 'shim_snow_1', minutes: 9999 })
  assert.deepEqual([r1.ok, r1.minutes], [true, 600], 'over-cap clamped to 600')
  const r2 = await api.dbCall('bumpSnow', { taskId: 'shim_snow_1', minutes: -5 })
  assert.deepEqual([r2.ok, r2.minutes], [true, 0], 'negative clamped to 0')
  const row = (await api.dbCall('getAll')).find(t => t.taskId === 'shim_snow_1')
  assert.equal(row.focusMinutes, 600, 'focusMinutes actually accumulated on the todo row (was meta-only before the fix)')

  // missing / deleted are named, not collapsed into a fake ok
  const miss = await api.dbCall('bumpSnow', { taskId: 'no_such_task', minutes: 25 })
  assert.deepEqual([miss.ok, miss.reason], [false, 'missing']) // values, not deepEqual: the object crosses the vm realm
  await api.dbCall('upsert', mkRow({ taskId: 'shim_snow_del', delete: true }))
  const del = await api.dbCall('bumpSnow', { taskId: 'shim_snow_del', minutes: 25 })
  assert.deepEqual([del.ok, del.reason], [false, 'deleted'])
})

test('shim bumpSnow dedupKey replay is idempotent', async () => {
  const api = await makeShim()
  await api.dbCall('upsert', mkRow({ taskId: 'shim_snow_2' }))
  const first = await api.dbCall('bumpSnow', { taskId: 'shim_snow_2', minutes: 25, dedupKey: 'sess-1' })
  assert.deepEqual([first.ok, first.minutes], [true, 25])
  const replay = await api.dbCall('bumpSnow', { taskId: 'shim_snow_2', minutes: 25, dedupKey: 'sess-1' })
  assert.deepEqual([replay.ok, replay.minutes, replay.deduped], [true, 0, true], 'same-key replay credited 0 and flagged deduped')
  const fresh = await api.dbCall('bumpSnow', { taskId: 'shim_snow_2', minutes: 10, dedupKey: 'sess-2' })
  assert.equal(fresh.minutes, 10, 'a different key still credits')
  const row = (await api.dbCall('getAll')).find(t => t.taskId === 'shim_snow_2')
  assert.equal(row.focusMinutes, 35, '25 (first) + 10 (second key) — replay did NOT double-credit')
})

test('shim updateSettings persists to the settingsState LS key getSettings reads', async () => {
  const api = await makeShim()
  await api.updateSettings({ theme: 'dark' })
  assert.equal((await api.getSettings()).theme, 'dark', 'survives a "refresh" (getSettings re-reads LS)')
  await api.updateSettings({ fontSize: 14 })
  const s = await api.getSettings()
  assert.equal(s.theme, 'dark', 'merge, not overwrite')
  assert.equal(s.fontSize, 14)
})

test('shim unimplemented dbCall op throws instead of fake-null success', async () => {
  const api = await makeShim()
  await assert.rejects(() => api.dbCall('definitelyNotAnOp', {}), /未实现操作:definitelyNotAnOp/)
})
