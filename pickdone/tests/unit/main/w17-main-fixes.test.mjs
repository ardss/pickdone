/* W17 main-process fixes (2026-10-28) — four regressions:
 * [1] windows.js: clampIntoView only ran on restore/show — a main window parked on a secondary
 *     monitor that is unplugged while visible never re-clamps ("disappeared" window). Wired
 *     screen 'display-removed' + 'display-metrics-changed' (source pin; lifecycle removes them).
 * [2] handlers/attachments.js open-file/delete-file used the RAW attachmentPath for the missing
 *     guard and the unlink — a lowercased key (Chromium host lowercasing) rendered fine (serve
 *     boundary has the W16 fallback) but every open reported missing (wasted sync round per
 *     click) and every delete ENOENT'd. Both now resolve through resolveAttachmentCase.
 * [3] attachments.js resolveAttachmentCase took the FIRST case-insensitive match — a case-only
 *     twin pair silently served the wrong twin's bytes. Uniqueness guard added.
 * [4] handlers/settings.js get-settings was the only gateless read channel while locked.
 * Run: node --test tests/unit/main/w17-main-fixes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Module = require('module')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'w17-main-'))
const FILES = path.join(TMP, 'files')
fs.mkdirSync(FILES, { recursive: true })

// electron stub: app.getPath('userData') → TMP; screen/shell captured for assertions
const shellCalls = []
const screenListeners = new Map()
const ELECTRON_STUB = {
  app: { getPath: () => TMP, getVersion: () => '0.0.0-test' },
  shell: { openPath: async (p) => { shellCalls.push(p); return '' } },
  screen: {
    on: (ev, h) => { if (!screenListeners.has(ev)) screenListeners.set(ev, []); screenListeners.get(ev).push(h) },
    removeListener: (ev, h) => { const a = screenListeners.get(ev); if (a) { const i = a.indexOf(h); if (i >= 0) a.splice(i, 1) } },
    getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } })
  },
  dialog: {}
}
const origLoad = Module._load
// Case-sensitive fs shim: dev boxes run case-INSENSITIVE filesystems, which would mask the whole
// bug class (exact statSync succeeds for any casing). statSync/unlinkSync throw ENOENT when the
// requested basename is not character-exact on disk; existsSync reports the same.
function makeCaseSensitiveFs (t) {
  const caseOk = (p) => {
    try { return t.readdirSync(path.dirname(p)).includes(path.basename(p)) } catch { return false }
  }
  const enoent = () => { const e = new Error("ENOENT: case-exact name not on disk"); e.code = 'ENOENT'; return e }
  return new Proxy(t, {
    get (target, k) {
      if (k === 'existsSync') return (p) => caseOk(p)
      if (k === 'statSync' || k === 'unlinkSync' || k === 'openSync') {
        return (...a) => { if (!caseOk(a[0])) throw enoent(); return target[k](...a) }
      }
      return target[k]
    }
  })
}
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB
  if (request === 'fs') return makeCaseSensitiveFs(origLoad.call(this, 'fs', parent, isMain))
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const attachments = require(path.join(ROOT, 'src/main/attachments.js'))

const shimFs = makeCaseSensitiveFs(fs)

/* ---- [3] resolveAttachmentCase uniqueness guard ---- */

test('w17[3a]: a single case-insensitive match still resolves (W16 contract kept)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w17-case-'))
  fs.writeFileSync(path.join(dir, 'Photo.PNG'), 'a')
  const got = attachments.resolveAttachmentCase(path.join(dir, 'photo.png'), shimFs)
  assert.equal(path.basename(got), 'Photo.PNG')
})

// twin-dir fs stub: a real dir cannot hold case-only twins on the dev box's case-insensitive FS
const twinFs = (names) => ({
  statSync: () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e },
  readdirSync: () => names
})

test('w17[3b]: case-only twins with NO exact match refuse to resolve (404 fallback, warn)', () => {
  const warnings = []
  const origWarn = console.warn
  console.warn = (...a) => { warnings.push(a.join(' ')) }
  try {
    // request a THIRD distinct casing: no exact twin exists, old code served readdir order
    const got = attachments.resolveAttachmentCase(path.join(os.tmpdir(), 'w17-twins', 'REPORT.png'), twinFs(['Report.PNG', 'report.png']))
    assert.equal(got, path.join(os.tmpdir(), 'w17-twins', 'REPORT.png'), 'must stay unresolved (caller 404s)')
  } finally { console.warn = origWarn }
  assert.ok(warnings.some(w => w.includes('REPORT.png')), 'warns on ambiguity')
})

test('w17[3c]: case-only twins WITH the exact match resolve to the exact twin', () => {
  const got = attachments.resolveAttachmentCase(path.join(os.tmpdir(), 'w17-twins', 'report.png'), twinFs(['Report.PNG', 'report.png']))
  assert.equal(path.basename(got), 'report.png')
})

/* ---- [2] open-file / delete-file case fallback ---- */

function makeAttachmentCtx () {
  const mainSender = { id: 'main-win' }
  const kicks = []
  const ctx = {
    isLocked: () => false,
    isSafeExternal: () => false,
    getMainWindow: () => ({ webContents: mainSender, isDestroyed: () => false }),
    broadcastWhiteNoiseUpdated: () => {},
    notifySyncChange: (op) => { kicks.push(op) },
    mainSender,
    kicks
  }
  return ctx
}
const attachmentHandlers = require(path.join(ROOT, 'src/main/handlers/attachments.js'))

