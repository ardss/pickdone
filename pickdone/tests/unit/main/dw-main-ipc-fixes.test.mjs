/* D7 follow-up round (2026-09-22) — main-ipc findings 1..9:
 *   F1 (P2) notify-settings-updated: per-sender dangerous-key strip — a trapped FLOAT window can no
 *           longer send {enableSecurityLock:false} (silent lock kill) or shortcutKeySettings
 *           (global hotkey re-registration); the main window keeps its full settings surface.
 *   F2 (P3) fsync: writeFileDurable (tmp+fsync+rename+dir-fsync) now backs the db.key writes, the
 *           disaster-recovery JSON and config.json — a power cut can no longer persist the rename
 *           while the data is still OS-cached-only.
 *   F3 (P3) snowDedup:<taskId>:<key> meta keys are purged with their owning task (hardDelete/
 *           hardDeleteMany/purgeRecycleBin/purgeSeedTodos) instead of accumulating forever.
 *   F4 (P3) attachment store quota (500MB total) — upload-attachment loops can no longer fill the
 *           disk 50MB at a time.
 *   F5 (P3) open-external-url gains the isLocked gate (last ungated data-plane channel).
 *   F6 (P3) select-user-white-noise-audio-file gains main-window + locked-state gates.
 *   F7 (P3) locked-float tomatoUpdateById rejects a patch carrying a historical endTime (dateKey
 *           is re-derived from endTime at the db layer — the row's CURRENT dateKey check alone
 *           allowed migrating a today row to any past day).
 *   F8 (P3) db:purge-recycle-bin really deletes files BEFORE rows now (comment/code contradiction).
 *   F9 (P3) tomatoAppendMany no longer leaks an explicit updatedAt into the extra JSON blob.
 * Run: node --test tests/unit/main/dw-main-ipc-fixes.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const Module = require_('module')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-main-ipc-'))
const MAIN = { webContents: { id: 'main' }, isDestroyed: () => false }
const eMain = { sender: MAIN.webContents }

const calls = { openExternal: [], dialog: 0, shortcuts: [] }
let floatSelfSender = false
let locked = false
const stubs = {
  electron: {
    app: { getPath: () => TMP, isPackaged: false, getVersion: () => '0.0.0-test', setLoginItemSettings () {}, on () {}, once () {} },
    BrowserWindow: class {},
    Notification: class { show () {} },
    dialog: { showOpenDialog: async () => { calls.dialog++; return { canceled: true, filePaths: [] } } },
    shell: { openPath: async () => '', openExternal: async u => { calls.openExternal.push(u); return '' } },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 800, height: 600 } }) }
  },
  '../i18n': { setLocale () {}, mt: k => k },
  '../tomato-float': { isSelfSender: () => floatSelfSender, isFloatSender: () => floatSelfSender },
  '../scheduler': { reminderInstances: () => [], needsCatchUp: () => false, scheduleOne () {}, reloadAll () {} },
  '../audit': { recordAppOp () {}, setDirResolver () {} }
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (stubs[request]) return stubs[request]
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const noop = () => {}
const ctxBase = {
  isLocked: () => locked,
  isLockWindow: () => false,
  app: { getPath: () => TMP },
  getMainWindow: () => MAIN,
  notifySyncChange: noop,
  allowWithinRate: () => true,
  i18n: { mt: k => k },
  attachDir: () => TMP,
  resyncDbWatch: () => null,
  broadcastTomatoRecordsChanged: noop,
  broadcastTodosChanged: noop,
  broadcastWhiteNoiseUpdated: noop,
  dbApi: () => ({}),
  showMainOrLock: noop,
  rebuildTrayMenu: noop,
  readConfig: () => ({}),
  writeConfig: p => p,
  applyShortcuts: s => { calls.shortcuts.push(s) },
  getTray: () => null
}

// ---- F1: per-sender dangerous-key strip on notify-settings-updated ----
const settingsHandlers = require_('../../../src/main/handlers/settings.js')
test('F1: a float sender cannot disable the security lock or swap shortcutKeySettings', () => {
  let written = null
  const api = settingsHandlers({ ...ctxBase, writeConfig: p => { written = p; return { shortcutKeySettings: { x: 1 }, ...p } } })
  floatSelfSender = true
  try {
    api['notify-settings-updated']({ sender: { id: 77 } }, {
      enableSecurityLock: false,
      securityLockPassword: 'enc1:evil',
      securityLockQuestion: 'evil',
      shortcutKeySettings: { quickAddGlobal: 'ctrl+shift+x' },
      runWhenComputerStart: true,
      schemaV: 999,
      whiteNoiseAudio: 'rain'
    })
  } finally { floatSelfSender = false }
  assert.equal(written.enableSecurityLock, undefined, 'enableSecurityLock must be stripped from float writes (silent lock kill)')
  assert.equal(written.securityLockPassword, undefined)
  assert.equal(written.securityLockQuestion, undefined)
  assert.equal(written.shortcutKeySettings, undefined, 'shortcutKeySettings must be stripped from float writes (hotkey re-registration)')
  assert.equal(written.runWhenComputerStart, undefined)
  assert.equal(written.schemaV, undefined)
  assert.equal(written.whiteNoiseAudio, 'rain', 'the float white-noise choice is the legitimate write and must survive')
  assert.ok(
    calls.shortcuts.every(s => !(s && s.quickAddGlobal === 'ctrl+shift+x')),
    'the injected shortcut patch must never reach applyShortcuts (the merged-config re-apply keeps the stored map, not the injected one)'
  )
})
test('F1: the main window keeps its full settings surface (lock toggle / password / shortcuts)', () => {
  let written = null
  calls.shortcuts.length = 0
  const api = settingsHandlers({ ...ctxBase, writeConfig: p => { written = p; return { shortcutKeySettings: { x: 1 }, ...p } } })
  api['notify-settings-updated'](eMain, {
    enableSecurityLock: true,
    securityLockPassword: 'enc1:ok',
    securityLockQuestion: 'q',
    shortcutKeySettings: { quickAddGlobal: 'alt+shift+t' },
    runWhenComputerStart: true
  })
  assert.equal(written.enableSecurityLock, true)
  assert.equal(written.securityLockPassword, 'enc1:ok')
  assert.equal(written.securityLockQuestion, 'q')
  assert.equal(written.shortcutKeySettings.quickAddGlobal, 'alt+shift+t')
  assert.equal(written.runWhenComputerStart, true)
  assert.equal(calls.shortcuts.length, 1, 'main-window shortcut writes still re-register')
})
test('F1: pure filter strips prototype-pollution trio for every sender', () => {
  const { stripForbiddenSettingsKeys } = require_('../../../src/main/handlers/shared.js')
  for (const float of [true, false]) {
    const clean = stripForbiddenSettingsKeys({ schemaV: 9, constructor: {}, prototype: {}, a: 1 }, { float })
    assert.equal(clean.schemaV, undefined)
    assert.equal(Object.prototype.hasOwnProperty.call(clean, 'constructor'), false, 'own constructor key stripped (the inherited Object.constructor fallback is inert data-free)')
    assert.equal(Object.prototype.hasOwnProperty.call(clean, 'prototype'), false, 'own prototype key stripped')
    assert.equal(clean.a, 1)
  }
})

// ---- F2: durable atomic writes ----
const { writeFileDurable } = require_('../../../src/main/durable-fs.js')
test('F2: writeFileDurable lands content and leaves no tmp residue', () => {
  const f = path.join(TMP, 'durable-a.txt')
  writeFileDurable(f, 'payload-1')
  assert.equal(fs.readFileSync(f, 'utf8'), 'payload-1')
  writeFileDurable(f, 'payload-2') // overwrite path
  assert.equal(fs.readFileSync(f, 'utf8'), 'payload-2')
  assert.equal(fs.existsSync(f + '.dtmp'), false, 'no .dtmp residue after success')
  assert.equal(fs.readdirSync(TMP).filter(n => n.includes('.dtmp')).length, 0)
})
test('F2: dbRecovery.writeCriticalStateBackupAtomic is durable (content lands, no .tmp residue)', () => {
  const dbRecovery = require_('../../../src/main/dbRecovery.cjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-recov-'))
  const dest = dbRecovery.writeCriticalStateBackupAtomic(dir, '{"tasks":[]}')
  assert.equal(fs.readFileSync(dest, 'utf8'), '{"tasks":[]}')
  assert.equal(fs.readdirSync(dir).filter(n => n.endsWith('.tmp')).length, 0)
})
test('F2: config-store.writeConfig still lands and parses (now through the durable path)', () => {
  const cfg = require_('../../../src/main/config-store.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-cfg-'))
  cfg.__setConfigDir(dir)
  const c = cfg.writeConfig({ appLocale: 'en' })
  assert.equal(c.appLocale, 'en')
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).appLocale, 'en')
  assert.equal(fs.readdirSync(dir).filter(n => n.endsWith('.tmp') || n.endsWith('.dtmp')).length, 0)
})
test('F2: backup atomicWriteJson keeps its {ok} contract through the durable path', () => {
  const backup = require_('../../../src/main/handlers/backup.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-bkp-'))
  const r = backup.atomicWriteJson(fs, dir, 'x.json', '{"a":1}')
  assert.deepEqual(r, { ok: true, file: 'x.json' })
  assert.equal(fs.readFileSync(path.join(dir, 'x.json'), 'utf8'), '{"a":1}')
})

// ---- real DB for F3 / F7 / F9 ----
const db = require_('../../../src/main/db.js')
db.init(fs.mkdtempSync(path.join(os.tmpdir(), 'dw-ledger-')))
// F8: wrap the cached shared module's purgeAttachmentFiles BEFORE handlers/todo is required —
// the handler destructures the binding at module load, so the wrap must already be in place.
// The wrapper only records while `purgeSpyArmed` is set.
const shared = require_('../../../src/main/handlers/shared.js')
const realPurge = shared.purgeAttachmentFiles
let purgeSpyArmed = false
let rowsAliveAtPurgeTime = null
shared.purgeAttachmentFiles = (dir, ids) => {
  if (purgeSpyArmed) {
    const rows = db.call('queryTodos', { deleted: 1 }).map(t => t.taskId)
    rowsAliveAtPurgeTime = ids.length > 0 && ids.every(id => rows.includes(id))
  }
  return realPurge(dir, ids)
}
const todoHandlers = require_('../../../src/main/handlers/todo.js')

// ---- F3: snowDedup keys die with their task ----
test('F3: hardDelete purges the task snowDedup keys; other tasks keep theirs', () => {
  db.call('upsert', { taskId: 'dwf3a', content: 'x' })
  db.call('upsert', { taskId: 'dwf3b', content: 'y' })
  db.call('setMeta', ['snowDedup:dwf3a:111', '1'])
  db.call('setMeta', ['snowDedup:dwf3b:222', '1'])
  db.call('hardDelete', 'dwf3a')
  assert.equal(db.call('getMeta', 'snowDedup:dwf3a:111'), null, 'the deleted task dedup key must be purged')
  assert.equal(db.call('getMeta', 'snowDedup:dwf3b:222'), '1', 'unrelated task keys must survive')
})
test('F3: hardDeleteMany purges keys for every id in the batch', () => {
  db.call('upsert', { taskId: 'dwf3c', content: 'x' })
  db.call('upsert', { taskId: 'dwf3d', content: 'y' })
  db.call('setMeta', ['snowDedup:dwf3c:1', '1'])
  db.call('setMeta', ['snowDedup:dwf3d:2', '1'])
  db.call('hardDeleteMany', ['dwf3c', 'dwf3d'])
  assert.equal(db.call('getMeta', 'snowDedup:dwf3c:1'), null)
  assert.equal(db.call('getMeta', 'snowDedup:dwf3d:2'), null)
})
test('F3: bumpSnow dedup fence still works and its key is purged by hardDelete', () => {
  db.call('upsert', { taskId: 'dwf3e', content: 'x' })
  const r1 = db.call('bumpSnow', { taskId: 'dwf3e', minutes: 25, dedupKey: '1000' })
  assert.deepEqual(r1, { ok: true, minutes: 25 }, 'first credit lands')
  const r2 = db.call('bumpSnow', { taskId: 'dwf3e', minutes: 25, dedupKey: '1000' })
  assert.equal(r2.deduped, true, 'replay is deduped')
  db.call('hardDelete', 'dwf3e')
  assert.equal(db.call('getMeta', 'snowDedup:dwf3e:1000'), null)
})
test('F3: purgeRecycleBin purges keys of the purged rows; recycle-bin (restorable) rows keep theirs', () => {
  db.call('upsert', { taskId: 'dwf3f', content: 'x' })
  db.call('upsert', { taskId: 'dwf3g', content: 'y' })
  db.call('setMeta', ['snowDedup:dwf3f:1', '1'])
  db.call('setMeta', ['snowDedup:dwf3g:2', '1'])
  db.call('upsert', { taskId: 'dwf3g', content: 'y', delete: true }) // soft-delete → recycle bin (restorable)
  db.call('upsert', { taskId: 'dwf3f', content: 'x', delete: true })
  const purged = db.call('purgeRecycleBin')
  assert.ok(purged.includes('dwf3g') && purged.includes('dwf3f'))
  assert.equal(db.call('getMeta', 'snowDedup:dwf3f:1'), null, 'purged row keys die with the row')
  assert.equal(db.call('getMeta', 'snowDedup:dwf3g:2'), null, 'purged row keys die with the row')
})

// ---- F7: locked-float tomatoUpdateById rejects historical endTime in the patch ----
const h = todoHandlers({ ...ctxBase, isLocked: () => locked, getMainWindow: () => null })
const eFloat = { sender: { id: 42 } }
test('F7: locked float cannot migrate a today row to a past day via patch.endTime', () => {
  db.call('tomatoAppendMany', [{ tomatoId: 'dwf7', endTime: Date.now(), focus: 'x', focusTaskId: 't', succeed: true }])
  floatSelfSender = true
  locked = true
  try {
    assert.throws(() => h['todo-db:call'](eFloat, 'tomatoUpdateById', {
      tomatoId: 'dwf7',
      patch: { endTime: Date.now() - 5 * 86400000, focusDuration: 100 }
    }), /app is locked/, 'a patch carrying a historical endTime must not pass the lock gate')
    assert.equal(h['todo-db:call'](eFloat, 'tomatoUpdateById', {
      tomatoId: 'dwf7',
      patch: { endTime: Date.now(), focusDuration: 100 }
    }), true, 'a today endTime still passes (legitimate float write)')
    assert.equal(db.call('tomatoGetById', 'dwf7').focusDuration, 100)
    const dayKey = new Date(db.call('tomatoGetById', 'dwf7').endTime)
    assert.equal(db.call('tomatoGetById', 'dwf7').dateKey,
      dayKey.getFullYear() + '-' + String(dayKey.getMonth() + 1).padStart(2, '0') + '-' + String(dayKey.getDate()).padStart(2, '0'))
  } finally { locked = false; floatSelfSender = false }
})

// ---- F9: explicit updatedAt no longer leaks into the extra JSON blob ----
test('F9: tomatoAppendMany with an explicit updatedAt keeps the stamp on the column, not in extra', () => {
  const stamp = 1700000000000
  const r = db.call('tomatoAppendMany', [{ tomatoId: 'dwf9', endTime: Date.now(), succeed: true, updatedAt: stamp, customField: 'keep' }])
  assert.equal(r.accepted, 1)
  const rec = db.call('tomatoGetById', 'dwf9')
  assert.equal(rec.updatedAt, undefined, 'updatedAt must not be re-read from the extra blob')
  assert.equal(rec.customField, 'keep', 'genuinely unknown fields are still preserved')
  const raw = db.call('tomatoAll').find(x => x.tomatoId === 'dwf9')
  assert.equal(raw.updatedAt, undefined)
})

// ---- F5: open-external-url locked gate ----
const systemHandlers = require_('../../../src/main/handlers/system.js')
test('F5: open-external-url is locked-gated and single-validates', () => {
  const api = systemHandlers(ctxBase)
  locked = true
  try { assert.throws(() => api['open-external-url'](eMain, 'https://example.com'), /locked/) } finally { locked = false }
  calls.openExternal.length = 0
  assert.equal(api['open-external-url'](eMain, 'https://example.com'), undefined)
  assert.deepEqual(calls.openExternal, ['https://example.com'], 'exactly one openExternal for a safe URL')
  calls.openExternal.length = 0
  api['open-external-url'](eMain, 'file:///C:/Windows/System32/calc.exe')
  assert.deepEqual(calls.openExternal, [], 'non-http(s) URLs stay blocked')
})

// ---- F6: select-user-white-noise-audio-file gates ----
const attachmentHandlers = require_('../../../src/main/handlers/attachments.js')
test('F6: white-noise picker rejects auxiliary senders and locked state before any dialog', async () => {
  const api = attachmentHandlers(ctxBase)
  await assert.rejects(api['select-user-white-noise-audio-file']({ sender: { id: 'aux' } }), /forbidden: main window only/)
  assert.equal(calls.dialog, 0)
  locked = true
  try { await assert.rejects(api['select-user-white-noise-audio-file'](eMain), /locked/) } finally { locked = false }
  assert.equal(calls.dialog, 0, 'a locked app must not open the native picker')
  calls.dialog = 0
  assert.equal(await api['select-user-white-noise-audio-file'](eMain), null, 'main window passes (stubbed dialog cancels)')
  assert.equal(calls.dialog, 1)
})

// ---- F4: attachment store quota ----
const attachments = require_('../../../src/main/attachments.js')
test('F4: withinStorageQuota pure gate', () => {
  const { withinStorageQuota, MAX_TOTAL_BYTES } = attachments
  assert.equal(MAX_TOTAL_BYTES, 500 * 1024 * 1024)
  assert.equal(withinStorageQuota(0, 10), true)
  assert.equal(withinStorageQuota(499 * 1024 * 1024, 1024 * 1024), true)
  assert.equal(withinStorageQuota(499 * 1024 * 1024 + 1, 1024 * 1024), false, 'cap is exclusive at the boundary')
  assert.equal(withinStorageQuota(600 * 1024 * 1024, 0), false)
  assert.equal(withinStorageQuota(10, 10, 20), true, 'explicit quota argument')
  assert.equal(withinStorageQuota(10, 11, 20), false)
})
test('F4: saveAttachment enforces the total-store quota', async () => {
  const dir = attachments.attachDir()
  attachments.__setTotalQuota(16)
  try {
    const b64 = Buffer.from('0123456789abcde').toString('base64') // 15 bytes
    const first = await attachments.saveAttachment({ taskId: 'dwf4', name: 'a.txt', dataBase64: b64 })
    assert.ok(first.key, 'under the quota the upload lands')
    await assert.rejects(
      attachments.saveAttachment({ taskId: 'dwf4', name: 'b.txt', dataBase64: b64 }),
      /storage quota exceeded/,
      'a further upload must fail closed once the store quota is exhausted'
    )
    assert.equal(fs.readdirSync(dir).filter(n => n.startsWith('dwf4_')).length, 1, 'no partial write from the rejected upload')
  } finally { attachments.__setTotalQuota(null) }
})

// ---- F8: purge-recycle-bin deletes files BEFORE rows ----
test('F8: attachment files are removed before the recycle-bin rows are purged', () => {
  const h2 = todoHandlers({ ...ctxBase, getMainWindow: () => MAIN })
  try {
    purgeSpyArmed = true
    db.call('upsert', { taskId: 'dwf8', content: 'x' })
    db.call('upsert', { taskId: 'dwf8', content: 'x', delete: true })
    fs.writeFileSync(path.join(TMP, 'dwf8_1700000000000_note.txt'), 'private')
    const r = h2['db:purge-recycle-bin'](eMain)
    assert.ok(r !== undefined)
    assert.equal(rowsAliveAtPurgeTime, true, 'at file-purge time the rows must still exist (files BEFORE rows)')
    assert.equal(db.call('queryTodos', { deleted: 1 }).length, 0, 'rows are purged afterwards')
    assert.equal(fs.existsSync(path.join(TMP, 'dwf8_1700000000000_note.txt')), false, 'the private file is gone')
  } finally { purgeSpyArmed = false }
})
