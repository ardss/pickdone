/**
 * F3 fixer wave (P3, 2026-10-19) — three attachment-layer hardening regressions:
 *
 * 1. attachments.js cleanName/safe control chars: names carrying 0x00-0x1F (e.g. a bell
 *    \u0007 from a pasted filename) made Windows CreateFile reject the final path and the
 *    WHOLE upload failed. Now sanitized to '_' before extension extraction, same style as
 *    the reserved-name prefix fix.
 * 2. attachments.js claimSlot: nextFreePath's existsSync probe raced concurrent same-name
 *    uploads — the later rename overwrote the first upload's bytes (-1/-2 dedup dead in the
 *    gap). claimSlot claims with an exclusive fs.openSync('wx') placeholder; a losing racer
 *    gets EEXIST and bumps the suffix. saveAttachment then renames its durable spool over
 *    ITS OWN placeholder, and failure paths clean the placeholder up.
 * 3. protocol.js local:// symlink escape: the containment check was purely lexical, so a
 *    symlink inside attachDir pointing outside served arbitrary files. The handler now
 *    realpaths the resolved file AND the attachment root; an escaped resolution is 403,
 *    an unresolvable key keeps the 404 contract, real files still serve 200. The escape
 *    probe uses a directory junction on Windows (no admin needed); a plain symlink is used
 *    where it can be created — if neither is creatable, the test skips with a note.
 *
 * Run: node --test tests/unit/main/f3-attachments-sanitize-claimslot-symlink.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { Module } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'f3-att-'))
const ATT_DIR = path.join(TMP, 'files') // attachDir() = <userData>/files
fs.mkdirSync(ATT_DIR, { recursive: true })

// electron stub (same pattern as d22): app.getPath → TMP, protocol.handle captured for the
// local:// end-to-end part (protocol.js + deps are copied so its requires resolve from TMP).
const captured = {}
const ELECTRON_STUB = {
  app: { getPath: () => TMP, isPackaged: false, getVersion: () => '0.0.0-test' },
  protocol: { handle: (scheme, cb) => { captured[scheme] = cb } }
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const attachments = require('../../../src/main/attachments.js')
const PNG_B64 = Buffer.from('<png-bytes-f3>', 'utf8').toString('base64')

const hasNoCtrl = s => ![...s].some(c => c.charCodeAt(0) < 32)

/* ---- Fix 1: control-char sanitization ---- */

test('F3-1: control chars in the uploaded name are sanitized before persistence', async () => {
  const { key } = await attachments.saveAttachment({ taskId: 'tA', name: 'a\u0007b\u0000c.png', dataBase64: PNG_B64 })
  assert.ok(hasNoCtrl(key), 'key must not carry control chars: ' + JSON.stringify(key))
  assert.ok(key.includes('a_b_c.png'), 'chars replaced with _ (style matches the reserved-name fix): ' + key)
  assert.ok(fs.existsSync(path.join(ATT_DIR, key)), 'the sanitized upload landed on disk')
})

test('F3-1: control chars in taskId are sanitized too', async () => {
  const { key } = await attachments.saveAttachment({ taskId: 't\u0001B', name: 'ok.png', dataBase64: PNG_B64 })
  assert.ok(hasNoCtrl(key), 'taskId control chars must not reach the filename: ' + JSON.stringify(key))
})

test('F3-1: reserved-name and trailing-dot handling still work alongside the sanitize', async () => {
  const r1 = await attachments.saveAttachment({ taskId: 'tC', name: 'con.png', dataBase64: PNG_B64 })
  assert.ok(/_con\.png$/.test(r1.key), 'reserved device name still prefixed')
  const r2 = await attachments.saveAttachment({ taskId: 'tD', name: 'x.png. . ', dataBase64: PNG_B64 })
  assert.ok(r2.key.endsWith('x.png'), 'trailing dots/spaces still stripped')
})

/* ---- Fix 2: claimSlot exclusive claim (TOCTOU) ---- */

test('F3-2: claimSlot takes a free name and claims an occupied one via the -1 suffix', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f3-claim-'))
  const free = attachments.claimSlot(dir, 'dup.png')
  assert.equal(path.basename(free), 'dup.png')
  assert.ok(fs.existsSync(free), 'a 0-byte placeholder is created (the exclusive claim)')
  assert.equal(fs.statSync(free).size, 0)
  const second = attachments.claimSlot(dir, 'dup.png')
  assert.equal(path.basename(second), 'dup-1.png', 'EEXIST bumps to the -1 suffix')
  const third = attachments.claimSlot(dir, 'dup.png')
  assert.equal(path.basename(third), 'dup-2.png')
})

test('F3-2: claimSlot survives a fake fs where wx races are lost (EEXIST until suffix -2)', () => {
  // Simulated concurrent racer: the first two candidates are taken by others between the
  // existsSync-less claim attempts; only '-2' succeeds.
  const fakeFs = {
    openSync (p, flags) {
      if (String(p).endsWith('-2.png')) { this.__claimed = p; return 7 }
      const e = new Error('exists'); e.code = 'EEXIST'; throw e
    },
    closeSync () {}
  }
  const won = attachments.claimSlot('D:\\dir', 'dup.png', fakeFs)
  assert.equal(won, 'D:\\dir\\dup-2.png')
  assert.equal(fakeFs.__claimed, 'D:\\dir\\dup-2.png')
})

