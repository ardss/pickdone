/**
 * Command manifest — single source of truth for renderer-reachable write commands
 * (refactor-command-bus.md Phase 1, docs/refactor-command-bus.md).
 *
 * One row per command. Gates (cli/check-command-bus.cjs) and the preload route table read
 * this file directly — keep it dependency-free (the Electron preload requires it in the
 * renderer bridge context, so no electron/ Heavy imports may leak in here).
 *
 * Row shape:
 *   entity     – logical entity ('todo' | 'meta' | ...)
 *   verb       – action within the entity
 *   sync       – 'full'  = row participates in device sync via the oplog capture in db.call
 *                'local' = machine-local state, never egresses (identity, per-peer alias)
 *                'none'  = internal GC-marker op, no per-row semantics
 *   lwwField   – the timestamp field the bus stamps (updatedAt source of truth: the bus);
 *                null when the op has no LWW age (pure appends, GC markers)
 *   tombstone  – 'row'    = physical row delete (hardDelete)
 *                'pointer' = soft delete / tombstone flag on a live row (todo delete,
 *                            filterDelete, planRemoveIds, settings rows...)
 *                'gc'      = single '*gc*' marker op (planPrune, tomatoMigrateFromMeta)
 *                null      = no deletion semantics
 *   localKeys  – optional (key) => boolean classifier for machine-local keys inside the
 *                payload (meta/settings rows that must neither egress nor be overwritten
 *                by a peer — mirrors src/main/sync-apply.js's filters, kept inline so this
 *                module stays dependency-free; the sync-apply filters remain authoritative)
 *   op         – the existing db.js op this command dispatches to (engine untouched)
 *   internal   – optional true = NOT renderer-reachable (no facade row, todo-db:call whitelist
 *                rejects it): main-process / CLI-surface commands added in Phase 2. The gate's
 *                facade-mirror check compares only renderer-scope rows.
 *
 * Phase-1 scope: every op the renderer can reach through the todo-db:call whitelist.
 * Phase-2 scope: the remaining non-renderer write surfaces — the CLI's write door, the main
 * process's purge channels / critical-backup restore / reminder watermark / CLI command-slot
 * bookkeeping, and the sync-apply bulk variants (declared here as internal commands even
 * though the sync engine itself calls them directly — see the gate's explicit ingress
 * exemption for src/main/sync-apply.js + src/main/lan-sync-bootstrap.js).
 */

// Machine-local meta keys (mirror of sync-apply.js isMachineLocalMetaKey — the user-data
// allowlist there stays authoritative; this copy only classifies, it never gates writes).
const isMachineLocalMetaKey = k => {
  const s = String(k)
  return s.startsWith('sync.') || s.startsWith('_') || /^securityLock/.test(s) ||
    s.startsWith('cliTomato') || s.startsWith('cliSync') || s === 'todosVersion' ||
    s.startsWith('firedReminders:') || s === 'reminderLastSeenAt' ||
    s.startsWith('settingsRows.src.') || s === 'db.tomatoState' || s === 'habitsState' ||
    s.startsWith('snowDedup:') || s.startsWith('metaConflictBackup.')
}

// Machine-local settings-row keys (mirror of sync-apply.js isMachineLocalSettingKey).
const isMachineLocalSettingKey = k => {
  const s = String(k)
  return s.startsWith('sync.') || /^securityLock/.test(s) || s.startsWith('_')
}

