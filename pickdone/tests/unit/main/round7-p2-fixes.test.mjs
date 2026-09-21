/* QC Round-7 P2 regression tests (2026-09-21): real better-sqlite3 / real module state, no fabricated shapes.
 *   P2-5  a failed bulk flush must NOT emit the applied round to renderers (no todos-changed /
 *         external-settings-changed / blob fold for rows the flush dropped)
 *   P2-3  the v6 settings migration must not re-stamp pre-existing settings_rows with local now —
 *         the whole-blob merge is gated (by the blob's _savedAt when present, else 0) so restored
 *         pre-v6 backups cannot out-rank a peer's newer live settings via a fresh LWW stamp
 *
 * Run: node --test tests/unit/main/round7-p2-fixes.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const bootstrap = require_('../../../src/main/lan-sync-bootstrap.js')
const syncSchema = require_('../../../src/main/db-sync-schema.js')

/* ---------- P2-5: emit is gated on flush success ---------- */

function mockSyncState ({ poisonFlush }) {
  const sent = []
  let resyncs = 0
  const state = {
    deviceId: 'devR7P2',
    applyCache: null,
    applied: null, // set per-test
    // a buffered settings row: when poisonFlush, the settingsRowPutMany bulk op throws
    // (same contract as a real poison row) and flushPendingWrites reports { ok:false }
    pendingWrites: {
      todos: [], tomatoes: [], categories: [], plans: [], filters: [],
      settings: [{ key: 'dailyTomatoTarget', value: '12', updatedAt: Date.now() - 1000 }],
    },
    db: {
      call: (op) => {
        if (poisonFlush && op === 'settingsRowPutMany') throw new Error('poison row')
        if (op === 'setMeta') throw new Error('fold surface unavailable in test')
        return true
      },
    },
    getWindowSenders: () => [{ isDestroyed: () => false, send: (ch, msg) => sent.push(ch) }],
    resyncExternalWatch: () => { resyncs++ },
  }
  return { state, sent, resyncCount: () => resyncs }
}

test('P2-5: a failed flush stamps flushFailed and emits NOTHING to renderers (round patch unconsumed)', () => {
  const { state, sent } = mockSyncState({ poisonFlush: true })
  state.applied = { kinds: new Set(['setting', 'todo']), conflicts: [], settingsPatch: { dailyTomatoTarget: 12 } }
  bootstrap.__test.setState(state)

  const r = bootstrap.__test.finalizeIngest({})
  assert.equal(r.flushFailed, true, 'the ingest result must carry flushFailed (ack honesty unchanged)')
  assert.equal(sent.length, 0, 'no todos-changed / external-settings-changed for rows the flush dropped')
  assert.ok(state.applied, 'the round bookkeeping stays put (no phantom consumption)')
})

test('P2-5: a successful flush still emits the applied round (behavior unchanged on the happy path)', () => {
  const { state, sent } = mockSyncState({ poisonFlush: false })
  state.applied = { kinds: new Set(['setting', 'todo']), conflicts: [], settingsPatch: { dailyTomatoTarget: 12 } }
  bootstrap.__test.setState(state)

  const r = bootstrap.__test.finalizeIngest({ appliedCount: 7 })
  assert.equal(r.flushFailed, undefined)
  assert.ok(sent.includes('todos-changed'), 'todos-changed fires on a clean round')
  assert.ok(sent.includes('external-settings-changed'), 'settings hot-apply fires on a clean round')
  assert.equal(state.applied, null, 'the round is consumed exactly once')
})

test('P2-5: snapshot-path flush failure still throws (round fails, pull watermark safe)', () => {
  const { state } = mockSyncState({ poisonFlush: true })
  state.applied = { kinds: new Set(), conflicts: [], settingsPatch: {} }
  bootstrap.__test.setState(state)
  assert.throws(() => bootstrap.__test.finalizeIngest(null, { snapshot: true }), /snapshot flush failed/)
  // the failed flush already drained the buffers — re-arm one poison row for the chunk variant
  state.pendingWrites.settings = [{ key: 'k', value: '1', updatedAt: 1 }]
  assert.throws(() => bootstrap.__test.finalizeIngest(null, { snapshot: true, chunk: true }), /snapshot chunk flush failed/)
})

