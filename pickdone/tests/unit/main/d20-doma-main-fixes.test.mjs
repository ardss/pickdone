/**
 * D20-DOM-A main-process regression tests:
 *   B13 — snapshot.rowChunks budgets with the 12-byte envelope reserve (same as chunkSnapshot).
 *   B4  — GFS prune classifies suffix-carrying same-stamp snapshots (-dup<n> / -<epochMs>) into
 *         their tag's tier (pre-fix they matched no regex and accumulated forever).
 *   C9  — config-store writeConfig keeps the synchronous try/catch return contract, and the
 *         async-branch loud log exists.
 *   B12 — planAddMany stays an unconditional upsert (LWW adjudicated in sync-apply; gate reverted).
 *   B11 — attachment save is atomic (spool + rename): no torn final file, no tmp residue.
 * Run: node --test tests/unit/main/d20-doma-main-fixes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Module = require('module')

/* ---------- B13: rowChunks envelope budget ---------- */
const { rowChunks, chunkSnapshot } = require('../../../src/main/lan-sync/snapshot.js')

test('B13: rowChunks applies the envelope reserve — chunk row-sums never exceed maxChunkBytes - 12', () => {
  // '{"a":"x"}' is 9 bytes; at maxChunkBytes 30 the effective budget is 30-12=18 -> one row per
  // chunk (row-sum accounting: 9+9=18 <= 18 would have packed two rows per chunk, overshooting
  // the parsed envelope). Red before the fix.
  const rows = Array.from({ length: 6 }, (_, i) => ({ a: 'x', i }))
  const bytes = (r) => Buffer.byteLength(JSON.stringify(r), 'utf8')
  for (const chunk of rowChunks(rows, { maxChunkBytes: 30 })) {
    const sum = chunk.rows.reduce((acc, r) => acc + bytes(r) + 1, 0)
    assert.ok(sum <= 30 - 12, `chunk row-sum ${sum} must fit the envelope budget (maxChunkBytes 30 - 12)`)
  }
  // Parity: rowChunks and chunkSnapshot produce the SAME chunk count for the same rows.
  const viaRows = Array.from(rowChunks(rows, { maxChunkBytes: 30 }))
  const viaSnap = chunkSnapshot({ rows }, { maxChunkBytes: 30 })
  assert.equal(viaRows.length, viaSnap.chunks.length, 'rowChunks matches chunkSnapshot chunking')
})

/* ---------- B4: suffix-carrying snapshots join their GFS tier ---------- */
const { selectPrunes } = require('../../../src/main/autoBackup.js')

test('B4: collision-suffixed -dup<n> auto snapshots are pruned within the auto tier', () => {
  // 30 same-stamp -dup snapshots (handlers/backup.js uniqueSnapshotName shape), all old.
  const dups = Array.from({ length: 30 }, (_, i) => `auto-20200101-010101-dup${i + 1}.json`)
  const prunes = selectPrunes(dups, { recent: 24, dailyDays: 1, weeklyWeeks: 1, eventKeep: 10 })
  assert.equal(prunes.length, 4, `red before the fix: 0 of 30 suffixed snapshots were ever pruned (got ${prunes.length})`)
  for (const p of prunes) assert.match(p, /^auto-20200101-010101-dup\d+\.json$/)
})

test('B4: epochMs-suffixed evt snapshots are grouped by reason and kept per eventKeep', () => {
  // cli/lib-eventbackup.cjs shape: evt-<reason>-<stamp>-<epochMs>.json
  const evts = Array.from({ length: 12 }, (_, i) => `evt-purge-20260201-010101-${1735687861000 + i}.json`)
  const prunes = selectPrunes([...evts, 'auto-20260301-000000.json'], { recent: 24, dailyDays: 14, weeklyWeeks: 8, eventKeep: 10 })
  const evtPrunes = prunes.filter((n) => n.startsWith('evt-purge-'))
  assert.equal(evtPrunes.length, 2, `red before the fix: suffixed evt snapshots were never pruned (got ${evtPrunes.length})`)
  // The OLDEST two (lowest epochMs suffix) go first.
  assert.ok(evtPrunes.includes('evt-purge-20260201-010101-1735687861000.json'))
  assert.ok(evtPrunes.includes('evt-purge-20260201-010101-1735687861001.json'))
})

/* ---------- C9: writeConfig sync contract + loud async-branch log ---------- */
const configStore = require('../../../src/main/config-store.js')

