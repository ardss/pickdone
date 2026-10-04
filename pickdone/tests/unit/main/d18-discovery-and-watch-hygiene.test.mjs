/**
 * D18 (2026-10-02) — source anchors for two main-process hygiene fixes that are not
 * unit-testable without a live mDNS stack / Electron app (repo idiom: source-anchor tests).
 * [F8] lan-sync/discovery.js discover() must stop the previous bonjour browser before minting
 *      a new one (repeated discover() used to leak a live browser per call).
 * [F9] external-db-watch.js must keep polling in waiting-for-file mode when todos.db is absent
 *      (statSync throw used to kill the setup / disarm external-write reloads for the session)
 *      and log the re-arm once the file is readable again.
 * Run: node --test tests/unit/main/d18-discovery-and-watch-hygiene.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8')

test('F8: discover() stops the stale browser handle before creating a new one', () => {
  const src = read('../../../src/main/lan-sync/discovery.js')
  const discoverBody = src.slice(src.indexOf('function discover('), src.indexOf('function stop('))
  const stopIdx = discoverBody.indexOf('if (browser) { try { browser.stop() } catch')
  const findIdx = discoverBody.indexOf('bonjour.find(')
  assert.ok(stopIdx !== -1, 'the stale-browser stop hygiene is missing from discover()')
  assert.ok(findIdx !== -1)
  assert.ok(stopIdx < findIdx, 'red before the fix: the old browser handle was overwritten without stop()')
})

test('F9: the external-watch mtime read tolerates an absent todos.db and re-arms with a log line', () => {
  const src = read('../../../src/main/external-db-watch.js')
  const watch = src.slice(src.indexOf('const readWatchMtime'), src.indexOf('let lastTomatoCmdRaw'))
  assert.ok(watch.includes('return null') && watch.includes('waiting-for-file'),
    'statOne must return null (waiting-for-file) when todos.db is missing instead of throwing')
  assert.ok(src.includes('等待文件状态'), 'the waiting-for-file state must be logged')
  assert.ok(src.includes('重新武装'), 'the re-arm after the file reappears must be logged')
  // the wal stat is guarded too (wal can vanish between existsSync and statSync)
  const statOne = src.slice(src.indexOf('const statOne'), src.indexOf('return fixUtil.stableRead'))
  assert.ok((statOne.match(/try \{/g) || []).length >= 2, 'both the db and the wal statSync are guarded')
})

test('F9 (behavioral): the watcher survives a watch setup while todos.db is absent (waiting-for-file)', async () => {
  const os = await import('node:os')
  const path = await import('node:path')
  const { createRequire } = await import('node:module')
  const { Module } = await import('node:module')
  const req = createRequire(import.meta.url)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd18-watch-'))
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => dir }, BrowserWindow: class { static getAllWindows () { return [] } } }
    return origLoad.call(this, request, parent, isMain)
  }
  process.on('exit', () => { Module._load = origLoad })
  const logs = []
  const { createExternalDbWatch } = req('../../../src/main/external-db-watch.js')
  const w = createExternalDbWatch({
    app: { getPath: () => dir },
    log: { info: m => logs.push(m), warn: m => logs.push(String(m)), error: () => {} },
    dbm: { call: () => { throw new Error('no db yet') } },
    fixUtil: req('../../../src/main/fix-util.js'),
    extWatchGate: { canPoll: () => false },
    nextWatchBaseline: (prev, read) => read() ?? prev,
    scheduler: { reloadAll: () => {} },
    getMainWindow: () => null,
    isLocked: () => false,
    dbApi: () => null,
    broadcastTodosChanged: () => {},
    broadcastTomatoRecordsChanged: () => {}
  })
  // red before the fix: the setup itself threw when the startup baseline statSync hit a missing
  // todos.db (or later reads disarmed the session); now it logs waiting-for-file and stays armed.
  assert.doesNotThrow(() => w.watchDbForExternalWrites())
  assert.ok(logs.some(l => String(l).includes('等待文件状态')), 'the waiting-for-file state is announced')
  w.stopForQuit() // release the fs.watchFile poll timers
})