const COMMANDS = {
  // ---- todos ----
  // BESPOKE MERGE (docs/refactor-command-bus.md §Sync ingress): todos are the only entity with
  // recycle-bin conflict copies (merge.mjs mergeTodoRows → -conflict- rows), ghost-tombstone
  // guards and a userId normalizer. The engine ingress (src/main/sync-apply.js applyRowInner)
  // hand-rolls the todo branches on purpose — read them there before touching these rows.
  'todo.put':          { entity: 'todo', verb: 'put', sync: 'full', lwwField: 'updatedAt', tombstone: 'pointer', op: 'upsert' },
  'todo.putMany':      { entity: 'todo', verb: 'putMany', sync: 'full', lwwField: 'updatedAt', tombstone: 'pointer', op: 'upsertMany' },
  // Sync-ack echo path: db.call deliberately skips oplog capture for it (see db-oplog.js header)
  'todo.commitBatch':  { entity: 'todo', verb: 'commitBatch', sync: 'full', lwwField: 'updatedAt', tombstone: null, op: 'commitSyncBatch' },
  'todo.hardDelete':   { entity: 'todo', verb: 'hardDelete', sync: 'full', lwwField: null, tombstone: 'row', op: 'hardDelete' },
  'todo.hardDeleteMany': { entity: 'todo', verb: 'hardDeleteMany', sync: 'full', lwwField: null, tombstone: 'row', op: 'hardDeleteMany' },
  'todo.bump':         { entity: 'todo', verb: 'bump', sync: 'full', lwwField: 'updatedAt', tombstone: null, op: 'bumpSnow' },

  // ---- meta (key/value rows) ----
  'meta.put':          { entity: 'meta', verb: 'put', sync: 'full', lwwField: 'updatedAt', tombstone: null, localKeys: isMachineLocalMetaKey, op: 'setMeta' },
  'meta.delete':       { entity: 'meta', verb: 'delete', sync: 'full', lwwField: 'updatedAt', tombstone: 'row', localKeys: isMachineLocalMetaKey, op: 'deleteMeta' },

  // ---- categories ----
  'category.put':      { entity: 'category', verb: 'put', sync: 'full', lwwField: 'updatedAt', tombstone: 'row', op: 'upsertCategory' },

  // ---- smart filters ----
  'filter.put':        { entity: 'filter', verb: 'put', sync: 'full', lwwField: 'updatedAt', tombstone: null, op: 'filterUpsert' },
  'filter.delete':     { entity: 'filter', verb: 'delete', sync: 'full', lwwField: 'updatedAt', tombstone: 'row', op: 'filterDelete' },

  // ---- plan chips (schedule-chip row storage) ----
  'plan.putMany':      { entity: 'plan', verb: 'putMany', sync: 'full', lwwField: 'updatedAt', tombstone: null, op: 'planAddMany' },
  'plan.put':          { entity: 'plan', verb: 'put', sync: 'full', lwwField: 'updatedAt', tombstone: null, op: 'planUpdateChip' },
  'plan.removeIds':    { entity: 'plan', verb: 'removeIds', sync: 'full', lwwField: 'updatedAt', tombstone: 'row', op: 'planRemoveIds' },
  'plan.moveTask':     { entity: 'plan', verb: 'moveTask', sync: 'full', lwwField: 'updatedAt', tombstone: null, op: 'planMoveTask' },
  'plan.deleteTask':   { entity: 'plan', verb: 'deleteTask', sync: 'full', lwwField: 'updatedAt', tombstone: 'row', op: 'planDeleteTask' },
  'plan.deleteTaskDay': { entity: 'plan', verb: 'deleteTaskDay', sync: 'full', lwwField: 'updatedAt', tombstone: 'row', op: 'planDeleteTaskDay' },
  'plan.prune':        { entity: 'plan', verb: 'prune', sync: 'none', lwwField: null, tombstone: 'gc', op: 'planPrune' },

  // ---- pomodoro ledger (row storage, append-mostly) ----
  // BESPOKE MERGE (docs/refactor-command-bus.md §Sync ingress): tomato rows merge via
  // merge.mjs mergeTomatoRows (dedicated recency rules, no recycle-bin conflict copy) and read
  // their local tombstones from a separate tombstone read (tomatoTombstones) — see the
  // TOMB_FALLBACK_LOOKUP table in src/main/sync-apply.js.
  'tomato.appendMany': { entity: 'tomato', verb: 'appendMany', sync: 'full', lwwField: 'updatedAt', tombstone: null, op: 'tomatoAppendMany' },
  'tomato.updateById': { entity: 'tomato', verb: 'updateById', sync: 'full', lwwField: 'updatedAt', tombstone: null, op: 'tomatoUpdateById' },
  'tomato.removeByIds': { entity: 'tomato', verb: 'removeByIds', sync: 'full', lwwField: 'updatedAt', tombstone: 'row', op: 'tomatoRemoveByIds' },
  'tomato.migrateFromMeta': { entity: 'tomato', verb: 'migrateFromMeta', sync: 'none', lwwField: null, tombstone: 'gc', op: 'tomatoMigrateFromMeta' },

  // ---- settings/habits rows (P2 blob split, docs/sync §4.2) ----
  'setting.put':       { entity: 'setting', verb: 'put', sync: 'full', lwwField: 'updatedAt', tombstone: 'row', localKeys: isMachineLocalSettingKey, op: 'settingsRowPut' },
  'setting.putMany':   { entity: 'setting', verb: 'putMany', sync: 'full', lwwField: 'updatedAt', tombstone: 'row', localKeys: isMachineLocalSettingKey, op: 'settingsRowPutMany' },
  'setting.delete':    { entity: 'setting', verb: 'delete', sync: 'full', lwwField: 'updatedAt', tombstone: 'row', localKeys: isMachineLocalSettingKey, op: 'settingsRowDelete' },

  // ---- LAN sync identity/device ops (machine-local: sync:'local') ----
  'sync.setEnabled':   { entity: 'sync', verb: 'setEnabled', sync: 'local', lwwField: null, tombstone: null, op: 'syncSetEnabled' },
  'sync.setName':      { entity: 'sync', verb: 'setName', sync: 'local', lwwField: null, tombstone: null, op: 'syncSetName' },
  'sync.pairWithCode': { entity: 'sync', verb: 'pairWithCode', sync: 'local', lwwField: null, tombstone: null, op: 'syncPairWithCode' },
  'sync.addPeer':      { entity: 'sync', verb: 'addPeer', sync: 'local', lwwField: null, tombstone: null, op: 'syncAddPeer' },
  'sync.pairRespond':  { entity: 'sync', verb: 'pairRespond', sync: 'local', lwwField: null, tombstone: null, op: 'syncPairRespond' },
  'sync.pairRequest':  { entity: 'sync', verb: 'pairRequest', sync: 'local', lwwField: null, tombstone: null, op: 'syncPairRequest' },
  'sync.unpairPeer':   { entity: 'sync', verb: 'unpairPeer', sync: 'local', lwwField: null, tombstone: null, op: 'syncUnpairPeer' },
  'sync.setPeerAlias': { entity: 'sync', verb: 'setPeerAlias', sync: 'local', lwwField: null, tombstone: null, op: 'syncSetPeerAlias' },
  'sync.conflictBackupRestore': { entity: 'sync', verb: 'conflictBackupRestore', sync: 'local', lwwField: null, tombstone: null, op: 'syncConflictBackupRestore' },

  // ---- Phase 2: internal (non-renderer-surface) commands ----
  // Dangerous purge channels (db:purge-recycle-bin / db:purge-seed-todos): main-window-only IPC
  // + the CLI's `purge` command. oplog captures per-id todo tombstones (db-oplog.js), so sync:'full'.
  'todo.purgeBin':     { entity: 'todo', verb: 'purgeBin', sync: 'full', lwwField: null, tombstone: 'row', op: 'purgeRecycleBin', internal: true },
  'todo.purgeSeed':    { entity: 'todo', verb: 'purgeSeed', sync: 'full', lwwField: null, tombstone: 'row', op: 'purgeSeedTodos', internal: true },
  // Sync-apply bulk variants: called directly by the engine ingress (sync-apply.js) with
  // wire-carried LWW stamps; declared here so every write op in db.js WRITE_OPS has a manifest
  // row and the gate's census is total. Payloads are row arrays — the bus passes them verbatim.
  'category.putMany':  { entity: 'category', verb: 'putMany', sync: 'full', lwwField: 'updatedAt', tombstone: 'row', op: 'upsertCategoryMany', internal: true },
  'filter.putMany':    { entity: 'filter', verb: 'putMany', sync: 'full', lwwField: 'updatedAt', tombstone: null, op: 'filterUpsertMany', internal: true }
}

// op → command reverse index (derived, not hand-maintained). Multiple commands per op is
// forbidden by construction here — one row per op keeps the dbCall-alias routing total.
const OP_TO_COMMAND = {}
for (const [key, row] of Object.entries(COMMANDS)) {
  if (row.op in OP_TO_COMMAND) throw new Error('[command-manifest] duplicate op mapping: ' + row.op)
  OP_TO_COMMAND[row.op] = key
}

const keyOf = (entity, verb) => entity + '.' + verb
const lookup = (entity, verb) => COMMANDS[keyOf(entity, verb)] || null

module.exports = { COMMANDS, OP_TO_COMMAND, keyOf, lookup, isMachineLocalMetaKey, isMachineLocalSettingKey }
