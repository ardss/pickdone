import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

/**
 * F4 fix wave (2026-10-21) — regression coverage:
 *   #1 quit-flush critical-backup ack cap raised to the main process budget (1800ms < 2000ms
 *      FLUSH_ACK_CAP_MS; the old 1000ms cap cut the dump-build IPC window in half and the main
 *      process closed the DB mid-write, silently dropping plan/meta from the last snapshot).
 *   #2 'updater:quit-and-install' now confirms a running pomodoro like tray-quit (cancel/failed
 *      dialog ⇒ no install).
 *   #3 updater download stall watchdog: no download-progress for 90s fails into the honest
 *      error + single-retry path instead of hanging in 'downloading' forever.
 *   #4 windowBoundsVisible: center OR any corner on some workArea (half-off-screen clamps back).
 *   #5 persistBoundsState: maximized windows persist NORMAL bounds + winIsMaximized flag.
 *   #6 pair-ops: the paired-peer record persists only AFTER restartSync succeeds; a restart
 *      failure persists nothing and rejects with code PAIR_RESTART_FAILED_NOT_PERSISTED.
 *   #7 relay adapter disable/forget await the in-flight round (whenIdle) before mutating state.
 *   #8 relaySetEnabled runs adapter.enable() BEFORE the revisionsFlag flip/backfill — a rejected
 *      enable leaves no flag/backfill side effects.
 *   #9 logger.js no longer advertises the nonexistent "export diagnostic logs" feature.
 *
 * Run: node --test tests/unit/main/f4-quit-chain-sync-window-fixes.test.mjs
 */

const require = createRequire(import.meta.url)
const Module = require('module')

/* ------------------------------------------------------------------ *
 * #1 todoBackup ack cap budget match                                  *
 * ------------------------------------------------------------------ */
const BACKUP = await import('../../../renderer/js/store/helpers/todoBackup.js')

test('#1 ackQuitFlushAfterWrite default cap is 1800ms — provably inside the main 2000ms ack window', async () => {
  // A write that never settles: the ack must fire at cap+floor (~1860ms), i.e. BEFORE the main
  // process's FLUSH_ACK_CAP_MS (2000ms) can time the round out and close the DB.
  const t0 = Date.now()
  let acked = 0
  await BACKUP.ackQuitFlushAfterWrite({ write: new Promise(() => {}), notifyDone: () => { acked++ }, floorMs: 5 })
  const elapsed = Date.now() - t0
  assert.equal(acked, 1, 'the cap always fires the ack (write-or-budget semantics)')
  assert.ok(elapsed >= 1795, 'cap raised from 1000 to 1800 (got ' + elapsed + 'ms)')
  assert.ok(elapsed < 2000, 'ack lands inside the main 2000ms flush-ack window (got ' + elapsed + 'ms)')
})

test('#1 a settled write still acks immediately (no regression of the write-await seam)', async () => {
  const t0 = Date.now()
  await BACKUP.ackQuitFlushAfterWrite({ write: Promise.resolve(), notifyDone: () => {}, floorMs: 5 })
  assert.ok(Date.now() - t0 < 500, 'fast write: ack fires well before the cap')
})

/* ------------------------------------------------------------------ *
 * #4 windows.js pure visibility check                                 *
 * ------------------------------------------------------------------ */
const windows = require('../../../src/main/windows.js')
const { windowBoundsVisible } = windows.__windowGeom

const WA = (x, y, w, h) => ({ x, y, width: w, height: h })

test('#4 fully-inside window is visible', () => {
  assert.equal(windowBoundsVisible({ x: 100, y: 100, width: 400, height: 300 }, [{ workArea: WA(0, 0, 1920, 1040) }]), true)
})

