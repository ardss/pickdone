/* browser shim bumpSnow structured result (browser-dev/todo-browser-shim.js): the desktop main
   process returns { ok:true, minutes } from src/main/db.js bumpSnow — the shim still returned a bare
   true, drifting from the contract the renderer consumes. Isolated vm sandbox like
   cli-fixes-chips-caliber-import-shim.test.mjs (#9).
   Run: node --test tests/unit/main/shim-bumpsnow-shape.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'module'
import { ANCHORS, REPO_ROOT } from '../../lib/source-anchors.mjs'

test('shim bumpSnow returns { ok: true, minutes } like the desktop db op', async () => {
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
  const dbCall = sandbox.window.todoAPI.dbCall

  const r = await dbCall('bumpSnow', { taskId: 'shim_snow_1', minutes: 25 })
  assert.equal(r.ok, true)
  assert.equal(r.minutes, 25)
  // minutes echoes the applied value, matching db.js bumpSnow's { ok, minutes } shape
  const r2 = await dbCall('bumpSnow', { taskId: 'shim_snow_1', minutes: 10 })
  assert.equal(r2.ok, true)
  assert.equal(r2.minutes, 10)
  assert.equal(Object.keys(r2).sort().join(','), 'minutes,ok', 'exactly the { ok, minutes } keys (no bare true)')
})
