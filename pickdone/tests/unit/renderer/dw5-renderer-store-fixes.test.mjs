/**
 * dw-wave5 renderer-store domain fixes:
 *  1. MAIN_CONSUMED_SETTINGS now includes autoDownloadUpdates (src/main/updater.js reads it from
 *     config.json via syncAutoDownload on every check) — and initFromDb routes a DB-mirror patch
 *     carrying it through the `update` action so the value reaches config.json instead of
 *     drifting between the renderer store and the updater forever.
 *  2. writeAutoBackupCore records the failure honestly in runtime state (autoBackupLastFailAt +
 *     autoBackupLastError) instead of only zeroing autoBackupLastAt (which made a persistently
 *     failing backup read as "never ran" in Settings→Data).
 *  3. i18n: update.availableToast exists in BOTH the zh-CN and en-US H shards (bilingual parity).
 * Run: node --test tests/unit/renderer/dw5-renderer-store-fixes.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
let importSeq = 0
const importSrc = p => import(pathToFileURL(path.join(ROOT, p)).href + '?fresh=' + (++importSeq))

const LS = new Map()
function resetLs () {
  LS.clear()
  globalThis.localStorage = {
    getItem: k => (LS.has(k) ? LS.get(k) : null),
    setItem: (k, v) => LS.set(k, String(v)),
    removeItem: k => LS.delete(k)
  }
}

test('dw5-1: autoDownloadUpdates is in MAIN_CONSUMED_SETTINGS and mainConsumedSettingsDiff picks it up when non-default', async () => {
  const { MAIN_CONSUMED_SETTINGS, mainConsumedSettingsDiff, DEFAULT_SETTINGS } = await importSrc('renderer/js/store/settings.js')
  assert.ok(MAIN_CONSUMED_SETTINGS.includes('autoDownloadUpdates'), 'updater.js consumes it from config.json — it must be in the contract list')
  const flipped = { ...DEFAULT_SETTINGS, autoDownloadUpdates: false }
  assert.ok('autoDownloadUpdates' in mainConsumedSettingsDiff(flipped), 'a non-default value must reach the updateSettings IPC')
  assert.ok(!('autoDownloadUpdates' in mainConsumedSettingsDiff({ ...DEFAULT_SETTINGS })), 'default value stays out of the diff')
})

test('dw5-2: initFromDb routes an autoDownloadUpdates change through the update action (IPC, not a raw commit)', async () => {
  const settings = (await importSrc('renderer/js/store/settings.js')).default
  resetLs()
  const dispatches = []
  const ipc = []
  globalThis.window.todoAPI = {
    dbCall: async op => (op === 'getMeta' ? JSON.stringify({ _savedAt: Date.now() + 5000, schemaV: 1, autoDownloadUpdates: false }) : null),
    getSettings: () => Promise.resolve(null),
    updateSettings: p => { ipc.push(p); return Promise.resolve(true) }
  }
  const state = { ...settings.state, shortcutKeySettings: { ...settings.state.shortcutKeySettings } }
  await settings.actions.initFromDb({
    state,
    commit: (m, p) => { dispatches.push('commit:' + m); Object.assign(state, p) },
    dispatch: async (a, p) => { dispatches.push('dispatch:' + a); Object.assign(state, p); if (a === 'update') await globalThis.window.todoAPI.updateSettings(p) }
  })
  assert.ok(dispatches.includes('dispatch:update'), 'the config-consumed key must ride the update action (was: raw commit, config.json never written)')
  assert.ok(ipc.length && ipc[0].autoDownloadUpdates === false, 'updateSettings IPC carries the restored value so the updater stops drifting')
})

test('dw5-3: writeAutoBackupCore records the failure (timestamp + reason) in runtime state, success clears it', async () => {
  const { writeAutoBackupCore } = await importSrc('renderer/js/store/todoBackup.js')
  const { loadRuntime } = await importSrc('renderer/js/store/runtimeState.js')
  resetLs()
  const ctx = {}
  const base = { state: {}, rootState: { settings: {}, auth: { user: null, lastLoginRecord: null }, category: { list: [] }, habits: { habits: [], moments: [] } } }
  globalThis.window.todoAPI = {
    dbCall: async () => null,
    runAutoBackup: async () => ({ ok: false, error: 'EACCES: permission denied, mkdir' })
  }
  const r1 = await writeAutoBackupCore(ctx, base)
  assert.equal(r1, false, 'failure is reported to the caller')
  const rt1 = loadRuntime()
  assert.equal(rt1.autoBackupLastAt, 0, 'last-run stays zeroed on failure')
  assert.ok(rt1.autoBackupLastFailAt > 0, 'fail timestamp recorded (Settings→Data can show "last backup failed")')
  assert.ok(String(rt1.autoBackupLastError).includes('EACCES'), 'the reason is kept for the honest status line')

  globalThis.window.todoAPI.runAutoBackup = async () => ({ ok: true, file: 'auto-x.json' })
  const r2 = await writeAutoBackupCore(ctx, base)
  assert.equal(r2, true)
  const rt2 = loadRuntime()
  assert.ok(rt2.autoBackupLastAt > 0, 'success stamps last-run')
  assert.equal(rt2.autoBackupLastFailAt, 0, 'a later success clears the stale failure line')
  assert.equal(rt2.autoBackupLastError, '')
})

test('dw5-4: writeAutoBackupCore keeps the honest failure line even when the IPC throws (locked / main-window-only)', async () => {
  const { writeAutoBackupCore } = await importSrc('renderer/js/store/todoBackup.js')
  const { loadRuntime } = await importSrc('renderer/js/store/runtimeState.js')
  resetLs()
  globalThis.window.todoAPI = {
    dbCall: async () => null,
    runAutoBackup: async () => { throw new Error('app is locked') }
  }
  await writeAutoBackupCore({}, { state: {}, rootState: { settings: {}, auth: { user: null, lastLoginRecord: null }, category: { list: [] }, habits: { habits: [], moments: [] } } })
  const rt = loadRuntime()
  assert.ok(rt.autoBackupLastFailAt > 0 && String(rt.autoBackupLastError).includes('locked'), 'thrown failures are recorded too, not just console.error-ed')
})

test('dw5-5: update.availableToast exists in both the zh-CN and en-US H shards (bilingual parity)', async () => {
  const zh = (await importSrc('renderer/js/i18n/locales/zh-CN-H.js')).default
  const en = (await importSrc('renderer/js/i18n/locales/en-US-H.js')).default
  assert.ok(zh.statsH.update && zh.statsH.update.availableToast, 'zh-CN-H must define statsH.update.availableToast (one-shot new-version toast copy)')
  assert.ok(en.statsH.update && en.statsH.update.availableToast, 'en-US-H must define it too')
  assert.ok(zh.statsH.SettingsModal.lastBackupFailPrefix && en.statsH.SettingsModal.lastBackupFailPrefix, 'backup-failure status prefix exists in both languages')
})