test('#4 half-off-screen window (center in, a corner out, another corner in) now counts as visible', () => {
  // Window straddling the right edge: center still inside, right corners outside, left corners inside.
  const b = { x: 1800, y: 100, width: 400, height: 300 }
  assert.equal(windowBoundsVisible(b, [{ workArea: WA(0, 0, 1920, 1040) }]), true)
  assert.equal(windowBoundsVisible(b, [{ workArea: WA(0, 0, 1700, 1040) }]), false, 'center AND every corner off that workArea → not visible (old center-only test would wrongly pass the 1800 case here at width 1700)')
})

test('#4 fully-off-screen window is NOT visible (clamps back)', () => {
  assert.equal(windowBoundsVisible({ x: -3000, y: -3000, width: 400, height: 300 }, [{ workArea: WA(0, 0, 1920, 1040) }]), false)
})

test('#4 window spanning two displays with a corner on each is visible', () => {
  const displays = [{ workArea: WA(0, 0, 1920, 1040) }, { workArea: WA(1920, 0, 1920, 1040) }]
  assert.equal(windowBoundsVisible({ x: 1700, y: 100, width: 400, height: 300 }, displays), true)
})

test('#4 degenerate inputs are not visible (no crash)', () => {
  assert.equal(windowBoundsVisible(null, [{ workArea: WA(0, 0, 100, 100) }]), false)
  assert.equal(windowBoundsVisible({ x: 0, y: 0, width: 10, height: 10 }, []), false)
  assert.equal(windowBoundsVisible({ x: 0, y: 0, width: 10, height: 10 }, [{ workArea: null }]), false)
})

/* ------------------------------------------------------------------ *
 * #5 persistBoundsState (factory-internal, invoked via mock ctx)      *
 * ------------------------------------------------------------------ */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'f4-windows-'))
{
  const ELECTRON_STUB = { app: { getPath: () => TMP }, BrowserWindow () {} }
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return ELECTRON_STUB
    return origLoad.call(this, request, parent, isMain)
  }
  process.on('exit', () => { Module._load = origLoad })
}

function fakeWin ({ maximized }) {
  const normal = { x: 10, y: 20, width: 800, height: 600 }
  const full = { x: 0, y: 0, width: 1920, height: 1040 }
  return {
    isDestroyed: () => false,
    isMaximized: () => maximized,
    getNormalBounds: () => normal,
    getBounds: () => (maximized ? full : normal),
  }
}

test('#5 persistBoundsState stores NORMAL bounds + winIsMaximized=true for a maximized window', () => {
  let saved = null
  const mgr = windows.createWindowManager({
    readConfig: () => ({}),
    writeConfig: patch => { saved = patch },
    log: { warn: () => {} },
  })
  mgr.persistBoundsState(fakeWin({ maximized: true }))
  assert.deepEqual(saved.winBounds, { x: 10, y: 20, width: 800, height: 600 }, 'normal bounds, not the full-screen rect')
  assert.equal(saved.winIsMaximized, true)
})

test('#5 persistBoundsState stores live bounds + winIsMaximized=false when not maximized', () => {
  let saved = null
  const mgr = windows.createWindowManager({
    readConfig: () => ({}),
    writeConfig: patch => { saved = patch },
    log: { warn: () => {} },
  })
  mgr.persistBoundsState(fakeWin({ maximized: false }))
  assert.deepEqual(saved.winBounds, { x: 10, y: 20, width: 800, height: 600 })
  assert.equal(saved.winIsMaximized, false)
})

test('#5 persistBoundsState survives a destroyed window (no throw, nothing written)', () => {
  let saved = null
  const mgr = windows.createWindowManager({
    readConfig: () => ({}),
    writeConfig: patch => { saved = patch },
    log: { warn: () => {} },
  })
  const w = fakeWin({ maximized: false })
  w.isDestroyed = () => true
  assert.doesNotThrow(() => mgr.persistBoundsState(w))
  assert.equal(saved, null)
})

/* ------------------------------------------------------------------ *
 * #6 pair-ops persist-after-restart (fail-closed pairing)             *
 * ------------------------------------------------------------------ */
