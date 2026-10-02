import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// mig-v6-corrupt-blob-freezes-schema-forever (P2): a corrupt db.settingsState blob made
// migrateV6 return false forever; the migrator loop (db.js `if (m.fn(db) === false) break`)
// froze schemaVersion at 5 across all boots. Fix: machine-local attempt counter
// sync.settingsBlobMigrationAttempts (TOMATO_PARTIAL_MIGRATION_ATTEMPTS_KEY pattern) — after
// 5 failed retry boots the migration escalates: log.error, return true, corrupt blob untouched.
// Red before the fix: all six boots returned false with schemaVersion stuck at 5.

const require = createRequire(import.meta.url)
const Database = require('../../../vendor/better-sqlite3-multiple-ciphers')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-migv6-escalate-'))
const db = new Database(path.join(dir, 'todos.db'))
// minimal tables migrateV6 touches (todos probe + meta); DDL exec creates settings_rows
db.exec('CREATE TABLE todos (id TEXT PRIMARY KEY); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
db.prepare("INSERT INTO meta (key, value) VALUES ('schemaVersion', '5')").run()
db.prepare("INSERT INTO meta (key, value) VALUES ('db.settingsState', 'not-json{')").run()

const errors = []
const syncSchema = require('../../../src/main/db-sync-schema.js')({
  getDb: () => db,
  log: { info () {}, warn () {}, error: (...a) => errors.push(a.join(' ')) }
})

test('corrupt blob: 5 retry boots stay pending, 6th boot escalates and advances', () => {
  const results = []
  for (let boot = 1; boot <= 6; boot++) results.push(syncSchema.migrateV6(db))
  assert.deepEqual(results, [false, false, false, false, false, true],
    'attempts 1-5 keep retrying (false), attempt 6 escalates (true)')

  // attempt counter visible in meta (machine-local), blob untouched
  const attempts = db.prepare("SELECT value FROM meta WHERE key = 'sync.settingsBlobMigrationAttempts'").get()
  assert.equal(attempts.value, '6')
  const blob = db.prepare("SELECT value FROM meta WHERE key = 'db.settingsState'").get()
  assert.equal(blob.value, 'not-json{', 'corrupt blob left untouched (no data destroyed)')

  // the escalation was loud, not silent
  assert.ok(errors.some(e => /still unparseable after 6 boots/.test(e)),
    'log.error fired on escalation, got: ' + JSON.stringify(errors))

  // no snapshot marker was stamped for the unparseable doc (idempotency bookkeeping unaffected)
  const snap = db.prepare("SELECT value FROM meta WHERE key = 'settingsRows.src.db.settingsState'").get()
  assert.equal(snap, undefined)
})

test('a parseable blob on a later boot migrates and clears the attempt counter', () => {
  db.prepare("UPDATE meta SET value = '{\"theme\":\"dark\"}' WHERE key = 'db.settingsState'").run()
  const ok = syncSchema.migrateV6(db)
  assert.equal(ok, true, 'parseable blob migrates')
  const attempts = db.prepare("SELECT value FROM meta WHERE key = 'sync.settingsBlobMigrationAttempts'").get()
  assert.equal(attempts, undefined, 'success clears the escalation counter')
  // the field landed in settings_rows (row split happened)
  const row = db.prepare("SELECT value FROM settings_rows WHERE key = 'theme'").get()
  assert.ok(row, 'migrated field exists as a settings row')
})
