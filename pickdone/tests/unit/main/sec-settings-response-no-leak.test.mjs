// Regression test for sec-settings-response-leaks-lock-secret:
// get-settings strips securityLockPassword/securityLockQuestion before sending config to a
// renderer, but the write channels ('notify-settings-updated', 'set-app-locale') returned the
// FULL merged config from writeConfig (config-store.js writeConfig returns
// mergeConfig(readConfig(), patch)), which carries the lock ciphertext + plaintext security
// question back to the calling window. Fix: both write handlers return a sanitized copy.
// Without the fix the returned-object assertions below fail.
// Run: node --test tests/unit/main/sec-settings-response-no-leak.test.mjs
import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

function makeEnv () {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-settings-leak-'))
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
    appLocale: 'zh-CN',
    trayNoise: 'off',
    securityLockPassword: 'enc1:ciphertext-hunter2',
    securityLockQuestion: 'what is my pets name'
  }))
  return tmp
}

function loadSettingsModule (tmp) {
  const electron = {
    app: { getPath: () => tmp, setLoginItemSettings: () => {} },
    ipcMain: { handle: () => {} }
  }
  const Module = require('node:module')
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electron
    if (request === 'electron-log') return { warn: () => {}, info: () => {}, error: () => {} }
    return origLoad.call(this, request, parent, isMain)
  }
  try {
    const configStore = require('../../../src/main/config-store')
    configStore.__setConfigDir(tmp, tmp)
    // Minimal ctx: settings.js only needs these from ctx.
    const mainFake = { webContents: { id: 1 }, isDestroyed: () => false, setTitle: () => {} }
    const ctx = {
      readConfig: configStore.readConfig,
      writeConfig: configStore.writeConfig,
      app: electron.app,
      getMainWindow: () => mainFake,
      applyShortcuts: () => {},
      rebuildTrayMenu: () => {},
      getTray: () => null
    }
    const makeHandlers = require('../../../src/main/handlers/settings')
    const handlers = makeHandlers(ctx)
    return { handlers, configStore, tmp, mainFake }
  } finally {
    Module._load = origLoad
  }
}

test('notify-settings-updated response must not carry security lock secrets', () => {
  const env = makeEnv()
  const { handlers, configStore } = loadSettingsModule(env)
  const tomatoFloat = require('../../../src/main/tomato-float')
  // Simulate the float window's legitimate white-noise write (self-sender path).
  const origIsSelf = tomatoFloat.isSelfSender
  tomatoFloat.isSelfSender = () => true
  try {
    const ret = handlers['notify-settings-updated']({ sender: { id: 99 } }, { trayNoise: 'rain' })
    assert.ok(ret, 'handler should return the updated config object')
    assert.ok(!('securityLockPassword' in ret), 'response leaks securityLockPassword: ' + JSON.stringify(ret && ret.securityLockPassword))
    assert.ok(!('securityLockQuestion' in ret), 'response leaks securityLockQuestion')
    assert.strictEqual(ret.trayNoise, 'rain')
    // The fix shapes the response only; persistence must still hold the secrets.
    const onDisk = JSON.parse(fs.readFileSync(path.join(env, 'config.json'), 'utf8'))
    assert.strictEqual(onDisk.securityLockPassword, 'enc1:ciphertext-hunter2')
    assert.strictEqual(onDisk.securityLockQuestion, 'what is my pets name')
    assert.strictEqual(onDisk.trayNoise, 'rain')
    assert.strictEqual(configStore.readConfig().securityLockPassword, 'enc1:ciphertext-hunter2')
  } finally {
    tomatoFloat.isSelfSender = origIsSelf
  }
})

test('set-app-locale response must not carry security lock secrets', () => {
  const env = makeEnv()
  const { handlers, mainFake } = loadSettingsModule(env)
  const ret = handlers['set-app-locale']({ sender: mainFake.webContents }, 'zh-CN')
  assert.ok(ret, 'handler should return the updated config object')
  assert.ok(!('securityLockPassword' in ret), 'response leaks securityLockPassword')
  assert.ok(!('securityLockQuestion' in ret), 'response leaks securityLockQuestion')
  assert.strictEqual(ret.appLocale, 'zh-CN')
  const onDisk = JSON.parse(fs.readFileSync(path.join(env, 'config.json'), 'utf8'))
  assert.strictEqual(onDisk.securityLockPassword, 'enc1:ciphertext-hunter2')
})