test('C9: writeConfig returns the merged object synchronously even back-to-back (try/catch contract)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd20-config-'))
  configStore.__setConfigDir(tmp)
  try {
    const a = configStore.writeConfig({ locale: 'zh' })
    assert.ok(!(a instanceof Promise), 'the sync path must return the merged object, not a Promise')
    assert.equal(a.locale, 'zh')
    const b = configStore.writeConfig({ winBounds: { width: 800 } }) // same-tick second call
    assert.ok(!(b instanceof Promise), 'second same-tick call keeps the sync contract')
    assert.equal(b.locale, 'zh', 'merge is cumulative')
    assert.equal(b.winBounds.width, 800)
    // The async branch (dead code today) must keep its loud D20-C9 surface.
    const src = fs.readFileSync(path.join(import.meta.dirname, '../../../src/main/config-store.js'), 'utf8')
    assert.ok(src.includes('[config-store] D20-C9 writeConfig async path taken'), 'the async-branch loud log is pinned')
  } finally {
    configStore.__setConfigDir(null)
  }
})

/* ---------- B12: planAddMany stays an unconditional upsert (LWW lives in sync-apply) ---------- */
process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'd20-plan-'))
process.env.TODO_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'd20-plan-ud-'))
const db = require('../../../src/main/db.js')

test('B12: planAddMany re-applies OLDER values verbatim (conflict-backup restore contract)', () => {
  // A storage-level LWW gate (DO UPDATE ... WHERE newer) was tried and REVERTED: sync-apply
  // adjudicates winners BEFORE the flush write, while the conflict-backup restore path
  // legitimately re-applies older values — the gate made restore silently no-op (d10/C8/parity red).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd20-plan-node-'))
  db.init(dir)
  db.call('planAddMany', [{ id: 'chip-b12', taskId: 't1', day: '2026-10-02', mm: '09:00', updatedAt: 900 }])
  // OLDER inbound chip (updatedAt 500 < 900): the upsert must still apply it verbatim —
  // this is exactly what syncConflictBackupRestore's older-value replay depends on.
  db.call('planAddMany', [{ id: 'chip-b12', taskId: 't1', day: '2026-10-02', mm: '10:00', updatedAt: 500 }])
  const live = db.call('planAll').filter((c) => String(c.id) === 'chip-b12')
  assert.equal(live.length, 1, 'the older insert lands (restore contract; LWW is adjudicated in sync-apply)')
  assert.equal(live[0].mm, '10:00', 'the older value is applied verbatim')
})

/* ---------- B11: attachment save is atomic (spool + rename) ---------- */
const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'd20-att-'))
const ELECTRON_STUB = { app: { getPath: () => TMPDIR, getVersion: () => '0.0.0-test' } }
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB
  return origLoad.call(this, request, parent, isMain)
}
const attachments = require('../../../src/main/attachments.js')

const b64 = (buf) => buf.toString('base64')

test('B11: a successful save leaves the final file and NO .att-tmp residue', async () => {
  const r = await attachments.saveAttachment({ taskId: 't', name: 'a.png', dataBase64: b64(Buffer.from('hello-png')) })
  const finalPath = path.join(TMPDIR, 'files', r.key)
  assert.ok(fs.existsSync(finalPath), 'the final file exists after the rename')
  const residue = fs.readdirSync(path.join(TMPDIR, 'files')).filter((f) => /\.att-tmp-\d+-\d+$/.test(f))
  assert.equal(residue.length, 0, 'the spool tmp is renamed away, never left behind')
})

test('B11: a crash mid-write (spool throws) leaves NO final file and no residue', async () => {
  // D22 update: the spool now routes through durable-fs writeFileDurable (tmp -> fsync ->
  // rename), so the crash is injected at the RENAME step (a real mid-publish crash point).
  // The invariant is unchanged: no final file, no tmp residue, and the error propagates.
  const realRename = fs.renameSync
  fs.renameSync = (from, to, ...rest) => {
    if (String(to).split(path.sep).pop().startsWith('t2_')) throw new Error('simulated crash mid-write')
    return realRename(from, to, ...rest)
  }
  try {
    await assert.rejects(attachments.saveAttachment({ taskId: 't2', name: 'b.png', dataBase64: b64(Buffer.from('x')) }),
      /simulated crash mid-write/)
  } finally {
    fs.renameSync = realRename
  }
  const filesDir = path.join(TMPDIR, 'files')
  const b = fs.readdirSync(filesDir).filter((f) => f.startsWith('t2_'))
  assert.equal(b.length, 0, 'red before the fix: the bare writeFileSync could leave a torn healthy-looking final file')
  const residue = fs.readdirSync(filesDir).filter((f) => /\.att-tmp-\d+-\d+$/.test(f))
  assert.equal(residue.length, 0, 'the finally-cleanup removed the spool tmp')
})

process.on('exit', () => { Module._load = origLoad })
