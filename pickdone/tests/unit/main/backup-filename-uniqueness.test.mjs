/**
 * dw-wave6 F21 + D17 (2026-10-02) — same-tag same-second snapshots must not silently overwrite
 * each other, and the collision resolution must not mint FUTURE-dated names. Regression for the
 * old +1s..+900s stamp bumps: a bumped name could collide with a REAL snapshot landing seconds
 * later (the dup snapshot was dedup'd away, so the future name looked free — the real snapshot
 * then atomically overwrote it and the recovery point was gone). Collisions now resolve to a
 * `-dup<n>` suffix AFTER the stamp; the common (no-collision) path keeps the historical naming.
 * Run: node --test tests/unit/main/backup-filename-uniqueness.test.mjs
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

test('D17/F21: a taken snapshot name resolves to a -dup suffix, never a future-dated stamp', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw6-snapname-'))
  try {
    const base = Date.now()
    const stamp = stampOf(base)
    fs.writeFileSync(path.join(dir, `evt-purge-${stamp}.json`), '{}')
    const name = backup.uniqueSnapshotName(fs.existsSync.bind(fs), dir, 'evt-purge-', stamp, base)
    assert.equal(name, `evt-purge-${stamp}-dup1.json`, 'the collision resolves to the -dup1 suffix (not a +1s future stamp)')
    assert.ok(!/\.json$/.test(name.replace(/-dup\d+\.json$/, '.json')) || !name.includes(stampOf(base + 1000)), 'no future stamp minted')
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) }
})

test('D17/F21: same-second collisions chain -dup1, -dup2, ...; a free name is returned untouched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw6-snapname-'))
  try {
    const base = Date.now()
    const stamp = stampOf(base)
    fs.writeFileSync(path.join(dir, `auto-${stamp}.json`), '1')
    fs.writeFileSync(path.join(dir, `auto-${stamp}-dup1.json`), '2')
    assert.equal(backup.uniqueSnapshotName(fs.existsSync.bind(fs), dir, 'auto-', stamp, base), `auto-${stamp}-dup2.json`, 'collisions chain through the dup space')
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw6-snapname-'))
    try {
      assert.equal(backup.uniqueSnapshotName(fs.existsSync.bind(fs), emptyDir, 'auto-', stamp, base), `auto-${stamp}.json`, 'no collision → the original name is untouched (behavior unchanged in the common case)')
    } finally { fs.rmSync(emptyDir, { recursive: true, force: true, maxRetries: 3 }) }
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) }
})

test('D17/F21: a -dup name never shadows a real timestamped snapshot in the GFS sort', () => {
  const base = Date.now()
  const stamp = stampOf(base)
  const dup = `auto-${stamp}-dup1.json`
  const later = `auto-${stampOf(base + 5000)}.json`
  // ts=0 for the dup: it sorts oldest and is pruned first — it can never be mistaken for the
  // newest twin in dedup (newestSameTag) nor shielded in retention.
  assert.equal(fixUtil.backupNameTs(dup), 0)
  assert.equal(fixUtil.sortBackupNamesNewestFirst([dup, later])[0], later)
})

test('D17/F21: an exhausted 900-dup-name space returns null (never an already-taken name)', () => {
  const alwaysTaken = () => true
  assert.equal(backup.uniqueSnapshotName(alwaysTaken, 'C:\\dir', 'auto-', '20260925-120000', 1e12), null,
    'exhaustion must return null so the caller can report failure instead of silently overwriting an existing snapshot')
})