function makePairOps ({ restartImpl }) {
  const events = []
  const secrets = {}
  const ops = require('../../../src/main/lan-sync/pair-ops.js')({
    getState: () => ({ node: pairNode, pairingCode: null }),
    settingGet: k => (k === 'sync.pairingSecret' ? secrets.global || null : null),
    settingPut: (k, v) => { if (k === 'sync.pairingSecret') secrets.global = v },
    busWrite: () => {},
    getSettingsPayload: () => ({}),
    ensureIdentity: () => ({ deviceId: 'self' }),
    stopSync: () => {}, startSync: () => {}, runRound: () => Promise.resolve(),
    persistPeerWatermarks: () => events.push('watermarks'),
    persistPairedPeer: rec => events.push('persist:' + rec.deviceId),
    removePairedPeer: () => {},
    restartSync: restartImpl,
    manualPeers: () => [], loadPeerWatermarks: () => ({}), notifyRenderers: () => {}, emitSyncEvent: () => {},
    K_PAIRING_SECRET: 'sync.pairingSecret', K_DEVICE_NAME: 'sync.deviceName', K_MANUAL_PEERS: 'sync.manualPeers',
    K_PEER_WATERMARKS: 'sync.peerWatermarks', K_ENABLED: 'sync.enabled',
    K_PEER_ALIAS_PREFIX: 'sync.peerAlias.', PAIRING_CODE_TTL_MS: 60000, DEFAULT_PORT: 58471,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  })
  const pairNode = {
    async pairWith () { events.push('pair'); return { secret: 'pair-secret', peer: { deviceId: 'peer-1', name: 'Peer 1', host: '127.0.0.1', port: 58471 } } },
    async requestPair () { events.push('pairRequest'); return { secret: 'pair-secret', deviceId: 'peer-2', host: '127.0.0.1', port: 58472 } },
  }
  return { ops, events }
}

test('#6 syncPairWithCode persists the peer only AFTER a successful restart', async () => {
  const { ops, events } = makePairOps({ restartImpl: async () => { events.push('restart') } })
  await ops.syncPairWithCode({ code: '123456' })
  const persistAt = events.indexOf('persist:peer-1')
  const restartAt = events.indexOf('restart')
  assert.ok(persistAt > -1 && restartAt > -1 && restartAt < persistAt,
    'restart precedes persist (events: ' + events.join(',') + ')')
})

test('#6 syncPairWithCode: failed restart persists NOTHING and rejects with PAIR_RESTART_FAILED_NOT_PERSISTED', async () => {
  const { ops, events } = makePairOps({ restartImpl: async () => { events.push('restart-failed'); throw new Error('EADDRINUSE') } })
  await assert.rejects(() => ops.syncPairWithCode({ code: '123456' }), e => {
    assert.equal(e.code, 'PAIR_RESTART_FAILED_NOT_PERSISTED')
    assert.match(e.message, /NOT persisted locally/)
    assert.match(e.message, /peer may already show/, 'error carries the true cross-side state')
    return true
  })
  assert.equal(events.includes('persist:peer-1'), false, 'no ghost pairing on disk')
})

test('#6 syncPairRequest: failed restart persists NOTHING and rejects with the structured code', async () => {
  const { ops, events } = makePairOps({ restartImpl: async () => { throw new Error('bind failed') } })
  await assert.rejects(() => ops.syncPairRequest({ host: '127.0.0.1', port: 58472 }), e => {
    assert.equal(e.code, 'PAIR_RESTART_FAILED_NOT_PERSISTED')
    return true
  })
  assert.equal(events.includes('persist:peer-2'), false)
})

test('#6 syncPairRequest: successful restart persists after it (ordering)', async () => {
  const { ops, events } = makePairOps({ restartImpl: async () => { events.push('restart') } })
  await ops.syncPairRequest({ host: '127.0.0.1', port: 58472 })
  assert.ok(events.indexOf('restart') < events.indexOf('persist:peer-2'))
})

/* ------------------------------------------------------------------ *
 * #7 relay adapter disable/forget await the in-flight round           *
 * ------------------------------------------------------------------ */
