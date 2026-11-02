/**
 * W29 (2026-11-01) closeout wave for the 3x-user-reported broken-paste-image incident.
 *
 * Covers:
 *   1. src/main/attachment-migrate.js — legacy `local://<host>` url startup migration:
 *      restore-success (punycode + case reverse-lookup against a REAL temp dir with REAL
 *      files), restore-failure → explicit `missing: true` marker, and idempotency (second
 *      boot rewrites nothing, DB bytes identical). The boot wrapper runs against a REAL
 *      better-sqlite3 handle with a minimal todos/meta schema (the real SCHEMA is db.js's
 *      territory; the migration only reads id/image/files and writes those columns + one
 *      meta stamp).
 *   2. Anchor: saveAttachment's trailing statSync is guarded (P3 ghost-attachment fix).
 *   3. Anchor: EpAttachments.vue img-error retry chain + explicit-missing placeholder
 *      (P2 sync "先裂后好" fix).
 *
 * Run: node --test tests/unit/main/w29-attachment-migrate.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = fileURLToPath(new URL('../../../', import.meta.url)) // pickdone/

const M = require(join(ROOT, 'src/main/attachment-migrate.js'))
const punycode = require('node:punycode')
const noopLog = { info: () => {}, warn: () => {} } // keep electron-log out of the unit run

/** Minimal real-sqlite harness: todos(id,image,files) + meta(key,value). better-sqlite3 is
 *  the app's own driver — required lazily so a missing native build skips (not fails) these
 *  two cases with a named note. */
let Database = null
try { Database = require('../../../vendor/better-sqlite3-multiple-ciphers') } catch { /* vendor native build unavailable */ }

function makeDb () {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE todos (id TEXT PRIMARY KEY, image TEXT, files TEXT)')
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
  return db
}

test('decodeLegacyHostKey: punycode + lowercase hosts decode; plain names pass through', () => {
  const zh = punycode.toASCII('中文截图.png') // what Chromium leaves in the HOST after IDNA
  assert.ok(zh.startsWith('xn--'), 'fixture sanity: toASCII must produce a punycode label')
  const decoded = M.decodeLegacyHostKey(zh)
  assert.ok(decoded.includes('中文截图'), 'punycode host must decode back to the original characters, got ' + decoded)
  // lowercased ASCII name: no xn-- → returned as-is (case fixed by the disk reverse-lookup)
  assert.equal(M.decodeLegacyHostKey('screenshot.png'), 'screenshot.png')
  // percent-encoded key decodes
  assert.equal(M.decodeLegacyHostKey(encodeURIComponent('截图.png')), '截图.png')
  // malformed encoding falls back to raw (attachmentPath parity)
  assert.equal(M.decodeLegacyHostKey('a%zz.png'), 'a%zz.png')
})

test('isLegacyHostFormUrl: only the host form is legacy', () => {
  assert.equal(M.isLegacyHostFormUrl('local://abc.png'), true)
  assert.equal(M.isLegacyHostFormUrl('local:///abc.png'), false)
  assert.equal(M.isLegacyHostFormUrl('https://x/y'), false)
  assert.equal(M.isLegacyHostFormUrl(null), false)
})

