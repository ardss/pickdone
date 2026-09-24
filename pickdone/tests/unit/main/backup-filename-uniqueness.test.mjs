/**
 * dw-wave6 F21 — same-tag same-second snapshots must not silently overwrite each other.
 * Regression for: run-auto-backup built the snapshot name as tag+YYYYMMDD-HHMMSS.json with no
 * uniqueness suffix; two evt-<reason> events in the same second (todoBackup.js fires evt snapshots
 * on back-to-back dangerous ops) renamed the second file onto the first — the earlier snapshot was
 * gone while {ok:true} was still returned. content-dedup cannot help (different content by design).
 * Fix: uniqueSnapshotName bumps the embedded stamp +1s per taken name (never a "-1" suffix: the
 * GFS sort/prune parsers only recognize the strict <tag>YYYYMMDD-HHMMSS.json shape, and a suffixed
 * name would parse as ts=0, sort oldest and get pruned first).
 * Run: node --test tests/unit/main/dw6-backup-filename-uniqueness.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'module'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const require_ = createRequire(import.meta.url)
const backup = require_(path.join(ROOT, 'src/main/handlers/backup.js'))
const fixUtil = require_(path.join(ROOT, 'src/main/fix-util.js'))

const stampOf = ms => {
  const d = new Date(ms)
  const p = n => String(n).padStart(2, '0')
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
}

test('F21: a taken snapshot name bumps the embedded stamp +1s instead of overwriting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw6-snapname-'))
  try {
    const base = Date.now()
    const stamp = stampOf(base)
    fs.writeFileSync(path.join(dir, `evt-purge-${stamp}.json`), '{}')
    const name = backup.uniqueSnapshotName(fs.existsSync.bind(fs), dir, 'evt-purge-', stamp, base)
    assert.notEqual(name, `evt-purge-${stamp}.json`, 'the taken name is not reused (old code silently overwrote it)')
    assert.equal(name, `evt-purge-${stampOf(base + 1000)}.json`, 'the collision resolves to the +1s stamped name')
    assert.ok(fixUtil.backupNameTs(name) > 0, 'the bumped name stays parseable by the GFS sort (a "-1" suffix would parse as ts=0 and get pruned first)')
    assert.ok(fixUtil.sortBackupNamesNewestFirst([`evt-purge-${stamp}.json`, name])[0] === name, 'the bumped snapshot sorts newest')
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) }
})

test('F21: two same-second collisions chain +2s; a free name is returned untouched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw6-snapname-'))
  try {
    const base = Date.now()
    const stamp = stampOf(base)
    fs.writeFileSync(path.join(dir, `auto-${stamp}.json`), '1')
    fs.writeFileSync(path.join(dir, `auto-${stampOf(base + 1000)}.json`), '2')
    assert.equal(backup.uniqueSnapshotName(fs.existsSync.bind(fs), dir, 'auto-', stamp, base), `auto-${stampOf(base + 2000)}.json`, 'collisions chain until a free name is found')
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw6-snapname-'))
    try {
      assert.equal(backup.uniqueSnapshotName(fs.existsSync.bind(fs), emptyDir, 'auto-', stamp, base), `auto-${stamp}.json`, 'no collision → the original name is untouched (behavior unchanged in the common case)')
    } finally { fs.rmSync(emptyDir, { recursive: true, force: true, maxRetries: 3 }) }
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) }
})
