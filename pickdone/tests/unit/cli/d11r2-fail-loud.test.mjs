/** D11 round-2 fail-loud fixes, each with its regression test:
 *  1. ensureTomatoMigrated no longer swallows migration failure into silence: a corrupt meta blob
 *     used to make `tomato list` return an empty ledger with exit 0 (read-side side effect + fake
 *     success). Now the failure is announced on stderr; the read still completes (full read/write
 *     open-protocol decoupling is a separate round).
 *  2. waitForTomatoAck / waitForSyncAck timeouts CLEAR the command slot when it still holds our
 *     seq (compare-and-delete) — the CLI side of "who consumes, who clears"; a NEWER command's
 *     slot must survive.
 *  3. browser shim: unknown todoAPI write-ish methods reject (was resolve(undefined) fake success);
 *     whitelisted read-only/UI methods still no-op; sync* dbCall ops degrade instead of throwing
 *     "未实现操作" on the 5175 Device Center.
 *  Run: node --test tests/unit/cli/d11r2-fail-loud.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'
import vm from 'node:vm'
import { isolatedTmpDir } from '../../lib/tmp-dir.mjs'

process.env.TODO_DB_DIR = isolatedTmpDir('todo-cli-d11r2-')
const require_ = createRequire(import.meta.url)

/* ---------- 2: channel timeout clears its own command slot ---------- */
function makeChannels () {
  const meta = new Map()
  let tomatoSeq = 0
  let syncSeq = 0
  const channels = require_('../../../cli/lib-channels.cjs')({
    open: () => ({ call: (op, key) => {
      if (op === 'nextCliTomatoSeq') return ++tomatoSeq
      if (op === 'nextCliSyncSeq') return ++syncSeq
      if (op === 'getMeta') return meta.has(key) ? meta.get(key) : null
      return null
    } }),
    commit: (_e, verb, p) => {
      if (verb === 'put') { const [k, v] = p; meta.set(k, v) } else if (verb === 'delete') { meta.delete(p) }
    },
    audit: { record () {} }
  })
  return { channels, meta }
}

test('d11r2: waitForTomatoAck timeout DELETES the cliTomatoCmd slot still holding our seq', async () => {
  const { channels, meta } = makeChannels()
  const seq = channels.writeTomatoCmd({ action: 'startTomatoTime', taskId: 'r2-a', tomatoTime: 25 })
  assert.ok(meta.has('cliTomatoCmd'), 'slot written before the wait')
  const ack = await channels.waitForTomatoAck(seq, 250) // App absent → timeout
  assert.equal(ack, null)
  assert.equal(meta.has('cliTomatoCmd'), false, 'timed-out waiter cleared its own stale slot (was left behind before the fix)')
})

test('d11r2: waitForTomatoAck timeout does NOT delete a NEWER command\'s slot', async () => {
  const { channels, meta } = makeChannels()
  const first = channels.writeTomatoCmd({ action: 'startTomatoTime', taskId: 'r2-b', tomatoTime: 25 })
  channels.writeTomatoCmd({ action: 'stopTomatoTime', taskId: 'r2-b' }) // concurrent second CLI overwrote the slot
  await channels.waitForTomatoAck(first, 250)
  const kept = JSON.parse(meta.get('cliTomatoCmd'))
  assert.equal(kept.action, 'stopTomatoTime', 'the newer command\'s slot survives the older waiter\'s timeout')
})

test('d11r2: waitForSyncAck timeout DELETES the cliSyncCmd slot (same ownership rule)', async () => {
  const { channels, meta } = makeChannels()
  const seq = channels.writeSyncCmd({ action: 'syncNow' })
  const ack = await channels.waitForSyncAck(seq, 250)
  assert.equal(ack, null)
  assert.equal(meta.has('cliSyncCmd'), false, 'sync channel timeout also closes the ownership loop')
})

test('d11r2: a received ack leaves both slots untouched (cleanup only on timeout)', async () => {
  const { channels, meta } = makeChannels()
  const seq = channels.writeTomatoCmd({ action: 'startTomatoTime', taskId: 'r2-c', tomatoTime: 25 })
  meta.set('cliTomatoState', JSON.stringify({ seq, status: 'startTomatoTime', at: Date.now() }))
  const ack = await channels.waitForTomatoAck(seq, 1000)
  assert.ok(ack)
  assert.ok(meta.has('cliTomatoCmd'), 'successful ack keeps the command slot (App is its owner now)')
})