test('migration: punycode/legacy row is rewritten to path form against a REAL dir; unresolvable entry gets the missing marker; re-run is a no-op', { skip: !Database ? 'better-sqlite3 native build unavailable' : false }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'att-migrate-'))
  try {
    // REAL files with the REAL original names (Chinese + mixed case) — the same shapes the
    // historical incidents were reported with.
    const filesDir = join(dir, 'files')
    mkdirSync(filesDir, { recursive: true })
    const zhName = '中文截图 测试.png'
    const caseName = 'Screenshot.PNG'
    writeFileSync(join(filesDir, zhName), 'zh-bytes')
    writeFileSync(join(filesDir, caseName), 'case-bytes')

    const db = makeDb()
    const legacyZh = 'local://' + punycode.toASCII(zhName)
    const legacyCase = 'local://' + caseName.toLowerCase() // Chromium lowercased the host
    const legacyDead = 'local://gone-' + Math.random().toString(36).slice(2, 6) + '.png'
    db.prepare('INSERT INTO todos (id, image, files) VALUES (?,?,?)').run(
      't1',
      JSON.stringify([{ url: legacyZh, name: zhName, size: 8 }]),
      JSON.stringify([{ url: legacyDead, name: 'gone.png', size: 1 }, { url: legacyCase, name: caseName, size: 10 }])
    )

    const r1 = M.migrateLegacyAttachmentUrlsOnBoot(db, { listDiskNames: () => readdirSync(filesDir), log: noopLog })
    assert.equal(r1.error, null, 'boot migration must never surface an error for a healthy store: ' + r1.error)
    assert.equal(r1.scanned, 1)
    assert.equal(r1.rewritten, 2, 'both recoverable legacy urls must be rewritten')
    assert.equal(r1.missing, 1, 'the unrecoverable url must be marked missing')
    assert.equal(r1.changedRows, 1)

    const row = db.prepare('SELECT image, files FROM todos WHERE id = ?').get('t1')
    const image = JSON.parse(row.image)
    const files = JSON.parse(row.files)
    // restore success: exact on-disk names, PATH form, url decodes back verbatim
    assert.equal(image[0].url, 'local:///' + encodeURIComponent(zhName), 'Chinese name must be restored verbatim in path form, got ' + image[0].url)
    assert.equal(decodeURIComponent(image[0].url.slice(9)), zhName)
    const caseEntry = files.find(x => x.url.includes(encodeURIComponent(caseName)) || x.url.includes('Screenshot'))
    assert.ok(caseEntry, 'the case-mangled url must be rewritten')
    assert.equal(caseEntry.url, 'local:///' + encodeURIComponent(caseName), 'reverse-lookup must recover the ORIGINAL case, got ' + caseEntry.url)
    // restore failure: explicit missing marker, url preserved for future repair attempts
    const dead = files.find(x => x.missing === true)
    assert.ok(dead, 'the unrecoverable entry must carry missing: true')
    assert.equal(dead.url, legacyDead, 'the missing marker must keep the original url')

    // the rewritten urls must REALLY point at the bytes on disk
    assert.ok(readFileSync(join(filesDir, decodeURIComponent(image[0].url.slice(9)))), 'rewritten url must resolve to a real file')

    // idempotency: second boot rewrites nothing and changes no bytes
    const before = db.prepare('SELECT image, files FROM todos WHERE id = ?').get('t1')
    const r2 = M.migrateLegacyAttachmentUrlsOnBoot(db, { listDiskNames: () => readdirSync(filesDir), log: noopLog })
    const after = db.prepare('SELECT image, files FROM todos WHERE id = ?').get('t1')
    assert.equal(r2.rewritten, 0, 'second boot must rewrite nothing (idempotency contract)')
    assert.equal(r2.missing, 0, 'second boot must not re-mark (idempotency contract)')
    assert.equal(r2.changedRows, 0)
    assert.deepEqual(after, before, 'second boot must leave the rows byte-identical')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('migration: ambiguous case twins are NOT guessed (W17 doctrine) and per-row poison never aborts the batch', { skip: !Database ? 'better-sqlite3 native build unavailable' : false }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'att-migrate-twins-'))
  try {
    // Synthetic twin listing: a real case-insensitive FS (win/mac) cannot even HOLD two
    // on-disk twins — the ambiguity contract is over the LISTING, which is exactly what
    // listDiskNames is injectable for (a case-sensitive volume or a synced-in listing can).
    const db = makeDb()
    db.prepare('INSERT INTO todos (id, image, files) VALUES (?,?,?)').run('t1', JSON.stringify([{ url: 'local://twin.png', name: 'twin.PNG' }]), '[]')
    db.prepare('INSERT INTO todos (id, image, files) VALUES (?,?,?)').run('t2', '{poisoned json', '[]')
    const r = M.migrateLegacyAttachmentUrlsOnBoot(db, { listDiskNames: () => ['twin.PNG', 'twin.png'], log: noopLog })
    assert.equal(r.error, null, 'poisoned rows must not fail the migration')
    assert.equal(r.changedRows, 1, 'only the healthy row is touched')
    const entry = JSON.parse(db.prepare('SELECT image FROM todos WHERE id = ?').get('t1').image)[0]
    assert.equal(entry.missing, true, 'an ambiguous twin pair must fall to the explicit missing marker, never a guessed rewrite')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('punycodeRecoverBase + resolveAttachmentCase: the canonicalized host form resolves to the REAL Chinese file', () => {
  const A = require(join(ROOT, 'src/main/attachments.js'))
  const dir = mkdtempSync(join(tmpdir(), 'att-punycode-'))
  try {
    const zhName = 'probe_1793595378041_中文probe.png'
    writeFileSync(join(dir, zhName), 'bytes')
    // the exact host string Chromium sent for this file during the live probe
    const hostForm = 'xn--probe_1793595378041_probe-kc63bv169a.png'
    assert.equal(A.punycodeRecoverBase('plain.png'), null, 'no punycode label → no recovery')
    assert.equal(A.punycodeRecoverBase(hostForm), zhName, 'the observed canonicalized host must decode back to the exact on-disk name')
    // serve boundary: literal miss → punycode candidate → the real file
    const resolved = A.resolveAttachmentCase(join(dir, hostForm))
    assert.equal(resolved, join(dir, zhName), 'resolveAttachmentCase must land on the real file for a canonicalized key')
    // the protocol handler pre-decodes the key once (%20 → space) — recovery must survive it
    const handlerKey = hostForm.replace('%20', ' ')
    assert.equal(A.punycodeRecoverBase(handlerKey), zhName, 'a handler-decoded label (space instead of %20) must still recover')
    assert.equal(A.resolveAttachmentCase(join(dir, handlerKey)), join(dir, zhName), 'recovery must land on the real file through the handler decode path')
    // a literal xn-- file keeps winning over the speculative decode (no false recovery)
    writeFileSync(join(dir, hostForm), 'literal')
    assert.equal(A.resolveAttachmentCase(join(dir, hostForm)), join(dir, hostForm), 'a literal xn--* file must win (candidate order)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('anchor: saveAttachment guards the trailing statSync (P3 ghost-attachment fix)', () => {
  const src = readFileSync(join(ROOT, 'src/main/attachments.js'), 'utf8')
  assert.ok(/try \{ size = fs\.statSync\(dest\)\.size \} catch \{ size = raw\.length \}/.test(src),
    'the trailing size stat must fall back to the in-memory byte count (dest can be conflict-renamed mid-upload)')
})

test('anchor: EpAttachments img-error kicks the missing-file pull once and the missing state has a labeled placeholder', () => {
  const src = readFileSync(join(ROOT, 'renderer/js/components/edit-panel/EpAttachments.vue'), 'utf8')
  // P2 sync race: first error → background pull (open-file chain) → arriveTick re-key retries the load
  assert.ok(/__pullTried/.test(src), 'the retry-once guard must exist')
  assert.ok(/onImgErr\s*\(e,\s*im\)/.test(src), 'onImgErr must receive the entry to kick its pull')
  assert.ok(/todoAPI\.openFile\(url\)/.test(src), 'the pull must ride the existing open-file missing-file chain')
  // explicit-missing placeholder (migration marker renders text, not a bare broken img)
  // w30 P1: the branch decision moved to the shared attachmentStateOf mapping (imState);
  // the placeholder branch itself is unchanged — missing-marked entries still render it.
  assert.ok(/v-else-if="imState\(im\) === 'missing'"/.test(src), 'missing-marked entries must render the placeholder branch')
  assert.ok(/attachmentMissing/.test(src), 'the placeholder must carry the bilingual attachmentMissing i18n text')
  assert.ok(/ep-img-missing/.test(src), 'the missing cell must carry its distinct class')
})
