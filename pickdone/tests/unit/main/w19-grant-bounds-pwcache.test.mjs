/**
 * W19 (2026-10-30) — three main-process fixes with regression tests:
 *   1. (P2) csv-import grant state machine: two loose variables (path/hash) let a failed preview
 *      clear one side → surviving grant {path:B, hash:''} → every import:run hit HASH_MISMATCH.
 *      The grant is now ONE object replaced atomically; a failure wipes the whole thing, run
 *      consumes it whole. Structured codes (AUTH_EXPIRED / HASH_MISMATCH) unchanged.
 *   2. (P3) open-file symlink containment: handler-level test that a symlink inside the
 *      attachment store pointing OUTSIDE fails closed (false) like protocol.js's 403.
 *   3. (P3) windows.js restore-bounds sanitizer (pure seam __windowGeom.sanitizeRestoreBounds).
 *   4. (P3) security-lock verifyLockPassword caches the stored password string (TTL + write-version
 *      invalidation, same pattern as the D18 isLocked cache).
 * Run: node --test tests/unit/main/w19-grant-bounds-pwcache.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Module } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/* ---------- electron stub (module-load + dialog dependency) ---------- */
const USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'w19-user-')) // electron app.getPath('userData') → attachDir() = USER_DIR/files
const electronStub = {
  app: { isPackaged: false, getPath: () => USER_DIR },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: dialogStubData.filePaths }) },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: class {}
}
let dialogStubData = { filePaths: [] }
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const csvMod = require(path.join(ROOT, 'src/main/handlers/csv-import.js'))

function makeCtx (over = {}) {
  const sender = { id: 1 } // assertMainWindow compares e.sender === main window's webContents
  const ctx = Object.assign({
    sender,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: sender }),
    dbApi: () => ({}),
    broadcastTodosChanged: () => {},
    log: { warn () {}, info () {}, error () {} },
    resyncDbWatch: () => null,
    isLocked: () => false
  }, over)
  return ctx
}

/** Plant a stub for src/main/import (the handler requires it lazily INSIDE each call). */
function plantImporter (importerStub) {
  const importerPath = require.resolve(path.join(ROOT, 'src/main/import/index.js'))
  const prev = require.cache[importerPath]
  require.cache[importerPath] = { id: importerPath, filename: importerPath, loaded: true, exports: importerStub }
  return () => { if (prev) require.cache[importerPath] = prev; else delete require.cache[importerPath] }
}

const VALID_CSV = 'Type,Content,Priority,Indent\ntask,alpha,1,1\n'

/* ---------------- Fix 1: csv-import single-object grant ---------------- */

test('W19 fix1: a failed preview after a successful one wipes the WHOLE grant — run on the surviving path is AUTH_EXPIRED, never HASH_MISMATCH', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w19-grant-'))
  const fileA = path.join(dir, 'a.csv'); const fileB = path.join(dir, 'b.csv')
  fs.writeFileSync(fileA, VALID_CSV)
  fs.writeFileSync(fileB, VALID_CSV)
  const ctx = makeCtx(); const ctxSender = ctx.sender; const h = csvMod(ctx)
  const e = { sender: ctxSender }
  // preview A lands {path:A, hash:A}
  dialogStubData = { filePaths: [fileA] }
  const pa = await h['import:pick-preview'](e)
  assert.equal(pa && pa.ok, true)
  // preview B overwrites the grant entirely {path:B, hash:B}
  dialogStubData = { filePaths: [fileB] }
  const pb = await h['import:pick-preview'](e)
  assert.equal(pb && pb.ok, true)
  // a FAILING preview (missing file) must now null the whole object.
  // Red before the fix: it cleared only the hash → grant {path:B, hash:''} survived and run(B)
  // passed the path gate but failed the TOCTOU check with HASH_MISMATCH every time.
  dialogStubData = { filePaths: [path.join(dir, 'gone.csv')] }
  const pf = await h['import:pick-preview'](e)
  assert.equal(pf && pf.ok, false, 'the missing-file preview fails as designed')
  dialogStubData = { filePaths: [fileB] }
  const r = await h['import:run'](e, fileB)
  assert.equal(r && r.ok, false)
  assert.equal(r.code, 'AUTH_EXPIRED', `red before the fix: got ${r.code} instead of AUTH_EXPIRED`)
})

test('W19 fix1: run consumes the grant atomically — success once, AUTH_EXPIRED on replay (single-shot contract unchanged)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w19-grant2-'))
  const file = path.join(dir, 'ok.csv')
  fs.writeFileSync(file, VALID_CSV)
  dialogStubData = { filePaths: [file] }
  const unplant = plantImporter({ importItems (items, opts) { if (opts && opts.dryRun) return { wouldImport: 1 }; return { imported: items.length } } })
  const ctx = makeCtx({ resyncDbWatch: () => () => {} }); const ctxSender = ctx.sender; const h = csvMod(ctx)
  const e = { sender: ctxSender }
  const p = await h['import:pick-preview'](e)
  assert.equal(p.ok, true)
  const r = await h['import:run'](e, file)
  assert.ok(r && !r.ok && !r.code, `run should succeed (engine result, no structured failure): ${JSON.stringify(r)}`)
  const r2 = await h['import:run'](e, file)
  assert.equal(r2.code, 'AUTH_EXPIRED', 'the single-shot contract is preserved under the new object grant')
  unplant()
})

