/* D14 C10 regression — migration v9 duplicate collapse keeps the OLDEST-createdAt row. The old
 * `MIN(id)` survivor pick is lexicographic for the current TEXT task ids: an alphabetically
 * small but LATE-minted duplicate could win, tombstoning the instance the repeat chain actually
 * continues from. New rule: oldest createdAt, tie-broken by smallest id (deterministic on every
 * device/boot). Run: node --test tests/unit/main/d14-c10-migration-v9-survivor.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const buildMigrations = require_('../../../src/main/db-migrations.js')
const Database = require_('../../../vendor/better-sqlite3-multiple-ciphers')

test('C10: v9 duplicate collapse keeps the OLDEST-createdAt row for text ids (not lexicographic MIN(id))', () => {
  const d = new Database(':memory:')
  d.exec(`CREATE TABLE todos (
    id TEXT PRIMARY KEY, deleted INTEGER NOT NULL DEFAULT 0, deletedAt INTEGER NOT NULL DEFAULT 0,
    recurGroupId TEXT, scheduledDay INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL DEFAULT 0)`)
  // 'aaa' sorts FIRST lexicographically but was minted LATER; 'zzz' is the instance the repeat
  // chain continues from (oldest createdAt). MIN(id) would tombstone 'zzz' — the finding.
  d.prepare(`INSERT INTO todos (id, deleted, recurGroupId, scheduledDay, createdAt) VALUES ('zzz', 0, 'g1', 100, 1000)`).run()
  d.prepare(`INSERT INTO todos (id, deleted, recurGroupId, scheduledDay, createdAt) VALUES ('aaa', 0, 'g1', 100, 2000)`).run()
  buildMigrations(null, null) // attaches ensureRepeatDayUniqueness onto the factory function
  buildMigrations.ensureRepeatDayUniqueness(d)
  const live = d.prepare(`SELECT id FROM todos WHERE deleted = 0`).all().map(r => r.id)
  assert.deepEqual(live, ['zzz'], 'survivor = oldest createdAt (red before the fix: lexicographic MIN(id) kept aaa)')
  const dead = d.prepare(`SELECT id FROM todos WHERE deleted = 1`).all().map(r => r.id)
  assert.deepEqual(dead, ['aaa'], 'later duplicate tombstoned (recoverable), never destroyed')
  // idempotent: a second run changes nothing
  buildMigrations.ensureRepeatDayUniqueness(d)
  assert.deepEqual(d.prepare(`SELECT id FROM todos WHERE deleted = 0`).all().map(r => r.id), ['zzz'])
  d.close()
})