/* ---------- P2-3: v6 migration merge is gated — pre-existing rows keep their LWW age ---------- */

function preV6Db () {
  const Database = require_('../../../vendor/better-sqlite3-multiple-ciphers')
  const d = new Database(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-r7-p2-')), 'todos.db'))
  // Minimal pre-v6 shape: no tz column yet; settings_rows exists only because these tests seed
  // pre-existing rows to prove the gate preserves them (migrateV6's CREATE IF NOT EXISTS is idempotent)
  d.exec('CREATE TABLE todos (id TEXT PRIMARY KEY, content TEXT)')
  d.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
  d.exec(syncSchema({ getDb: () => d, log: { warn () {} } }).DDL)
  return d
}

test('P2-3: migrateV6 with a _savedAt-stamped backup blob keeps newer rows and stamps only absent fields', () => {
  const d = preV6Db()
  const schema = syncSchema({ getDb: () => d, log: { warn () {} } })
  const T0 = Date.now() - 60000 // the backup blob's snapshot moment, a minute ago
  // a row that already exists and is NEWER than the backup snapshot (the peer's live truth)
  d.prepare(`INSERT INTO settings_rows (key, value, updatedAt, deleted, deletedAt) VALUES ('theme', '"dark"', ?, 0, 0)`)
    .run(Date.now())
  d.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
    .run('db.settingsState', JSON.stringify({ theme: 'light', language: 'en', _savedAt: T0 }))

  const ok = schema.migrateV6(d)
  assert.equal(ok, true, 'migration succeeds')
  const rows = Object.fromEntries(d.prepare('SELECT key, value, updatedAt FROM settings_rows').all().map(r => [r.key, r]))
  assert.equal(rows.theme.value, '"dark"', 'the newer live row is NOT overwritten by the backup value')
  assert.ok(rows.theme.updatedAt > T0 + 30000, 'the newer live row keeps its own (recent) stamp — no local-now re-stamp needed, and none allowed')
  const before = rows.theme.updatedAt
  assert.equal(rows.language.value, '"en"', 'an absent field is stamped exactly once so it exists at all')
  assert.ok(Math.abs(rows.language.updatedAt - Date.now()) < 10000, 'absent field carries the migration-time stamp')
  assert.equal(d.prepare('SELECT value FROM meta WHERE key = ?').get('settingsRows.src.db.settingsState').value,
    JSON.stringify({ theme: 'light', language: 'en', _savedAt: T0 }), 'the snapshot marker records the migrated blob shape')
  void before
})

test('P2-3: migrateV6 with a stamp-less blob gates at 0 — every pre-existing row is preserved, absent fields still land', () => {
  const d = preV6Db()
  const schema = syncSchema({ getDb: () => d, log: { warn () {} } })
  const keepTs = Date.now() - 12345 // a pre-existing row with a REAL (old) LWW age
  d.prepare(`INSERT INTO settings_rows (key, value, updatedAt, deleted, deletedAt) VALUES ('dailyTomatoTarget', '10', ?, 0, 0)`).run(keepTs)
  d.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
    .run('habitsState', JSON.stringify({ dailyTomatoTarget: 99, moments: [] })) // legacy bare-key blob, no _savedAt

  const ok = schema.migrateV6(d)
  assert.equal(ok, true)
  const row = d.prepare(`SELECT value, updatedAt FROM settings_rows WHERE key = 'dailyTomatoTarget'`).get()
  assert.equal(row.value, '10', 'gate 0: the pre-existing row wins — the backup value must not steal LWW with a now-stamp')
  assert.equal(row.updatedAt, keepTs, 'the pre-existing row keeps its real age (was re-stamped to now before the fix)')
  const moments = d.prepare(`SELECT value FROM settings_rows WHERE key = 'moments'`).get()
  assert.ok(moments, 'absent fields still land (once)')
})