test('W19 fix1: run with no grant at all (fresh handler) is still the AUTH_EXPIRED contract', async () => {
  const ctx = makeCtx(); const ctxSender = ctx.sender; const h = csvMod(ctx)
  const r = await h['import:run']({ sender: ctxSender }, 'whatever.csv')
  assert.equal(r.code, 'AUTH_EXPIRED')
})

test('W19 fix1: a fresh preview after a failed one fully re-arms the grant (path AND hash together)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w19-grant3-'))
  const file = path.join(dir, 'r.csv')
  fs.writeFileSync(file, VALID_CSV)
  const unplant = plantImporter({ importItems (items, opts) { if (opts && opts.dryRun) return { wouldImport: 1 }; return { imported: items.length } } })
  const ctx = makeCtx({ resyncDbWatch: () => () => {} }); const ctxSender = ctx.sender; const h = csvMod(ctx)
  const e = { sender: ctxSender }
  dialogStubData = { filePaths: [path.join(dir, 'missing.csv')] }
  const bad = await h['import:pick-preview'](e)
  assert.equal(bad.ok, false, 'the preview failed as designed')
  const before = await h['import:run'](e, file)
  assert.equal(before.code, 'AUTH_EXPIRED')
  dialogStubData = { filePaths: [file] }
  assert.equal((await h['import:pick-preview'](e)).ok, true)
  const rr = await h['import:run'](e, file)
  assert.ok(rr && !rr.ok && !rr.code, `a fresh preview re-arms the grant fully: ${JSON.stringify(rr)}`)
  unplant()
})

test('W19 fix1: TOCTOU contract intact — a file changed AFTER preview still fails with HASH_MISMATCH (not AUTH_EXPIRED)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w19-grant4-'))
  const file = path.join(dir, 't.csv')
  fs.writeFileSync(file, VALID_CSV)
  dialogStubData = { filePaths: [file] }
  const unplant = plantImporter({ importItems (items, opts) { if (opts && opts.dryRun) return { wouldImport: 1 }; return { imported: 0 } } })
  const ctx = makeCtx(); const ctxSender = ctx.sender; const h = csvMod(ctx)
  const e = { sender: ctxSender }
  assert.equal((await h['import:pick-preview'](e)).ok, true)
  fs.writeFileSync(file, VALID_CSV.replace('alpha', 'beta')) // swap bytes under the approved hash
  const r = await h['import:run'](e, file)
  assert.equal(r.code, 'HASH_MISMATCH', 'the content guard keeps its own distinct code')
  unplant()
})

/* ---------------- Fix 2: open-file symlink containment ---------------- */

const MAIN_WC = { id: 'main-wc' }
const eMain = { sender: MAIN_WC }
function makeAttachmentHandlers () {
  const handlerMod = require(path.join(ROOT, 'src/main/handlers/attachments.js'))
  return handlerMod({
    isLocked: () => false,
    isSafeExternal: () => true,
    getMainWindow: () => ({ webContents: MAIN_WC, isDestroyed: () => false }),
    broadcastWhiteNoiseUpdated: () => {},
    notifySyncChange: () => {}
  })
}

test('W19 fix2: open-file refuses (fail-closed false) when the resolved file escapes the attachment root via a symlink', async () => {
  const attachRoot = path.join(USER_DIR, 'files')
  fs.mkdirSync(attachRoot, { recursive: true })
  const inside = path.join(attachRoot, 'link.txt'); const outside = path.join(USER_DIR, 'secret.txt')
  fs.writeFileSync(outside, 'secret')
  try { fs.symlinkSync(outside, inside) } catch { return } // platform without symlink privilege: nothing to assert
  const h = makeAttachmentHandlers()
  const r = await h['open-file'](eMain, 'local://link.txt')
  assert.equal(r, false, `red before the fix: the escaped symlink opened (${JSON.stringify(r)})`)
})

test('W19 fix2: open-file still succeeds for a file genuinely inside the attachment root', async () => {
  const attachRoot = path.join(USER_DIR, 'files')
  fs.mkdirSync(attachRoot, { recursive: true })
  fs.writeFileSync(path.join(attachRoot, 'good.txt'), 'hello')
  const h = makeAttachmentHandlers()
  const opened = []
  // plant a shell stub for THIS call (open-file requires 'electron' lazily)
  const origShell = electronStub.shell
  electronStub.shell = { openPath: async p => { opened.push(p); return '' } }
  try {
    const r = await h['open-file'](eMain, 'local://good.txt')
    assert.equal(r, true, 'containment must not break the normal open path')
    assert.equal(path.basename(opened[0]), 'good.txt')
  } finally {
    if (origShell === undefined) delete electronStub.shell; else electronStub.shell = origShell
  }
})