const { createRelayAdapter } = require('../../../src/main/relay-sync-adapter')

function makeAdapter (loadStore) {
  const store = new Map()
  const adapter = createRelayAdapter({
    nodeId: 'node-f4',
    settingsGet: k => (store.has(k) ? store.get(k) : null),
    settingsPut: (k, v) => store.set(k, String(v)),
    loadStore,
    importModules: async () => ({ createRelayClient: () => { throw new Error('unused') }, deriveDataKey: () => 'dk' }),
    roundIntervalMs: 60 * 60 * 1000, // tests drive rounds manually; keep the poll tick out of the way
    log: {},
  })
  return { adapter, store }
}

/** loadStore that fails enable()'s built-in first round FAST (fail-open), then parks the NEXT
 *  call on the gate — the parked call is the manual in-flight round the tests disable/forget
 *  against (enable itself awaits its round, so it must never be the parked one). */
function gatedLoadStore (gate) {
  let calls = 0
  return async () => {
    calls++
    if (calls > 1) { await gate; throw new Error('round blew up (after release)') }
    throw new Error('round blew up (enable first round)')
  }
}

test('#7 disable() waits for the in-flight round before flipping ENABLED off', async () => {
  let release
  const gate = new Promise(r => { release = r })
  const { adapter, store } = makeAdapter(gatedLoadStore(gate))
  await adapter.enable({ account: 'f4acc', baseUrl: 'http://127.0.0.1:9' })
  assert.equal(store.get('enabled'), '1')
  const roundPromise = adapter.round() // in-flight (parked on the gate)
  await new Promise(r => setTimeout(r, 10))
  const disablePromise = adapter.disable()
  await new Promise(r => setTimeout(r, 10))
  assert.equal(store.get('enabled'), '1', 'ENABLED untouched while the round is still in flight')
  release()
  await roundPromise
  await disablePromise
  assert.equal(store.get('enabled'), '0', 'flipped off only after the round settled')
})

test('#7 forget() waits for the in-flight round before clearing the identity', async () => {
  let release
  const gate = new Promise(r => { release = r })
  const { adapter, store } = makeAdapter(gatedLoadStore(gate))
  await adapter.enable({ account: 'f4acc', baseUrl: 'http://127.0.0.1:9', rootKey: 'a'.repeat(64) })
  assert.ok(store.get('rootKey'))
  const roundPromise = adapter.round()
  await new Promise(r => setTimeout(r, 10))
  const forgetPromise = adapter.forget()
  await new Promise(r => setTimeout(r, 10))
  assert.ok(store.get('rootKey'), 'identity still present while the round is in flight')
  release()
  await roundPromise
  await forgetPromise
  assert.ok(!store.get('rootKey'), 'identity cleared only after the round settled')
  assert.ok(!store.get('enabled'), 'enabled flag cleared (forget wipes the whole config)')
})

test('#7 disable() with no round in flight writes immediately (no deadlock)', async () => {
  const { adapter, store } = makeAdapter(async () => { throw new Error('never called') })
  await adapter.enable({ account: 'f4acc', baseUrl: 'http://127.0.0.1:9' })
  await adapter.disable()
  assert.equal(store.get('enabled'), '0')
})

/* ------------------------------------------------------------------ *
 * #8 relaySetEnabled: enable-first ordering (real db, tmp dir)        *
 * ------------------------------------------------------------------ */
