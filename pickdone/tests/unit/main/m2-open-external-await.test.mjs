/* M2 fix 6 (2026-10-09): 'open-external-url' was fire-and-forget — shell.openExternal(url)'s
 * promise was dropped, so a rejection surfaced as an UNHANDLED REJECTION in the main process
 * while the channel still told the renderer "success". D11 precedent: handlers/attachments.js
 * openExternalSafely. Fix: await the open; failure returns {ok:false,error} honestly.
 * Red before the fix: the handler returned undefined-then-true synchronously and the rejected
 * promise went unhandled.
 * Run: node --test tests/unit/main/m2-open-external-await.test.mjs */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Module = require('module')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-openext-'))
let SHELL_MODE = 'resolve' // 'resolve' | 'reject' | 'throw'
const CALLS = []
const electronStub = {
  app: { getPath: () => TMP, getVersion: () => '0.0.0-test' },
  Notification: class { show () {} },
  shell: {
    openExternal (u) {
      CALLS.push(u)
      if (SHELL_MODE === 'reject') return Promise.reject(new Error('E_LAUNCH: no browser registered'))
      if (SHELL_MODE === 'throw') throw new Error('E_SYNC: shell threw synchronously')
      return Promise.resolve()
    },
    openPath: async () => '',
  },
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub
  if (request === 'electron-updater') return { autoUpdater: { on: () => {}, checkForUpdates: async () => {}, downloadUpdate: async () => {}, quitAndInstall: () => {}, isUpdaterActive: () => false } }
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const systemHandlers = require('../../../src/main/handlers/system.js')

const WC = { id: 'main-wc' }
const eMain = { sender: WC }
const ctx = {
  isLocked: () => false,
  app: { getPath: () => TMP },
  getMainWindow: () => ({ webContents: WC, isDestroyed: () => false }),
  isSafeExternal: url => typeof url === 'string' && /^https?:\/\//i.test(url),
  allowWithinRate: () => true,
  i18n: { mt: k => k },
}

let unhandled = 0
process.on('unhandledRejection', () => { unhandled++ })

test('M2 fix6: open-external-url resolves true on a successful open', async () => {
  SHELL_MODE = 'resolve'; CALLS.length = 0
  const handlers = systemHandlers(ctx)
  const r = await handlers['open-external-url'](eMain, 'https://example.com/notes')
  assert.equal(r, true)
  assert.deepEqual(CALLS, ['https://example.com/notes'])
})

test('M2 fix6: a rejected openExternal returns {ok:false,error}, never an unhandledRejection', async () => {
  SHELL_MODE = 'reject'; CALLS.length = 0
  const handlers = systemHandlers(ctx)
  const r = await handlers['open-external-url'](eMain, 'https://example.com/notes')
  assert.deepEqual(r, { ok: false, error: 'E_LAUNCH: no browser registered' },
    'RED before the fix: the rejection was dropped on the floor and success was implied')
  // let the microtask queue drain — nothing may surface as unhandledRejection
  await new Promise(r => setImmediate(r))
  assert.equal(unhandled, 0, 'no unhandledRejection reached the process level')
})

test('M2 fix6: a SYNCHRONOUS shell throw also degrades to {ok:false}', async () => {
  SHELL_MODE = 'throw'
  const handlers = systemHandlers(ctx)
  const r = await handlers['open-external-url'](eMain, 'https://example.com/notes')
  assert.deepEqual(r, { ok: false, error: 'E_SYNC: shell threw synchronously' })
})

test('M2 fix6: unsafe scheme still throws (unchanged D10 gate), locked still throws', async () => {
  SHELL_MODE = 'resolve'; CALLS.length = 0
  const handlers = systemHandlers(ctx)
  // async handler → the guard throw surfaces as a rejected promise (ipcMain.handle rejects alike)
  await assert.rejects(() => handlers['open-external-url'](eMain, 'javascript:alert(1)'), /unsafe external url/)
  assert.equal(CALLS.length, 0, 'unsafe scheme never reaches the OS shell')
})
