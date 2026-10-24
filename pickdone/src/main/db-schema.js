/**
 * db-schema — the static core DDL, split from src/main/db.js (2026-10-24 size-ratchet
 * split queue). Pure string, zero logic. The runtime SCHEMA concatenation with the sync
 * schema DDL stays in db.js, where the syncSchema instance is wired to the live handle.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS todos (
  id            TEXT PRIMARY KEY,
  userId        INTEGER,
  content       TEXT,
  description   TEXT,
  complete      INTEGER NOT NULL DEFAULT 0,
  completedAt   INTEGER NOT NULL DEFAULT 0,
  deletedAt     INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0,
  createdAt     INTEGER NOT NULL DEFAULT 0,
  updatedAt     INTEGER NOT NULL DEFAULT 0,
  syncTime      INTEGER NOT NULL DEFAULT 0,
  scheduledAt   INTEGER NOT NULL DEFAULT 0,
  scheduledDay  INTEGER NOT NULL DEFAULT 0,
  remindAt      INTEGER,
  reminders     TEXT,
  sort          REAL NOT NULL DEFAULT 0,
  focusMinutes  INTEGER NOT NULL DEFAULT 0,
  difficulty    INTEGER,
  recurGroupId  TEXT,
  subtasks      TEXT,
  predecessors  TEXT,
  imageUrls     TEXT,
  fileAttach    TEXT,
  categoryId    INTEGER NOT NULL DEFAULT 0,
  priority      INTEGER NOT NULL DEFAULT 0,
  deadlineTs    INTEGER NOT NULL DEFAULT 0,
  important     INTEGER NOT NULL DEFAULT 0,
  urgent        INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'add',
  version       INTEGER NOT NULL DEFAULT 0,
  tz            TEXT,
  -- Row provenance (protocol v3, 2026-09-29): the device whose write produced this row's
  -- current updatedAt. Lets the merge layer suppress same-writer stale echoes instead of
  -- minting junk conflict copies. NULL = pre-v7 legacy row (unknown author).
  syncAuthor    TEXT
);
CREATE INDEX IF NOT EXISTS idx_todos_day       ON todos (deleted, scheduledDay);
CREATE INDEX IF NOT EXISTS idx_todos_status    ON todos (status);
CREATE INDEX IF NOT EXISTS idx_todos_repeat    ON todos (recurGroupId);
CREATE INDEX IF NOT EXISTS idx_todos_category  ON todos (deleted, categoryId, scheduledDay);
CREATE INDEX IF NOT EXISTS idx_todos_complete  ON todos (deleted, complete, scheduledDay);
CREATE INDEX IF NOT EXISTS idx_todos_reminder  ON todos (remindAt);
CREATE TABLE IF NOT EXISTS categories (
  id            INTEGER PRIMARY KEY,
  userId        INTEGER,
  name          TEXT,
  color         TEXT,
  createdAt     INTEGER,
  sort          INTEGER,
  isFolder      INTEGER DEFAULT 0,
  parentId      INTEGER DEFAULT 0,
  deleted       INTEGER DEFAULT 0,
  deletedAt     INTEGER NOT NULL DEFAULT 0,
  updatedAt     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS filters (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT,
  conds     TEXT,
  sort      INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER,
  deleted   INTEGER NOT NULL DEFAULT 0,
  deletedAt INTEGER NOT NULL DEFAULT 0,
  updatedAt INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS plan_chips (
  id     TEXT PRIMARY KEY,
  taskId TEXT NOT NULL,
  day    TEXT NOT NULL,
  mm     TEXT NOT NULL,
  sort   INTEGER NOT NULL DEFAULT 0,
  deleted   INTEGER NOT NULL DEFAULT 0,
  deletedAt INTEGER NOT NULL DEFAULT 0,
  updatedAt INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_plan_chips_day  ON plan_chips (day);
CREATE INDEX IF NOT EXISTS idx_plan_chips_task ON plan_chips (taskId);
CREATE TABLE IF NOT EXISTS tomato_records (
  tomatoId      TEXT PRIMARY KEY,
  endTime       INTEGER NOT NULL,
  dateKey       TEXT NOT NULL,
  focus         TEXT,
  focusTaskId   TEXT,
  focusDuration INTEGER NOT NULL DEFAULT 0,
  rest          INTEGER,
  restDuration  INTEGER,
  succeed       INTEGER NOT NULL DEFAULT 1,
  manual        INTEGER NOT NULL DEFAULT 0,
  status        TEXT,
  abandonReason TEXT,
  extra         TEXT,
  deleted       INTEGER NOT NULL DEFAULT 0,
  deletedAt     INTEGER NOT NULL DEFAULT 0,
  updatedAt     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tomato_records_date ON tomato_records (dateKey);
-- Round-3 perf (2026-09-26): tomatoAll's 'WHERE deleted = 0 ORDER BY endTime DESC' reload scan
-- becomes an ordered index search (same row order).
CREATE INDEX IF NOT EXISTS idx_tomato_records_endtime ON tomato_records (deleted, endTime);
-- Change-capture log (P1 sync groundwork 2026-09-15): one row per successful write op, appended in
-- call() next to the ledger hook. Ring-buffered (see appendOplog); consumers read deltas via the
-- syncOplogSince op and GC coverage comes from periodic full snapshots. commitSyncBatch is the
-- sync-ack echo path and deliberately does NOT log (a real sync engine must not feed itself).
CREATE TABLE IF NOT EXISTS sync_oplog (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  entity   TEXT NOT NULL,
  entityId TEXT NOT NULL,
  ts       INTEGER NOT NULL
);
-- Sync v2 revision store (v8 twin of the migration: fresh databases get the tables from
-- SCHEMA, upgrades get them from MIGRATIONS — same dual-manifest as every other table).
-- Written only while the sync.revisions.v2 flag is on; presence is inert at v1 runtime.
CREATE TABLE IF NOT EXISTS sync_revisions (
  revisionId     TEXT PRIMARY KEY,
  entity         TEXT NOT NULL,
  entityId       TEXT NOT NULL,
  authorDeviceId TEXT NOT NULL,
  hlcPhysical    INTEGER NOT NULL,
  hlcLogical     INTEGER NOT NULL,
  parents        TEXT NOT NULL DEFAULT '[]',
  payloadHash    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  createdAt      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sync_revisions_entity ON sync_revisions(entityId, hlcPhysical, hlcLogical);
CREATE INDEX IF NOT EXISTS idx_sync_revisions_hlc ON sync_revisions(hlcPhysical DESC, hlcLogical DESC);
CREATE TABLE IF NOT EXISTS sync_revision_payloads (
  revisionId TEXT PRIMARY KEY,
  payload    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_revision_current (
  entityId   TEXT PRIMARY KEY,
  revisionId TEXT NOT NULL
);`

module.exports = { SCHEMA }