/* ---------- 1: migration failure is announced on stderr, read still completes ---------- */
test('d11r2: tomato migration failure prints a stderr warning instead of silent empty-ledger success', () => {
  const bus = require_('../../../src/main/command-bus')
  const lib = require_('../../../cli/lib.js')
  const origCommit = bus.commit
  const errs = []
  const origErr = console.error
  console.error = (...a) => errs.push(a.join(' '))
  bus.commit = () => { throw new Error('corrupt meta blob (injected)') }
  try {
    lib.listReady() // first CLI touch: open() → ensureTomatoMigrated → injected failure
  } finally {
    bus.commit = origCommit
    console.error = origErr
  }
  assert.ok(errs.some(m => m.includes('tomato ledger migration failed') && m.includes('corrupt meta blob')),
    'migration failure must be visible on stderr (was a bare catch before the fix)')
  assert.ok(Array.isArray(lib.listReady()), 'the read still completes — decoupling the protocol is a separate round, only the silence is fixed')
})

/* ---------- 3: browser shim — fail-loud Proxy + sync* degrade ---------- */
function loadShim () {
  const store = new Map()
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k)
  }
  const dayjs = () => ({ add: () => ({ startOf: () => 0 }), startOf: () => 0, subtract: () => ({ format: () => '' }) })
  const sandbox = { window: { dayjs }, localStorage, console: { log () {}, warn () {}, error () {} }, URLSearchParams, location: { search: '' } }
  sandbox.window.localStorage = localStorage
  vm.createContext(sandbox)
  const src = require_('fs').readFileSync(require_('path').join(process.cwd(), 'browser-dev', 'todo-browser-shim.js'), 'utf8')
  vm.runInContext(src, sandbox)
  return sandbox.window.todoAPI
}

test('d11r2: shim unknown WRITE-ish todoAPI method rejects (was resolve(undefined) fake success)', async () => {
  const api = loadShim()
  await assert.rejects(() => api.someFutureWriteMethod(), /someFutureWriteMethod.*未实现/,
    'unknown methods must not fake success — that path once swallowed updateSettings writes')
})

test('d11r2: shim whitelisted read-only/UI methods still resolve as no-op', async () => {
  const api = loadShim()
  assert.equal(await api.minimize(), undefined, 'window control stays a resolved no-op')
  assert.equal(await api.logWrite(['x']), undefined, 'capability-difference channel stays a resolved no-op')
  assert.equal(await api.then, undefined, 'then must stay undefined so await todoAPI is not a thenable')
  // real methods still win over the Proxy
  assert.equal(typeof api.dbCall, 'function')
  assert.equal(await api.updateSettings({ theme: 'dark' }), true, 'implemented write methods untouched')
})

test('d11r2: shim sync* ops degrade locally — Device Center no longer throws 未实现操作', async () => {
  const api = loadShim()
  const st = await api.dbCall('syncGetSettings')
  assert.equal(st.enabled, false, '5175 reads degraded settings instead of throwing')
  assert.equal(st.deviceId, 'browser-shim')
  assert.equal((await api.dbCall('syncGetStatus')).listening, false)
  assert.equal(await api.dbCall('syncSetName', { name: '调试机' }).then(r => r.deviceName), '调试机')
  assert.equal(await api.dbCall('syncGetPairingCode').then(r => r.code), null, 'code:null routes to the pairingUnavailable toast')
  assert.ok(Array.isArray(await api.dbCall('syncConflictBackupsList')) && (await api.dbCall('syncConflictBackupsList')).length === 0,
    'conflict backups list degrades to an empty list (cross-realm: length check, not deepEqual)')
  await assert.rejects(() => api.dbCall('syncSetEnabled', { enabled: true }), /LAN 同步需要桌面主进程/,
    'node-requiring writes fail loud (UI catch shows the failure toast — no fake success)')
  await assert.rejects(() => api.dbCall('syncPairWithCode', { code: '123456' }), /LAN 同步需要桌面主进程/)
})