test('F3-2: non-EEXIST open errors propagate (not swallowed as "occupied")', () => {
  const fakeFs = { openSync () { const e = new Error('denied'); e.code = 'EACCES'; throw e }, closeSync () {} }
  assert.throws(() => attachments.claimSlot('D:\\dir', 'a.png', fakeFs), /denied/)
})

test("F3-2: same-millisecond same-name uploads dedup — first upload's bytes survive", async () => {
  // Freeze Date.now inside saveAttachment so both uploads mint the identical candidate name
  // (the exact race window the existsSync probe used to lose).
  const realNow = Date.now
  const frozen = realNow()
  Date.now = () => frozen
  try {
    const r1 = await attachments.saveAttachment({ taskId: 'tR', name: 'same.png', dataBase64: Buffer.from('first-content', 'utf8').toString('base64') })
    const r2 = await attachments.saveAttachment({ taskId: 'tR', name: 'same.png', dataBase64: PNG_B64 })
    assert.ok(r2.key.endsWith('same-1.png'), 'second upload must land on the -1 slot, got ' + r2.key)
    const p1 = path.join(ATT_DIR, r1.key)
    assert.equal(fs.readFileSync(p1, 'utf8'), 'first-content', 'first upload bytes must be intact (red before the fix: overwritten)')
    assert.equal(fs.readdirSync(ATT_DIR).filter(f => /\.att-tmp-/.test(f)).length, 0, 'no tmp or placeholder residue')
  } finally { Date.now = realNow }
})

test('F3-2: a failed spool cleans up its own placeholder', async () => {
  const before = new Set(fs.readdirSync(ATT_DIR))
  const realNow = Date.now
  Date.now = () => 424242
  try {
    await assert.rejects(() => attachments.saveAttachment({ taskId: 'tF', name: 'fail.png', dataBase64: '!!!not-base64!!!' }))
  } finally { Date.now = realNow }
  const after = fs.readdirSync(ATT_DIR).filter(f => !before.has(f))
  assert.deepEqual(after, [], 'rejected upload leaves no placeholder/tmp behind: ' + JSON.stringify(after))
})

/* ---- Fix 3: local:// symlink escape (realpath containment) ---- */

// Fixture tree: <TMP>/files is the attachment dir; an "outside" secret sits next to it.
const OUTSIDE_DIR = path.join(TMP, 'outside-secret')
fs.mkdirSync(OUTSIDE_DIR, { recursive: true })
fs.writeFileSync(path.join(OUTSIDE_DIR, 'homedir.txt'), 'TOP-SECRET-outside')
fs.writeFileSync(path.join(ATT_DIR, 'legit.txt'), 'legit-attachment')

fs.mkdirSync(path.join(TMP, 'src', 'main'), { recursive: true })
for (const f of fs.readdirSync(path.join(ROOT, 'src', 'main'))) {
  if (f.endsWith('.js')) fs.copyFileSync(path.join(ROOT, 'src', 'main', f), path.join(TMP, 'src', 'main', f))
}
const protocol = require(path.join(TMP, 'src', 'main', 'protocol.js'))
protocol.handleAppProtocol()
const statusOfLocal = async key => (await captured.local({ url: 'local://' + key })).status

test('F3-3: escape link inside attachDir is 403; real files 200; missing keys 404', async () => {
  // attachmentPath basenames the key, so the reachable escape shape is a symlink/junction NAMED
  // like an attachment key inside attachDir whose TARGET resolves outside. Windows can build a
  // directory junction without admin; a plain file symlink needs dev-mode/admin — try the symlink
  // first (the sharper red 200→403 proof), fall back to a junction, else skip with a note.
  let linkKind = null
  const want = path.join(OUTSIDE_DIR, 'homedir.txt')
  for (const [target, type, kind] of [[want, process.platform === 'win32' ? 'file' : 'file', 'symlink'],
    [OUTSIDE_DIR, 'junction', 'junction']]) {
    try { fs.symlinkSync(target, path.join(ATT_DIR, 'steal'), type); linkKind = kind; break } catch (e) {
      if (e.code !== 'EPERM' && e.code !== 'EEXIST' && e.code !== 'ENOENT') break
      try { fs.unlinkSync(path.join(ATT_DIR, 'steal')) } catch { /* not created */ }
    }
  }
  if (!linkKind) console.log('[F3-3] SKIP escape-link probe: neither file symlink nor junction creatable on this host; the realpath gate is exercised only via the 200/404 cases below.')
  else console.log('[F3-3] escape link kind: ' + linkKind)
  assert.equal(await statusOfLocal(encodeURIComponent('legit.txt')), 200, 'a real attachment still serves')
  assert.equal(await statusOfLocal(encodeURIComponent('nope-does-not-exist.txt')), 404, 'missing key keeps the 404 contract (realpath failure)')
  assert.equal(await statusOfLocal(encodeURIComponent('steal')), 403, 'red before the fix: an inside link to outside content escaped the lexical containment check')
  // Nested keys can never traverse anyway (attachmentPath basenames) — pin that contract.
  assert.equal(await statusOfLocal(encodeURIComponent('outside-secret/homedir.txt')), 404, 'path components never resolve: basename contract')
  assert.equal(await statusOfLocal('aliases.json'), 404, 'bookkeeping guard untouched')
})