test('#8 a rejected enable leaves revisionsFlag + backfill untouched', async t => {
  process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'f4-relayflag-'))
  const db = require('../../../src/main/db')
  const dbSyncOps = require('../../../src/main/db-sync-ops')
  const relayBootstrap = require('../../../src/main/relay-sync-bootstrap')
  db.init(fs.mkdtempSync(path.join(os.tmpdir(), 'f4-relayflag-db-')))
  relayBootstrap.__test.reset()
  relayBootstrap.initRelaySync()
  const state = relayBootstrap.__test.getState()
  t.after(() => { try { state.adapter.stop() } catch {} })

  const flagBefore = db.call('revisionsFlagState', {})
  const before = !!(flagBefore && (flagBefore.on ?? flagBefore.enabled))
  await assert.rejects(
    () => dbSyncOps.dispatch('relaySetEnabled', { enabled: true, account: 'bad account!', baseUrl: 'not-a-url' }),
    'invalid config must reject')
  const flagAfter = db.call('revisionsFlagState', {})
  const after = !!(flagAfter && (flagAfter.on ?? flagAfter.enabled))
  assert.equal(after, before, 'revisionsFlag unchanged by a FAILED enable (red before the fix: flag was flipped before enable)')
  assert.equal(after, false, 'fresh db: the flag must stay OFF (no side effect leaked)')
})

/* ------------------------------------------------------------------ *
 * #2 'updater:quit-and-install' running-pomodoro confirm              *
 * ------------------------------------------------------------------ */
const UPDATER_MOCK = { quitAndInstallCalls: 0, quitAndInstall () { this.quitAndInstallCalls++; return true } }
{
  const electronStub = {
    app: { getPath: () => TMP, getVersion: () => '0.0.0-f4' },
    Notification: function Notification () {},
    shell: { openPath: async () => '' },
    dialog: null, // set per-test
  }
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub
    return origLoad.call(this, request, parent, isMain)
  }
  process.on('exit', () => { Module._load = origLoad })
  // Inject the mock updater module BEFORE requiring handlers/system.js (it requires ../updater).
  const updaterPath = require.resolve('../../../src/main/updater.js')
  require.cache[updaterPath] = { id: updaterPath, filename: updaterPath, loaded: true, exports: UPDATER_MOCK }
  globalThis.__f4ElectronStub = electronStub
}

function makeSystemCtx ({ sessionLive, dialogResponse, dialogThrows }) {
  const wc = { id: 42 }
  return {
    isLocked: () => false,
    allowWithinRate: () => true,
    i18n: { mt: k => k },
    app: { getPath: () => TMP },
    getMainWindow: () => ({ webContents: wc, isDestroyed: () => false }),
    isSafeExternal: u => /^https?:/i.test(u || ''),
    tomatoSession: { hasRunningSession: () => sessionLive },
  }
}

async function systemHandler ({ sessionLive, dialogResponse, dialogThrows }) {
  globalThis.__f4ElectronStub.dialog = {
    showMessageBox: async () => {
      if (dialogThrows) throw new Error('dialog exploded')
      return { response: dialogResponse }
    },
  }
  delete require.cache[require.resolve('../../../src/main/handlers/system.js')]
  const systemHandlers = require('../../../src/main/handlers/system.js')
  const ctx = makeSystemCtx({ sessionLive })
  const handlers = systemHandlers(ctx)
  const e = { sender: ctx.getMainWindow().webContents }
  return handlers['updater:quit-and-install'](e)
}

test('#2 running pomodoro + user cancels the confirm → install refused (false)', async () => {
  UPDATER_MOCK.quitAndInstallCalls = 0
  const r = await systemHandler({ sessionLive: true, dialogResponse: 1 })
  assert.equal(r, false)
  assert.equal(UPDATER_MOCK.quitAndInstallCalls, 0)
})

test('#2 running pomodoro + user confirms → install proceeds', async () => {
  UPDATER_MOCK.quitAndInstallCalls = 0
  const r = await systemHandler({ sessionLive: true, dialogResponse: 0 })
  assert.equal(r, true)
  assert.equal(UPDATER_MOCK.quitAndInstallCalls, 1)
})

test('#2 no running pomodoro → install proceeds without a dialog', async () => {
  UPDATER_MOCK.quitAndInstallCalls = 0
  const r = await systemHandler({ sessionLive: false, dialogResponse: 99 /* never shown */ })
  assert.equal(r, true)
  assert.equal(UPDATER_MOCK.quitAndInstallCalls, 1)
})

