/**
 * F4 P2 (2026-10-18) regression tests — legacy backup migration must be copy-then-atomic-replace:
 *   - the old newer-wins branch unlinked dst BEFORE renameSync(src,dst); a rename failure
 *     (EXDEV / AV-lock / disk full) destroyed BOTH snapshots. The fix copies src to a temp name
 *     inside the root and atomically renames over dst; a failure keeps BOTH original files.
 *   - the no-conflict rename failure used to be a bare catch{} (silent moved=0); it must log and
 *     keep the legacy file.
 * Rename failure is simulated by monkey-patching fs.renameSync (the module holds the shared fs
 * object, so the patch reaches it). Temp dirs only — the real profile is never touched.
 * Run: node --test tests/unit/main/backup-dirs-migration-safety.test.mjs
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { migrateLegacyBackups } = await import('../../../src/main/backup-dirs.js')

let tmp
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pickdone-migration-safety-')) })
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {} })

const NAME = 'auto-20260926-101010.json'

/** Patch fs.renameSync to throw on its Nth call; returns an undo function. */
function failRenameOnCall (n) {
  const orig = fs.renameSync
  let calls = 0
  fs.renameSync = (...args) => {
    calls++
    if (calls === n) throw Object.assign(new Error('EXDEV simulated rename failure'), { code: 'EXDEV' })
    return orig(...args)
  }
  return () => { fs.renameSync = orig }
}

/** Patch fs.renameSync to record every (src,dst) pair without throwing. */
function traceRename () {
  const orig = fs.renameSync
  const pairs = []
  fs.renameSync = (a, b) => { pairs.push([a, b]); return orig(a, b) }
  return { pairs, undo: () => { fs.renameSync = orig } }
}

test('migration: newer-wins replace failure keeps BOTH snapshots (no unlink-then-lose)', () => {
  const legacy = path.join(tmp, 'legacy')
  const root = path.join(tmp, 'root')
  fs.mkdirSync(legacy); fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, NAME), '{"old":true}')
  fs.utimesSync(path.join(root, NAME), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000)) // dst older
  fs.writeFileSync(path.join(legacy, NAME), '{"new":true}') // src newer — the replace branch
  const undo = failRenameOnCall(1) // the very first rename (tmp -> dst) fails
  try {
    assert.doesNotThrow(() => migrateLegacyBackups(legacy, root), 'a migration failure must never throw')
  } finally { undo() }
  // BOTH copies survive: the legacy snapshot was NOT consumed, the active-root copy was NOT deleted
  assert.equal(fs.readFileSync(path.join(root, NAME), 'utf8'), '{"old":true}', 'the existing dst must survive a failed replace')
  assert.equal(fs.readFileSync(path.join(legacy, NAME), 'utf8'), '{"new":true}', 'the legacy src must survive a failed replace (pre-fix code lost it)')
  // no temp residue left behind
  assert.equal(fs.readdirSync(root).filter(f => f.includes('migrate-tmp')).length, 0, 'the failed tmp copy must be swept')
})

test('migration: a successful newer-wins replace atomically lands the newer copy and consumes the legacy file', () => {
  const legacy = path.join(tmp, 'legacy')
  const root = path.join(tmp, 'root')
  fs.mkdirSync(legacy); fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, NAME), '{"old":true}')
  fs.utimesSync(path.join(root, NAME), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
  fs.writeFileSync(path.join(legacy, NAME), '{"new":true}')
  const tr = traceRename()
  try { migrateLegacyBackups(legacy, root) } finally { tr.undo() }
  assert.equal(fs.readFileSync(path.join(root, NAME), 'utf8'), '{"new":true}', 'the newer copy must replace dst')
  assert.ok(!fs.existsSync(path.join(legacy, NAME)), 'the consumed legacy copy is unlinked only AFTER the replace landed')
  // copy-then-replace: exactly one rename, tmp -> final name (same-volume atomic, no unlink-first)
  assert.equal(tr.pairs.length, 1, 'exactly one rename (tmp -> dst)')
  assert.equal(path.basename(tr.pairs[0][1]), NAME, 'the rename lands on the real name (atomic replace, no unlink-first window)')
  assert.ok(tr.pairs[0][0].includes('migrate-tmp'), 'the rename source is the staged tmp copy')
  assert.equal(fs.readdirSync(root).filter(f => f.includes('migrate-tmp')).length, 0, 'the tmp staging file is consumed by the rename')
})

test('migration: no-conflict rename failure logs and keeps the legacy file (no silent drop)', () => {
  const legacy = path.join(tmp, 'legacy')
  const root = path.join(tmp, 'root')
  fs.mkdirSync(legacy); fs.mkdirSync(root)
  fs.writeFileSync(path.join(legacy, NAME), '{"moved":true}')
  const undo = failRenameOnCall(1) // the single direct rename fails
  try {
    assert.doesNotThrow(() => migrateLegacyBackups(legacy, root))
  } finally { undo() }
  assert.equal(fs.readFileSync(path.join(legacy, NAME), 'utf8'), '{"moved":true}', 'the legacy copy must survive a failed move (pre-fix: bare catch, silent moved=0)')
})

test('migration: crash-residue tmp files from a previous interrupted replace are swept', () => {
  const legacy = path.join(tmp, 'legacy')
  const root = path.join(tmp, 'root')
  fs.mkdirSync(legacy); fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, NAME + '.migrate-tmp-1234-5678'), '{"stale":true}')
  fs.writeFileSync(path.join(legacy, NAME), '{"moved":true}')
  migrateLegacyBackups(legacy, root)
  assert.equal(fs.readdirSync(root).filter(f => f.includes('migrate-tmp')).length, 0, 'residue swept on the next migration run')
})