test('w17[2a]: open-file resolves a lowercased key to the real on-disk name and opens it', async () => {
  const ctx = makeAttachmentCtx()
  const h = attachmentHandlers(ctx)
  fs.writeFileSync(path.join(FILES, 't1_1_Photo.PNG'), 'png-bytes')
  const r = await h['open-file']({ sender: ctx.mainSender }, 'local:///' + encodeURIComponent('t1_1_photo.png'))
  assert.equal(r, true, 'opens successfully after case fallback')
  assert.equal(shellCalls.length, 1)
  assert.equal(path.basename(shellCalls[0]), 't1_1_Photo.PNG')
  assert.equal(ctx.kicks.length, 0, 'no wasted attachment-missing sync round')
})

test('w17[2b]: open-file keeps the missing contract for genuinely absent keys', async () => {
  const ctx = makeAttachmentCtx()
  const h = attachmentHandlers(ctx)
  const r = await h['open-file']({ sender: ctx.mainSender }, 'local:///' + encodeURIComponent('t9_9_nothere.png'))
  assert.deepEqual(r, { missing: true, name: 't9_9_nothere.png' })
  assert.equal(ctx.kicks.length, 1, 'missing key still kicks the re-pull round')
})

test('w17[2c]: delete-file unlinks the real on-disk twin for a lowercased key', () => {
  const ctx = makeAttachmentCtx()
  ctx.dbm = { call: () => [] }
  const h = attachmentHandlers(ctx)
  fs.writeFileSync(path.join(FILES, 't2_2_Deleted.PNG'), 'bytes')
  const r = h['delete-file']({ sender: ctx.mainSender }, 'local:///' + encodeURIComponent('t2_2_deleted.png'), {})
  assert.equal(r, true)
  assert.equal(fs.existsSync(path.join(FILES, 't2_2_Deleted.PNG')), false, 'the case-twin file is actually removed')
})

test('w17[2d]: delete-file on an absent key stays ENOENT-idempotent success', () => {
  const ctx = makeAttachmentCtx()
  ctx.dbm = { call: () => [] }
  const h = attachmentHandlers(ctx)
  const r = h['delete-file']({ sender: ctx.mainSender }, 'local:///' + encodeURIComponent('t9_9_gone.png'), {})
  assert.equal(r, true)
})

/* ---- [1] windows.js display-change reclamp (source pin: Electron glue needs a real app) ---- */

test('w17[1]: windows.js wires display-removed/display-metrics-changed to clampIntoView and removes them on closed', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/main/windows.js'), 'utf8')
  assert.ok(src.includes("'display-removed'"), "screen 'display-removed' listener wired")
  assert.ok(src.includes("'display-metrics-changed'"), "screen 'display-metrics-changed' listener wired")
  assert.ok(/removeListener/.test(src), 'listeners removed on window close (no leak across recreation)')
  assert.ok(/win\.on\('closed'[\s\S]*?removeListener/.test(src), 'removal lives in the closed handler')
})

/* ---- [4] get-settings locked gate ---- */

const settingsHandlers = require(path.join(ROOT, 'src/main/handlers/settings.js'))

function makeSettingsCtx ({ locked, lockWinSender }) {
  return {
    readConfig: () => ({ appLocale: 'zh-CN', winBounds: { x: 1, y: 1 }, securityLockPassword: 'cipher', securityLockQuestion: 'q' }),
    writeConfig: (p) => ({ ...p }),
    app: {},
    getMainWindow: () => null,
    applyShortcuts: () => {},
    rebuildTrayMenu: () => {},
    getTray: () => null,
    isLocked: () => !!locked,
    isLockWindow: (sender) => lockWinSender && sender && sender.id === 'lock-win'
  }
}

test('w17[4a]: get-settings throws "app is locked" while locked (non-lock-window sender)', () => {
  const h = settingsHandlers(makeSettingsCtx({ locked: true }))
  assert.throws(() => h['get-settings']({ sender: { id: 'aux' } }), /app is locked/)
})

test('w17[4b]: get-settings still serves unlocked callers and strips security keys', () => {
  const h = settingsHandlers(makeSettingsCtx({ locked: false }))
  const c = h['get-settings']({ sender: { id: 'main' } })
  assert.equal(c.appLocale, 'zh-CN')
  assert.equal(c.securityLockPassword, undefined)
  assert.equal(c.securityLockQuestion, undefined)
})

test('w17[4c]: the lock-screen window itself keeps its read while locked', () => {
  const h = settingsHandlers(makeSettingsCtx({ locked: true, lockWinSender: true }))
  const c = h['get-settings']({ sender: { id: 'lock-win' } })
  assert.equal(c.appLocale, 'zh-CN')
})

test('w17[4d]: legacy stub contexts without isLocked keep working (defensive)', () => {
  const ctx = makeSettingsCtx({ locked: false })
  delete ctx.isLocked
  delete ctx.isLockWindow
  const h = settingsHandlers(ctx)
  assert.equal(h['get-settings']({ sender: {} }).appLocale, 'zh-CN')
})