test('#2 a failed confirm dialog carries CANCEL semantics (never kills a live pomodoro)', async () => {
  UPDATER_MOCK.quitAndInstallCalls = 0
  const r = await systemHandler({ sessionLive: true, dialogThrows: true })
  assert.equal(r, false)
  assert.equal(UPDATER_MOCK.quitAndInstallCalls, 0)
})

/* ------------------------------------------------------------------ *
 * #3 updater download stall watchdog                                  *
 * ------------------------------------------------------------------ */
process.env.PICKDONE_UPDATER_STALL_MS = '150' // test-budget stall window (default is 90s)
process.env.PICKDONE_UPDATER_RETRY_MS = '200' // test-budget retry backoff (default is 30s)

function freshUpdater (autoUpdaterStub) {
  const origLoad2 = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => TMP, getVersion: () => '0.0.0-f4' } }
    if (request === 'electron-updater') return { autoUpdater: autoUpdaterStub }
    if (request === '../updater') return autoUpdaterStub
    return origLoad2.call(this, request, parent, isMain)
  }
  process.on('exit', () => { Module._load = origLoad2 })
  const resolved = require.resolve('../../../src/main/updater.js')
  delete require.cache[resolved]
  return require('../../../src/main/updater.js')
}

function makeAutoUpdaterStub () {
  const handlers = {}
  return {
    isUpdaterActive: () => true,
    autoDownload: true,
    on: (evt, fn) => { handlers[evt] = fn },
    checkForUpdates: async () => { handlers['update-not-available']?.({}); return {} },
    fire: (evt, arg) => handlers[evt]?.(arg),
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

test('#3 a stalled download (no progress past the window) fails into error + schedules the single retry', async () => {
  const stub = makeAutoUpdaterStub()
  const updater = freshUpdater(stub)
  updater.init(null)
  stub.fire('update-available', { version: '9.9.9' }) // autoDownload=true → 'downloading'
  assert.equal(updater.getStatus().status, 'downloading')
  stub.fire('download-progress', { percent: 10 })
  assert.equal(updater.getStatus().status, 'downloading')
  await sleep(300) // > PICKDONE_UPDATER_STALL_MS with NO further progress
  const st = updater.getStatus()
  assert.equal(st.status, 'error', 'stall surfaced as an honest error (red before the fix: stayed downloading forever)')
  assert.match(st.info.message, /stalled/)
  // the shared retry path arms the backoff check; checkForUpdates resolves it into uptodate
  await sleep(600)
  assert.equal(updater.getStatus().status, 'uptodate', 'the stall error runs the SAME single-backoff-retry path as a normal error')
})

test('#3 steady progress within the window does NOT trip the watchdog, and success clears it', async () => {
  const stub = makeAutoUpdaterStub()
  const updater = freshUpdater(stub)
  updater.init(null)
  stub.fire('update-available', { version: '9.9.9' })
  for (let i = 0; i < 4; i++) { stub.fire('download-progress', { percent: i * 25 }); await sleep(60) }
  assert.equal(updater.getStatus().status, 'downloading', 'progress kept refreshing the watchdog')
  stub.fire('update-downloaded', { version: '9.9.9' })
  await sleep(300)
  assert.equal(updater.getStatus().status, 'ready', 'downloaded state is settled and the cleared watchdog cannot re-mark it')
})

/* ------------------------------------------------------------------ *
 * #9 logger.js doc drift                                              *
 * ------------------------------------------------------------------ */
test('#9 logger.js no longer advertises the nonexistent export-diagnostics feature', async () => {
  const src = fs.readFileSync(new URL('../../../renderer/js/utils/logger.js', import.meta.url), 'utf8')
  assert.ok(!/Export diagnostic logs.*bundles/.test(src), 'old drifting doc line removed')
  assert.match(src, /log:open-dir/, 'points at the real log-directory channel')
  assert.match(src, /DISABLED/, 'notes the FeedbackModal checkbox is currently disabled')
})
