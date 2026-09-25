/**
 * Regression test for the P2 backup-dirs migration unlink finding (2026-09-26).
 *
 * migrateLegacyBackups used to fs.unlinkSync(src) unconditionally on a same-named collision,
 * destroying a NEWER legacy snapshot in favor of an older copy already in the active root
 * (snapshot names are second-granularity timestamps, so same-name ≠ same-content).
 * The fix compares mtimes: the newer file survives.
 *
 * Run: node --test tests/unit/main/backup-dirs-migration.test.mjs
 * Isolation: fresh temp dirs only; the real %APPDATA%/pickdone is never touched.
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { migrateLegacyBackups } = await import('../../../src/main/backup-dirs.js')

let tmp
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pickdone-migration-')) })
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {} })

const NAME = 'auto-20260926-101010.json' // second-granularity name: same name, different content

test('migration: a NEWER legacy snapshot survives a same-name collision (newer wins, not the existing dst)', () => {
  const legacy = path.join(tmp, 'legacy')
  const root = path.join(tmp, 'root')
  fs.mkdirSync(legacy); fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, NAME), '{"old":true}')
  fs.utimesSync(path.join(root, NAME), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000)) // dst backdated 1 min
  fs.writeFileSync(path.join(legacy, NAME), '{"new":true}') // src is the NEWER copy
  migrateLegacyBackups(legacy, root)
  assert.equal(fs.readFileSync(path.join(root, NAME), 'utf8'), '{"new":true}',
    'the newer legacy snapshot must replace the older active-root copy (pre-fix code deleted it)')
  assert.ok(!fs.existsSync(path.join(legacy, NAME)), 'the legacy copy is consumed by the winning migration')
})

test('migration: an OLDER legacy snapshot is still dropped in favor of the newer active-root copy', () => {
  const legacy = path.join(tmp, 'legacy')
  const root = path.join(tmp, 'root')
  fs.mkdirSync(legacy); fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, NAME), '{"newer":true}') // dst is fresh
  fs.writeFileSync(path.join(legacy, NAME), '{"older":true}')
  fs.utimesSync(path.join(legacy, NAME), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
  migrateLegacyBackups(legacy, root)
  assert.equal(fs.readFileSync(path.join(root, NAME), 'utf8'), '{"newer":true}', 'the newer active-root copy must survive')
  assert.ok(!fs.existsSync(path.join(legacy, NAME)), 'the older legacy copy is still cleaned up (idempotent migration)')
})

test('migration: absent in root → legacy file is moved (unchanged behavior)', () => {
  const legacy = path.join(tmp, 'legacy')
  const root = path.join(tmp, 'root')
  fs.mkdirSync(legacy)
  fs.writeFileSync(path.join(legacy, NAME), '{"moved":true}')
  migrateLegacyBackups(legacy, root)
  assert.equal(fs.readFileSync(path.join(root, NAME), 'utf8'), '{"moved":true}')
  assert.ok(!fs.existsSync(path.join(legacy, NAME)))
})
