/**
 * Extracted from src/main/db.js (structure-size ratchet): the explicit write-op list and the
 * ledger-write op set. Pure data — moved verbatim, no behavior change.
 */

// Explicit write-op list: the todo-db:call handler uses it to decide reloadAll+broadcastTodosChanged.
// Do not guess with regexes — write ops like hardDeleteMany/filterDelete/clearCategories were once missed, leaving cross-window data stale.
const WRITE_OPS = new Set([
  'upsert', 'upsertMany', 'commitSyncBatch', 'bumpSnow', 'hardDelete', 'hardDeleteMany', 'setMeta', 'deleteMeta',
  'purgeRecycleBin', 'purgeSeedTodos', 'upsertCategory',
  'filterUpsert', 'filterDelete',
  'planAddMany', 'planUpdateChip', 'planRemoveIds', 'planMoveTask',
  'tomatoAppendMany', 'tomatoUpdateById', 'tomatoRemoveByIds', 'tomatoMigrateFromMeta',
  'planDeleteTask', 'planDeleteTaskDay', 'planPrune', 'settingsRowPut', 'settingsRowPutMany', 'settingsRowDelete',
  'upsertCategoryMany', 'filterUpsertMany', 'setMetaMany'
])
const isWriteOp = op => WRITE_OPS.has(op)

/** Ledger-write ops: any process (App main IPC / CLI direct db) writing these through call()
 *  fires the ledger-changed hook (App broadcasts tomato-records-changed). */
const LEDGER_WRITE_OPS = new Set(['tomatoAppendMany', 'tomatoUpdateById', 'tomatoRemoveByIds', 'tomatoMigrateFromMeta'])

module.exports = { WRITE_OPS, isWriteOp, LEDGER_WRITE_OPS }
