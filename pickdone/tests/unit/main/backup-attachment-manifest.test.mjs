/**
 * F4 P2 (2026-10-18) regression tests — attachment-loss visibility across the backup/restore
 * chain (degraded SIDE-CAR manifest scope):
 *   - every snapshot write rides a sidecar `att-manifest-<snapshot>` manifest (key+size per
 *     file, deterministic order, no timestamps so the C7 content-dedup twin compare stays stable);
 *   - the JSON restore reports (never blocks on) which referenced attachment files are missing
 *     on disk — from the sidecar, or derived from the todoState rows for older backups.
 * Run: node --test tests/unit/main/backup-attachment-manifest.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const backupHandlers = require_('../../../src/main/handlers/backup.js')
const dbRecovery = require_('../../../src/main/dbRecovery.cjs')

const { buildAttachmentManifest, writeAttachmentSidecar, attachmentSidecarNameFor } = backupHandlers
const { missingAttachmentsAfterRestore, localAttachmentKeysFromTodoRows, restoreSegmentsFromCriticalBackup, attachmentManifestPathFor } = dbRecovery

/** Tiny in-memory fs stub for the pure helpers. */
function fakeFs (files) {
  return {
    readdirSync: () => Object.keys(files),
    statSync: p => ({ size: files[path.basename(String(p))] ?? 5 }),
    existsSync: p => path.basename(String(p)) in files,
    readFileSync: () => { throw new Error('nope') },
    unlinkSync: () => {},
  }
}

test('buildAttachmentManifest lists files with sizes, skipping bookkeeping/tmp/noise', () => {
  const fm = fakeFs({ 'a.png': 100, 'b.pdf': 200, 'aliases.json': 3, 'noise-custom.mp3': 4, 'x.att-tmp-1-2': 5 })
  const m = buildAttachmentManifest('dir', fm)
  assert.ok(m, 'manifest built')
  assert.deepEqual(m.entries.map(e => e.key), ['a.png', 'b.pdf'], 'aliases.json / noise-custom.* / .att-tmp-* excluded, deterministic sort')
  assert.equal(m.entries.find(e => e.key === 'a.png').size, 100)
})

test('manifest is DETERMINISTIC: no timestamp field (the C7 dedup contract depends on it)', () => {
  const fm = fakeFs({ 'a.png': 100 })
  const m1 = buildAttachmentManifest('dir', fm)
  const m2 = buildAttachmentManifest('dir', fm)
  assert.deepEqual(m1, m2, 'two runs over the same dir produce byte-stable manifests')
  assert.ok(!('generatedAt' in m1), 'no timestamp field — every manifest-mutating payload design was rejected for exactly this reason')
})

test('writeAttachmentSidecar writes att-manifest-<snapshot> next to the snapshot (OUTSIDE the ^(auto|evt)- namespace)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'att-sidecar-'))
  try {
    fs.writeFileSync(path.join(dir, 'a.png'), 'x')
    assert.equal(writeAttachmentSidecar(fs, dir, 'auto-20261018-101010.json', dir), true)
    const side = path.join(dir, attachmentSidecarNameFor('auto-20261018-101010.json'))
    assert.ok(!/^(auto|evt)-/.test(path.basename(side)), 'sidecar must not enter the restore namespace')
    assert.ok(fs.existsSync(side))
    const m = JSON.parse(fs.readFileSync(side, 'utf8'))
    assert.deepEqual(m.entries, [{ key: 'a.png', size: 1 }])
    assert.equal(attachmentManifestPathFor('/x/backup.json'), path.join('/x', 'att-manifest-backup.json'))
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }
})

test('writeAttachmentSidecar never throws on an unavailable files dir (best-effort by contract)', () => {
  assert.doesNotThrow(() => writeAttachmentSidecar(fs, os.tmpdir(), 'whatever.json', null))
})

test('missingAttachmentsAfterRestore reports missing keys from an (embedded-shape) manifest', () => {
  const raw = { backup: { attachments: { entries: [{ key: 'have.png', size: 1 }, { key: 'gone.pdf', size: 1 }] } } }
  const r = missingAttachmentsAfterRestore(raw, 'dir', fakeFs({ 'have.png': 1 }))
  assert.equal(r.checked, 2)
  assert.deepEqual(r.missing, ['gone.pdf'])
})

test('missingAttachmentsAfterRestore derives local:// keys from todoState rows for old backups (no manifest)', () => {
  const rows = {
    todoList: [
      { taskId: 't1', image: JSON.stringify([{ url: 'local://' + encodeURIComponent('img x.png') }]) },
      { taskId: 't2', files: JSON.stringify([{ url: 'local://doc.pdf' }]) },
    ],
    recycleList: [],
  }
  const raw = { backup: { todoState: JSON.stringify(rows) } }
  assert.deepEqual(localAttachmentKeysFromTodoRows(raw).sort(), ['doc.pdf', 'img x.png'])
  const r = missingAttachmentsAfterRestore(raw, 'dir', fakeFs({ 'doc.pdf': 1 }))
  assert.equal(r.checked, 2)
  assert.deepEqual(r.missing, ['img x.png'])
  assert.equal(missingAttachmentsAfterRestore(raw, null, fakeFs({})), null, 'no filesDir → report skipped (null)')
})

test('restoreSegmentsFromCriticalBackup reads the sidecar manifest + surfaces result.missingAttachments, without touching proved', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'att-restore-'))
  try {
    const filesDir = path.join(dir, 'files')
    fs.mkdirSync(filesDir)
    fs.mkdirSync(path.join(dir, 'backups'), { recursive: true })
    const todoState = JSON.stringify({ todoList: [{ taskId: 't1', files: JSON.stringify([{ url: 'local://gone.pdf' }]) }] })
    fs.writeFileSync(path.join(dir, 'backups', 'critical-state-backup.json'), JSON.stringify({ backup: { todoState } }))
    // sidecar manifest inventory: gone.pdf present in the dump, missing on this disk
    fs.writeFileSync(path.join(dir, 'backups', attachmentSidecarNameFor('critical-state-backup.json')),
      JSON.stringify({ entries: [{ key: 'gone.pdf', size: 3 }, { key: 'also-gone.png', size: 1 }] }))
    const res = restoreSegmentsFromCriticalBackup(dir, rows => rows.length, null, null, { filesDir })
    assert.equal(res.tasks, 1)
    assert.deepEqual(res.missingAttachments.sort(), ['also-gone.png', 'gone.pdf'], 'the sidecar inventory drives the missing report')
    assert.equal(res.proved, true, 'the attachment report NEVER degrades the restore-proof gate')
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }
})
