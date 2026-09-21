/**
 * D6 F3 — renderer settings initFromDb routes the config-consumed key set through the `update`
 * action (fix on branch fix/d6-cli). main's 'notify-settings-updated' (only reachable via the
 * `update` action's updateSettings IPC) writes config.json — the sole source windows.js consumes
 * for closeActionMinimize / hideMainWindowOnStartup / enableSecurityLock / hardware-accel — and
 * hot-applies runWhenComputerStart via app.setLoginItemSettings. A raw commit updated only the
 * renderer store, so a CLI-written (or LAN-synced) value reverted on next launch and the OS login
 * item never followed.
 * Run: node --test tests/unit/renderer/f3-settings-config-consumed.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
let importSeq = 0
const importSrc = p => import(pathToFileURL(path.join(ROOT, p)).href + '?fresh=' + (++importSeq))

const LS_MIRROR = new Map()
function resetLs () {
  LS_MIRROR.clear()
  globalThis.localStorage = {
    getItem: k => (LS_MIRROR.has(k) ? LS_MIRROR.get(k) : null),
    setItem: (k, v) => LS_MIRROR.set(k, String(v)),
    removeItem: k => LS_MIRROR.delete(k)
  }
}

/** Boot initFromDb against a stubbed bridge; returns the recorded dispatch/IPC traffic. */
async function bootWithBlob (blob, state) {
  const settings = (await importSrc('renderer/js/store/settings.js')).default
  const dispatches = []
  const ipc = []
  globalThis.window.todoAPI = {
    dbCall: async op => (op === 'getMeta' ? JSON.stringify(blob) : null),
    getSettings: () => Promise.resolve(null), // no config.json shortcut seed (blob untouched default → cfg null)
    updateSettings: p => { ipc.push(p); return Promise.resolve(true) }
  }
  const ctx = {
    state,
    commit: (m, p) => { dispatches.push(['commit:' + m, p]); Object.assign(state, p) },
    dispatch: async (a, p) => {
      dispatches.push(['dispatch:' + a, p]); Object.assign(state, p)
      if (a === 'update') await globalThis.window.todoAPI.updateSettings(p) // mirror the real update action's IPC step
    }
  }
  await settings.actions.initFromDb(ctx)
  return { dispatches, ipc }
}


test('f3-1: a DB-mirror patch carrying runWhenComputerStart rides the update action (IPC → config.json/login item)', async () => {
  resetLs()
  const settings = (await importSrc('renderer/js/store/settings.js')).default
  const { dispatches, ipc } = await bootWithBlob(
    { _savedAt: Date.now() + 5000, schemaV: 1, runWhenComputerStart: true, showNoDate: false },
    { ...settings.state, shortcutKeySettings: { ...settings.state.shortcutKeySettings } })
  const upd = dispatches.find(([a]) => a === 'dispatch:update')
  assert.ok(upd, 'patch dispatched through the update action (was: raw commit, config.json never written)')
  assert.equal(upd[1].runWhenComputerStart, true)
  assert.equal(upd[1].showNoDate, false, 'the whole patch rides along (no split needed)')
  assert.ok(ipc.length && ipc[0].runWhenComputerStart === true, 'updateSettings IPC fired so main writes config.json + login item')
})

test('f3-1b: closeActionMinimize / hideMainWindowOnStartup / enableHardwareAcceleration / enableSecurityLock route through update too', async () => {
  for (const key of ['closeActionMinimize', 'hideMainWindowOnStartup', 'enableHardwareAcceleration', 'enableSecurityLock']) {
    resetLs()
    const settings = (await importSrc('renderer/js/store/settings.js')).default
    // a value that actually differs from the default, or initFromDb's equality check drops the key
    const flipped = !settings.state[key]
    const { dispatches } = await bootWithBlob(
      { _savedAt: Date.now() + 5000, schemaV: 1, [key]: flipped },
      { ...settings.state, shortcutKeySettings: { ...settings.state.shortcutKeySettings } })
    const upd = dispatches.find(([a]) => a === 'dispatch:update')
    assert.ok(upd && key in upd[1], key + ' routed through the update action')
  }
})

test('f3-1c: a patch with NO config-consumed keys still takes the cheap raw-commit path', async () => {
  resetLs()
  const settings = (await importSrc('renderer/js/store/settings.js')).default
  const { dispatches, ipc } = await bootWithBlob(
    { _savedAt: Date.now() + 5000, schemaV: 1, showNoDate: false },
    { ...settings.state, shortcutKeySettings: { ...settings.state.shortcutKeySettings } })
  assert.ok(dispatches.some(([a]) => a === 'commit:updateSettings'), 'plain keys keep the raw commit')
  assert.ok(!dispatches.some(([a]) => a === 'dispatch:update'), 'no update dispatch for plain keys')
  assert.equal(ipc.length, 0, 'no IPC for plain keys (unchanged behavior)')
})
