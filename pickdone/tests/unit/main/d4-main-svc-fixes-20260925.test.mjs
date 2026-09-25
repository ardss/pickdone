/* Domain-4 main-process service fixes (2026-09-25 wave, C5/C6/C8/C10/C12/C13/C14/C15):
 *   C12  upload-attachment now gates on assertMainWindow (aux windows could write the store)
 *   C6   delete-file with a non-local:// url returns false (was an unconditional `return true`
 *        success lie — nothing was deleted but the caller was told it was)
 *   C5   white-noise pick: source file is stat'd BEFORE the copy — per-file 50MB cap + shared
 *        storage quota (attachments-guards); an over-size pick lands NOTHING on disk
 *   C14  dirTotalBytes/dirUsage exclude noise-custom.* — a ~63.5MB white-noise file no longer
 *        starves 1MB attachment uploads against the 64MB quota
 *   C13  'mime-get-type' reads protocol.js's single-source table (no second hand-copied map)
 *   C15  legacy .svg under local:// is forced to application/octet-stream + Content-Disposition:
 *        attachment (download, never render); CSP/nosniff preserved
 *   C10  tomato-float crash-rebuild capped at 3 (windows.js precedent), reset on proof of health
 *   C8   entity conflict-backup restore re-backups the current winning row BEFORE overwriting —
 *        restore is itself reversible: restore, then restore again, returns to the prior state
 * Run: node --test tests/unit/main/d4-main-svc-fixes-20260925.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const Module = require_('module')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'd4-main-svc-'))
const MAIN = { webContents: { id: 'main' }, isDestroyed: () => false }
const eMain = { sender: MAIN.webContents }
const eAux = { sender: { id: 'aux-float' } }

// Mutable dialog answer the white-noise tests re-point per case.
let dialogAnswer = { canceled: true, filePaths: [] }
const stubs = {
  electron: {
    app: { getPath: (k) => (k === 'userData' ? TMP : path.join(TMP, k)), isPackaged: false },
    BrowserWindow: class {},
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 800, height: 600 }, bounds: { x: 0, y: 0, width: 800, height: 600 } }), getCursorScreenPoint: () => ({ x: 0, y: 0 }), on () {}, getAllDisplays: () => [] },
    dialog: { showOpenDialog: async () => dialogAnswer },
    shell: { openPath: async () => '', openExternal: async () => '' },
  },
  '../i18n': { mt: (k) => k },
  '../db': { isOpen: () => false, call: () => null }, // tomato-float's closed-marker persistence: inert in unit env
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (stubs[request]) return stubs[request]
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const attachments = require_('../../../src/main/attachments.js')
const guards = require_('../../../src/main/attachments-guards.js')
const protocol = require_('../../../src/main/protocol.js')
const attachmentHandlers = require_('../../../src/main/handlers/attachments.js')


const ctx = {
  isLocked: () => false,
  isSafeExternal: () => false,
  app: stubs.electron.app,
  getMainWindow: () => MAIN,
  broadcastWhiteNoiseUpdated: () => {},
  notifySyncChange: () => {},
}
const api = attachmentHandlers(ctx)
const b64 = (buf) => buf.toString('base64')

/* ---------------- C12: upload-attachment main-window gate ---------------- */

test('C12: upload-attachment rejects an aux-window sender, accepts the main window', async () => {
  assert.throws(() => api['upload-attachment'](eAux, { taskId: 't', name: 'a.png', dataBase64: b64(Buffer.from('x')) }), /forbidden: main window only/, 'aux sender must be refused before saveAttachment runs')
  const r = await api['upload-attachment'](eMain, { taskId: 't', name: 'a.png', dataBase64: b64(Buffer.from('cG5nLWJ5dGVz')) })
  assert.ok(r.url.startsWith('local://'), 'main-window upload goes through')
  assert.ok(fs.existsSync(path.join(TMP, 'files', r.key)), 'the uploaded file landed in the attachment dir')
})

/* ---------------- C6: delete-file honesty for non-local urls ---------------- */

test('C6: delete-file returns false for a non-local:// url (no success lie), true for a real local delete', () => {
  assert.equal(api['delete-file'](eMain, 'https://evil.example/x.png'), false, 'https url: nothing deleted, report false')
  assert.equal(api['delete-file'](eMain, 'file:///etc/passwd'), false, 'file:// url: report false too')
  const f = path.join(TMP, 'files', 'c6-target.png')
  fs.writeFileSync(f, 'bye')
  assert.equal(api['delete-file'](eMain, 'local://c6-target.png'), true, 'a real local:// delete still succeeds')
  assert.ok(!fs.existsSync(f), 'the local file is actually gone')
})

