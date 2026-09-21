/* D6 security round (2026-09-21) — destructive-channel gates:
 *   F2   read-critical-state-backup: assertMainWindow, symmetric with the write twin
 *   F6   delete-file / delete-todo-files: assertMainWindow (upload keeps its 50MB cap)
 *   F7   svg removed from the attachment extension whitelist (shell.openPath script escape)
 *   F8   updater check/download/quit-and-install: main-window + locked-state gates
 * Handler modules instantiated with fake ctx; updater stubbed at require level.
 * Run: node --test tests/unit/main/d6-sec-channel-gates.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const Module = require_('module')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'd6-sec-gates-'))
const MAIN = { webContents: { id: 'main' }, isDestroyed: () => false }
const eMain = { sender: MAIN.webContents }
const eAux = { sender: { id: 'aux-float' } }

const updaterCalls = []
const stubs = {
  electron: {
    app: { getPath: () => TMP, isPackaged: false },
    BrowserWindow: class {},
    Notification: class { show () {} },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openPath: async () => '', openExternal: async () => '' },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 800, height: 600 } }) }
  },
  '../updater': {
    check: async () => { updaterCalls.push('check'); return { active: false } },
    downloadUpdate: async () => { updaterCalls.push('download'); return false },
    quitAndInstall: () => { updaterCalls.push('install'); return false },
    getStatus: () => ({ active: false }),
    init () {}, flushOnceOnReady () {}, forwardFlushAck () {}
  }
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (stubs[request]) return stubs[request]
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const ctxBase = {
  isLocked: () => false,
  isLockWindow: () => false,
  isSafeExternal: () => false,
  app: { getPath: () => TMP },
  getMainWindow: () => MAIN,
  broadcastWhiteNoiseUpdated: () => {},
  notifySyncChange: () => {},
  allowWithinRate: () => true,
  i18n: { mt: k => k },
  attachDir: () => TMP
}

// ---- F2: read-critical-state-backup main-window gate ----
const backupHandlers = require_('../../../src/main/handlers/backup.js')
test('F2: read-critical-state-backup rejects non-main-window senders (aux cannot exfiltrate the disaster snapshot)', () => {
  const api = backupHandlers(ctxBase)
  assert.throws(() => api['read-critical-state-backup'](eAux), /forbidden: main window only/,
    'the read twin must be gated exactly like write-critical-state-backup')
  const r = api['read-critical-state-backup'](eMain)
  // (the external default backup root is machine-global — a dev machine may legitimately have a
  // real snapshot there — so only the shape is asserted, never its content)
  assert.ok(r === null || typeof r === 'string', 'main window passes the gate and gets the snapshot')
})
test('F2: read-critical-state-backup still honors the locked-state gate', () => {
  const api = backupHandlers({ ...ctxBase, isLocked: () => true })
  assert.throws(() => api['read-critical-state-backup'](eMain), /locked/)
})

// ---- F6: destructive attachment channels main-window-only ----
const attachmentHandlers = require_('../../../src/main/handlers/attachments.js')
test('F6: delete-file rejects auxiliary windows, accepts the main window', () => {
  const api = attachmentHandlers(ctxBase)
  assert.throws(() => api['delete-file'](eAux, 'local://whatever.png'), /forbidden: main window only/)
  assert.equal(api['delete-file'](eMain, 'local://definitely-missing.png'), true, 'main window passes (ENOENT = idempotent success)')
})
test('F6: delete-todo-files rejects auxiliary windows, accepts the main window', () => {
  const api = attachmentHandlers(ctxBase)
  assert.throws(() => api['delete-todo-files'](eAux, 'taskX'), /forbidden: main window only/)
  assert.equal(api['delete-todo-files'](eMain, 'taskX'), true)
})
test('F6: upload-attachment stays non-main-window-reachable (float uploads are legitimate) and keeps its 50MB cap', async () => {
  const { saveAttachment } = require_('../../../src/main/attachments.js')
  const api = attachmentHandlers(ctxBase)
  // float/aux sender is NOT rejected at the channel gate (isLocked only): the handler actually
  // runs and fails on payload validation instead of the main-window guard
  await assert.rejects(api['upload-attachment'](eAux, { taskId: 't', name: 'x.png', dataBase64: '!!!bad!!!' }), /invalid base64/)
  const big = Buffer.alloc(50 * 1024 * 1024 + 1, 7).toString('base64')
  await assert.rejects(saveAttachment({ taskId: 't', name: 'big.png', dataBase64: big }), /too large/,
    'the 50MB size cap must stay in force')
})

// ---- F7: svg dropped from the extension whitelist ----
test('F7: svg uploads are rejected at the whitelist (script-capable type via shell.openPath)', async () => {
  const { saveAttachment } = require_('../../../src/main/attachments.js')
  const b64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64')
  await assert.rejects(saveAttachment({ taskId: 't', name: 'evil.svg', dataBase64: b64 }), /extension not allowed/)
  // sibling raster type still accepted (whitelist is not broken wholesale)
  const png = Buffer.from('89504e47', 'hex').toString('base64')
  const saved = await saveAttachment({ taskId: 'd6svg', name: 'ok.png', dataBase64: png })
  assert.equal(saved.ext, 'png')
  assert.ok(fs.existsSync(path.join(require_('../../../src/main/attachments.js').attachDir(), saved.key)))
})

// ---- F8: updater channels gated ----
const systemHandlers = require_('../../../src/main/handlers/system.js')
test('F8: updater check/download/quit-and-install reject auxiliary windows', () => {
  const api = systemHandlers(ctxBase)
  for (const ch of ['updater:check', 'updater:download', 'updater:quit-and-install']) {
    assert.throws(() => api[ch](eAux), /forbidden: main window only/, ch + ' must be main-window-only')
  }
  assert.deepEqual(updaterCalls, [], 'no updater action may run for a rejected sender')
})
test('F8: updater channels honor the locked-state gate; main window passes; status stays open', async () => {
  const api = systemHandlers({ ...ctxBase, isLocked: () => true })
  for (const ch of ['updater:check', 'updater:download', 'updater:quit-and-install']) {
    assert.throws(() => api[ch](eMain), /locked/, ch + ' must refuse while locked')
  }
  const open = systemHandlers(ctxBase)
  assert.deepEqual(await open['updater:check'](eMain), { active: false })
  assert.deepEqual(updaterCalls, ['check'])
  assert.deepEqual(open['updater:status'](), { active: false }, 'status read stays ungated (leaks nothing)')
})
