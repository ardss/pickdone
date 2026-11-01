/* W26 fix 3 (2026-11-01): external-db-watch CLI settings hot-sync — the change watermark
 * (lastSettingsSavedAt/lastSettingsDoc) advanced unconditionally while the actual push was gated
 * on `win`; with the main window absent (tray quit-mode keeps the app alive after window
 * destruction) a CLI settings change was silently CONSUMED and the window rebuilt later kept the
 * pre-CLI settings forever. Fix: when getMainWindow() returns nothing, roll the watermark AND the
 * baseline doc back — the next tick after the window recovers re-detects and hot-applies.
 * Run: node --test tests/unit/main/w26-watch-settings-window-rollback.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const { createExternalDbWatch } = require_('../../../src/main/external-db-watch.js')
const fixUtil = require_('../../../src/main/fix-util.js')

function makeWatcher ({ meta, getMainWindow, windows }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w26-watch-'))
  const deps = {
    app: { getPath: () => dir },
    log: { warn: () => {}, info: () => {}, error: () => {} },
    dbm: {
      call: (op, p) => {
        if (op === 'getMeta') return Object.prototype.hasOwnProperty.call(meta, p) ? meta[p] : null
        if (op === 'settingsRowsMaxUpdated') return 0
        return null
      }
    },
    fixUtil,
    extWatchGate: { canPoll: () => true },
    nextWatchBaseline: (cur, read) => { const m = read(); return m == null ? cur : m },
    scheduler: { reloadAll: () => {} },
    getMainWindow,
    isLocked: () => false,
    dbApi: () => ({}),
    broadcastTodosChanged: () => {},
    broadcastTomatoRecordsChanged: () => {},
    BrowserWindow: { getAllWindows: () => windows() }
  }
  const api = createExternalDbWatch(deps)
  api.watchDbForExternalWrites()
  return { api, cleanup: () => { api.stopForQuit(); fs.rmSync(dir, { recursive: true, force: true }) } }
}

test('w26[3]: a CLI settings change with NO main window is not consumed — the window rebuild gets it on the next tick', () => {
  const meta = { 'db.settingsState': JSON.stringify({ _savedAt: 1000, themeMode: 'dark' }) }
  let win = null
  const sent = []
  const mkWin = () => ({ isDestroyed: () => false, webContents: { send: (...a) => sent.push(a) } })
  const { api, cleanup } = makeWatcher({
    meta,
    getMainWindow: () => win,
    windows: () => (win ? [win] : [])
  })
  try {
    // CLI writes settings while the main window is destroyed (tray quit-mode): blob _savedAt moves.
    meta['db.settingsState'] = JSON.stringify({ _savedAt: 2000, themeMode: 'dark', locale: 'en' })
    api.__pollTickForTests()
    assert.equal(sent.length, 0, 'no window: nothing pushed yet')
    // Window is rebuilt afterwards; the blob is UNCHANGED. Red before the fix: the watermark had
    // already been consumed to 2000, so no tick ever pushed and the rebuilt window kept the old
    // settings forever.
    win = mkWin()
    api.__pollTickForTests()
    assert.equal(sent.length, 1, 'red before the fix: the deferred change must hot-apply after the window recovers')
    const [channel, patch, originSavedAt] = sent[0]
    assert.equal(channel, 'external-settings-changed')
    assert.equal(patch.locale, 'en', 'the patch carries the CLI change')
    assert.equal(originSavedAt, 2000, 'the blob stamp rides as the origin marker')
  } finally { cleanup() }
})

test('w26[3b]: with a window present the push is immediate and the watermark advances exactly once (echo guard intact)', () => {
  const meta = { 'db.settingsState': JSON.stringify({ _savedAt: 1000, themeMode: 'dark' }) }
  const win = { isDestroyed: () => false, webContents: { send: () => {} } }
  const sent = []
  const realWin = { isDestroyed: () => false, webContents: { send: (...a) => sent.push(a) } }
  const { api, cleanup } = makeWatcher({
    meta,
    getMainWindow: () => win,
    windows: () => [realWin]
  })
  try {
    meta['db.settingsState'] = JSON.stringify({ _savedAt: 3000, themeMode: 'dark', locale: 'jp' })
    api.__pollTickForTests()
    assert.equal(sent.length, 1, 'window present: change pushed immediately')
    // Same blob again (unchanged): the advanced watermark must not re-push (existing echo guard).
    api.__pollTickForTests()
    assert.equal(sent.length, 1, 'unchanged blob: no re-push')
  } finally { cleanup() }
})
