/**
 * SQLite storage backend for the sync relay (deployment mode).
 *
 * better-sqlite3 is an Electron-ABI native module: this backend only loads where
 * the app's vendor driver is reachable (ELECTRON_RUN_AS_NODE, packaged CLI).
 * Plain-node hosts use the file/memory stores in sync-relay.mjs — the storage
 * contract (appendEnvelope/getSince/upsertDevice/…/gc) is identical either way.
 *
 * GC semantics mirror memoryStore exactly: floor = min durable ack among ACTIVE
 * devices, capped by the latest snapshot's coversSeq (snapshot-safe, spec §28).
 */

import { createRequire } from 'node:module'
// D26: the GC cut comes from the SHARED helper in sync-relay.mjs (same file the memory/file
// backends use) so the two backends cannot drift — parity is pinned by d26-relay-gc-parity.
import { gcCutFloor } from './sync-relay.mjs'

export function sqliteStore(dbPath, { Database } = {}) {
  const require = createRequire(import.meta.url)
  let D = Database
  if (!D) {
    try {
      D = require('better-sqlite3')
    } catch (e) {
      throw new Error('sqliteStore: better-sqlite3 not loadable under this runtime (use fileStore, or run under the app\'s node): ' + e.message)
    }
  }
  const db = new D(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS envelopes (
      account TEXT NOT NULL,
      serverSeq INTEGER PRIMARY KEY AUTOINCREMENT,
      opId TEXT NOT NULL,
      envelopeJson TEXT NOT NULL,
      UNIQUE(account, opId)
    );
    CREATE TABLE IF NOT EXISTS devices (
      account TEXT NOT NULL,
      deviceId TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      lastAck INTEGER NOT NULL DEFAULT 0,
      lastSeen INTEGER NOT NULL DEFAULT 0,
      deviceSecret TEXT,
      PRIMARY KEY(account, deviceId)
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      account TEXT PRIMARY KEY,
      generation INTEGER NOT NULL,
      coversSeq INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `)
  // migration: relay DBs created before per-device bearer secrets lack the column
  if (!db.prepare('PRAGMA table_info(devices)').all().some(c => c.name === 'deviceSecret')) {
    db.exec('ALTER TABLE devices ADD COLUMN deviceSecret TEXT')
  }
  const now = () => Date.now()
  const insEnvelope = db.prepare('INSERT INTO envelopes (account, opId, envelopeJson) VALUES (?, ?, ?)')
  const byOp = db.prepare('SELECT serverSeq FROM envelopes WHERE account = ? AND opId = ?')
  const upsertDevice = db.prepare(`
    INSERT INTO devices (account, deviceId, status, lastAck, lastSeen, deviceSecret) VALUES (?, ?, 'active', 0, ?, ?)
    ON CONFLICT(account, deviceId) DO UPDATE SET
      status = COALESCE(?, status),
      lastAck = COALESCE(?, lastAck),
      lastSeen = ?,
      deviceSecret = COALESCE(?, deviceSecret)
  `)
  const getDeviceStmt = db.prepare('SELECT * FROM devices WHERE account = ? AND deviceId = ?')
  const activeFloor = account => {
    const r = db.prepare("SELECT MIN(lastAck) AS f FROM devices WHERE account = ? AND status = 'active'").get(account)
    return r && r.f != null ? r.f : 0
  }

  return {
    kind: 'sqlite',
    // Monotonic high-water mark of ISSUED seqs (D26): memoryStore's counter never regresses,
    // but MAX(serverSeq) of surviving rows shrinks when GC removes the tail — the snapshot
    // coversSeq guard (route /v1/snapshot/put) compares against issued history, so a GC'd
    // tail must not make a legitimate snapshot look "beyond history". sqlite_sequence
    // (AUTOINCREMENT bookkeeping) keeps the max-ever even after deletes, and resets to 0 on
    // a fresh/rebuilt DB — exactly matching memoryStore semantics (D25 reset still fires).
    lastSeq: () => {
      const m = db.prepare('SELECT COALESCE(MAX(serverSeq), 0) AS s FROM envelopes').get().s
      if (m) return m
      const r = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'envelopes'").get()
      return r ? Number(r.seq) : 0
    },
    appendEnvelope: (account, opId, envelopeJson) => {
      const dup = byOp.get(account, opId)
      if (dup) return { duplicate: true, serverSeq: dup.serverSeq }
      const r = insEnvelope.run(account, opId, envelopeJson)
      return { duplicate: false, serverSeq: Number(r.lastInsertRowid) }
    },
    getSince: (account, afterSeq, limit) =>
      db.prepare('SELECT serverSeq, envelopeJson FROM envelopes WHERE account = ? AND serverSeq > ? ORDER BY serverSeq LIMIT ?')
        .all(account, afterSeq, limit)
        .map(e => ({ serverSeq: e.serverSeq, envelopeJson: e.envelopeJson })),
    upsertDevice: (account, deviceId, patch = {}) => {
      upsertDevice.run(account, deviceId, now(), patch.deviceSecret ?? null, patch.status ?? null, patch.lastAck ?? null, now(), patch.deviceSecret ?? null)
      return getDeviceStmt.get(account, deviceId)
    },
    getDevice: (account, deviceId) => getDeviceStmt.get(account, deviceId) || null,
    listDevices: account => db.prepare('SELECT * FROM devices WHERE account = ?').all(account),
    putSnapshot: (account, snapshot) => {
      // clamp generation monotonically like memoryStore: a stale/lower-generation
      // snapshot must not silently regress (backend divergence found in review)
      const prev = db.prepare('SELECT generation FROM snapshots WHERE account = ?').get(account)
      snapshot = { ...snapshot, generation: Math.max(prev ? prev.generation : 0, snapshot.generation || 0) }
      db.prepare(`
        INSERT INTO snapshots (account, generation, coversSeq, data) VALUES (?, ?, ?, ?)
        ON CONFLICT(account) DO UPDATE SET
          generation = excluded.generation, coversSeq = excluded.coversSeq, data = excluded.data
      `).run(account, snapshot.generation, snapshot.coversSeq, JSON.stringify(snapshot))
    },
    latestSnapshot: account => {
      const r = db.prepare('SELECT data FROM snapshots WHERE account = ?').get(account)
      return r ? JSON.parse(r.data) : null
    },
    gcFloor: account => activeFloor(account),
    // Same cut as memoryStore via the SHARED gcCutFloor() helper (D26): the snapshot-less
    // ACK-ALONE margin used to be missing here, so self-hosted sqlite relays accumulated
    // envelopes forever. See sync-relay.mjs gcCutFloor for the semantics.
    gc: account => {
      const snap = db.prepare('SELECT coversSeq FROM snapshots WHERE account = ?').get(account)
      const cut = gcCutFloor({ ackFloor: activeFloor(account), coversSeq: snap ? snap.coversSeq : 0 })
      if (cut <= 0) return 0
      return Number(db.prepare('DELETE FROM envelopes WHERE account = ? AND serverSeq <= ?').run(account, cut).changes)
    },
    flush: () => {},
    close: () => db.close(),
  }
}