/* ---------------- Fix 3: windows.js restore-bounds sanitizer (pure) ---------------- */

test('W19 fix3: sanitizeRestoreBounds validates all four fields and discards the whole object on any violation', () => {
  const { sanitizeRestoreBounds } = require(path.join(ROOT, 'src/main/windows.js')).__windowGeom
  const good = { x: 10, y: 20, width: 1200, height: 800 }
  assert.deepEqual(sanitizeRestoreBounds(good), good)
  // negative / non-finite / below-minimum sizes (the old code passed negatives straight through)
  assert.equal(sanitizeRestoreBounds({ x: 0, y: 0, width: 1000, height: -560 }), null)
  assert.equal(sanitizeRestoreBounds({ x: 0, y: 0, width: 1000, height: 100 }), null, 'below the 200 min height')
  assert.equal(sanitizeRestoreBounds({ x: 0, y: 0, width: 100, height: 560 }), null, 'below the 750 min width')
  assert.equal(sanitizeRestoreBounds({ x: 0, y: 0, width: NaN, height: 560 }), null)
  assert.equal(sanitizeRestoreBounds({ x: Infinity, y: 0, width: 1000, height: 560 }), null)
  assert.equal(sanitizeRestoreBounds({ x: '12', y: 0, width: 1000, height: 560 }), null, 'string width is not a number')
  assert.equal(sanitizeRestoreBounds(null), null)
  assert.equal(sanitizeRestoreBounds({}), null)
  // x/y only need finiteness — off-screen is clampIntoView's job
  assert.deepEqual(sanitizeRestoreBounds({ x: -9999, y: 99999, width: 800, height: 560 }),
    { x: -9999, y: 99999, width: 800, height: 560 })
})

/* ---------------- Fix 4: verifyLockPassword cached stored-password read ---------------- */

function makeLock ({ stored }) {
  const { createSecurityLock } = require(path.join(ROOT, 'src/main/security-lock.js'))
  let reads = 0
  let version = 0
  let value = stored
  const lock = createSecurityLock({
    getMainWindow: () => null,
    showMainOrLock: () => {},
    readConfig: () => { reads++; return { securityLockPassword: value } },
    writeConfig: () => {},
    i18n: { mt: k => k },
    log: { info () {}, warn () {}, error () {} },
    configVersion: () => version
  })
  return {
    lock,
    reads: () => reads,
    changePassword: v => { value = v; version++ } // config-store bumps _writeVersion on every writeConfig
  }
}

test('W19 fix4: repeated verifyLockPassword calls within the TTL read config.json once', () => {
  const h = makeLock({ stored: 'plain:s3cret' })
  assert.equal(h.lock.verifyLockPassword('wrong'), false)
  assert.equal(h.lock.verifyLockPassword('s3cret'), true)
  assert.equal(h.lock.verifyLockPassword('s3cret'), true)
  assert.equal(h.lock.verifyLockPassword('nope'), false)
  assert.equal(h.reads(), 1, 'red before the fix: every verify re-read config.json (AV-lock backoff on the unlock path)')
})

test('W19 fix4: a password CHANGE (writeConfig → version bump) invalidates the cache immediately — the old password stops unlocking', () => {
  const h = makeLock({ stored: 'plain:old' })
  assert.equal(h.lock.verifyLockPassword('old'), true)
  h.changePassword('plain:new')
  assert.equal(h.lock.verifyLockPassword('old'), false, 'the old password must stop working at once (write-version invalidation)')
  assert.equal(h.lock.verifyLockPassword('new'), true)
})

test('W19 fix4: the disable-lock wipe (empty stored password) also lands immediately — any input unlocks as before', () => {
  const h = makeLock({ stored: 'plain:x' })
  assert.equal(h.lock.verifyLockPassword('x'), true)
  h.changePassword('')
  assert.equal(h.lock.verifyLockPassword('anything'), true, 'empty stored password keeps the no-lockout semantic')
})

test('W19 fix4: the encrypted (enc1:) path still verifies correctly through the cache', () => {
  electronStub.safeStorage = {
    decryptString: buf => Buffer.from('decrypted') // the stored base64 decrypts to 'decrypted'
  }
  try {
    const h = makeLock({ stored: 'enc1:' + Buffer.from('whatever').toString('base64') })
    assert.equal(h.lock.verifyLockPassword('decrypted'), true)
    assert.equal(h.lock.verifyLockPassword('other'), false)
  } finally {
    delete electronStub.safeStorage
  }
})