/* ---------------- C5: white-noise pick size/quota gate (stat BEFORE copy) ---------------- */

test('C5: an over-size picked audio file is refused with nothing written to the attachment dir', async () => {
  const bigSrc = path.join(TMP, 'big-noise.wav')
  fs.writeFileSync(bigSrc, 'RIFF')
  fs.truncateSync(bigSrc, 51 * 1024 * 1024) // logical 51MB > the 50MB per-file cap (sparse, no 51MB on disk)
  assert.ok(fs.statSync(bigSrc).size > attachments.MAX_BYTES)
  dialogAnswer = { canceled: false, filePaths: [bigSrc] }
  const filesDir = path.join(TMP, 'files')
  await assert.rejects(() => api['select-user-white-noise-audio-file'](eMain), /too large/, 'the 50MB per-file cap applies to the white-noise entry too')
  assert.ok(!fs.readdirSync(filesDir).some(f => f.startsWith('noise-custom.')), 'NOTHING landed on disk — the gate fired before the copy')
})

test('C5: a normal-size pick still copies (the gate must not over-block)', async () => {
  const okSrc = path.join(TMP, 'ok-noise.mp3')
  fs.writeFileSync(okSrc, 'id3audio')
  dialogAnswer = { canceled: false, filePaths: [okSrc] }
  const r = await api['select-user-white-noise-audio-file'](eMain)
  assert.equal(r.key, 'noise-custom.mp3')
  assert.ok(fs.existsSync(path.join(TMP, 'files', 'noise-custom.mp3')), 'the picked file was copied')
})

/* ---------------- C14: noise-custom.* excluded from the attachment quota ---------------- */

test('C14: a 63.5MB noise-custom file no longer starves a 1MB attachment upload (64MB quota)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd4-quota-'))
  fs.writeFileSync(path.join(dir, 'noise-custom.mp3'), 'x')
  fs.truncateSync(path.join(dir, 'noise-custom.mp3'), Math.floor(63.5 * 1024 * 1024)) // sparse: logical size only
  fs.writeFileSync(path.join(dir, 't1_123_a.png'), 'real-attachment-bytes')
  assert.ok(attachments.isUnownedNoiseFile('noise-custom.mp3'), 'classifier pins the excluded name shape')
  assert.ok(!attachments.isUnownedNoiseFile('t1_123_a.png'))
  const counted = attachments.dirTotalBytes(dir)
  assert.ok(counted < 1024 * 1024, `dirTotalBytes excludes the 63.5MB noise slot, counted only ${counted} bytes`)
  assert.equal(attachments.dirUsage(dir).count, 1, 'dirUsage counts only owned attachments')
  assert.equal(attachments.withinStorageQuota(counted, 1024 * 1024), true, 'a 1MB upload passes the 64MB gate')
  // End-to-end through the real saveAttachment quota gate (the C5-starve scenario):
  assert.doesNotThrow(() => guards.assertWriteAllowed({ incomingBytes: 1024 * 1024, dir }), 'guards.assertWriteAllowed accepts 1MB next to the noise slot')
})

/* ---------------- C13: single-source mime table ---------------- */

test('C13: mime-get-type reads the protocol.js table (no drifted hand copy)', () => {
  assert.equal(api['mime-get-type'](eMain, 'a.png'), 'image/png')
  assert.equal(api['mime-get-type'](eMain, 'b.MP3'), 'audio/mpeg')
  assert.equal(api['mime-get-type'](eMain, 'c.ogg'), 'audio/ogg')
  assert.equal(api['mime-get-type'](eMain, 'd.pdf'), 'application/pdf')
  assert.equal(api['mime-get-type'](eMain, 'e.unknownext'), 'application/octet-stream')
  assert.equal(api['mime-get-type'](eMain, 'f.wav'), 'audio/wav', 'the old handler table lacked wav; the single source has it')
  assert.equal(api['mime-get-type'](eMain, 'x.mp4'), 'video/mp4')
})

/* ---------------- C15: legacy svg forced to download, never render ---------------- */

test('C15: local:// serving policy forces legacy .svg to octet-stream + attachment disposition', () => {
  const svg = protocol.localAttachmentHeaders('noise-custom.svg')
  assert.equal(svg.mime, 'application/octet-stream', 'svg is never served as image/svg+xml')
  assert.match(svg.extraHeaders['Content-Disposition'], /^attachment;/, 'forced download, not render')
  const png = protocol.localAttachmentHeaders('a.png')
  assert.equal(png.mime, 'image/png')
  assert.equal(png.extraHeaders['Content-Disposition'], undefined, 'non-svg files keep inline serving')
})

