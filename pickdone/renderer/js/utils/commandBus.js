/**
 * Renderer-side command-bus facade (Phase 1 of docs/refactor-command-bus.md).
 *
 * Renderer code NEVER calls db ops for writes directly: it commits commands —
 *   commit(entity, verb, payload) → main-process bus (validation + stamping + fanout).
 *
 * Route order:
 *   1. window.commands.commit (production bridge → 'commands:commit' IPC);
 *   2. fallback: window.todoAPI.dbCall with the manifest's op — the main-side handler routes
 *      manifest write ops through the SAME bus regardless of channel, so the door is identical;
 *      this bridge also keeps the unit suites (which stub window.todoAPI.dbCall per-op and assert
 *      the recorded ops) behaviorally green without a single assertion edit.
 *
 * VERB_TO_OP is a mirror of src/main/command-manifest.js OP_TO_COMMAND — kept literal so
 * this module stays import-free for the renderer bundle; cli/check-command-bus.cjs
 * cross-checks the mirror against the manifest (drift = red gate).
 */

export const VERB_TO_OP = {
  'todo.put': 'upsert',
  'todo.putMany': 'upsertMany',
  'todo.commitBatch': 'commitSyncBatch',
  'todo.hardDelete': 'hardDelete',
  'todo.hardDeleteMany': 'hardDeleteMany',
  'todo.bump': 'bumpSnow',
  'meta.put': 'setMeta',
  'meta.delete': 'deleteMeta',
  'category.put': 'upsertCategory',
  'filter.put': 'filterUpsert',
  'filter.delete': 'filterDelete',
  'plan.putMany': 'planAddMany',
  'plan.put': 'planUpdateChip',
  'plan.removeIds': 'planRemoveIds',
  'plan.moveTask': 'planMoveTask',
  'plan.deleteTask': 'planDeleteTask',
  'plan.deleteTaskDay': 'planDeleteTaskDay',
  'plan.prune': 'planPrune',
  'tomato.appendMany': 'tomatoAppendMany',
  'tomato.updateById': 'tomatoUpdateById',
  'tomato.removeByIds': 'tomatoRemoveByIds',
  'tomato.migrateFromMeta': 'tomatoMigrateFromMeta',
  'setting.put': 'settingsRowPut',
  'setting.putMany': 'settingsRowPutMany',
  'setting.delete': 'settingsRowDelete',
  'sync.setEnabled': 'syncSetEnabled',
  'sync.setName': 'syncSetName',
  'sync.pairWithCode': 'syncPairWithCode',
  'sync.addPeer': 'syncAddPeer',
  'sync.pairRespond': 'syncPairRespond',
  'sync.pairRequest': 'syncPairRequest',
  'sync.unpairPeer': 'syncUnpairPeer',
  'sync.setPeerAlias': 'syncSetPeerAlias',
  'sync.conflictBackupRestore': 'syncConflictBackupRestore'
}

function legacyDbCall (op, params) {
  if (typeof window === 'undefined' || !window.todoAPI || !window.todoAPI.dbCall) return Promise.resolve(null)
  return window.todoAPI.dbCall(op, params)
}

/** The mutation API: commit(entity, verb, payload[, opts]). */
export function commit (entity, verb, payload, opts) {
  const c = (typeof window !== 'undefined' && window.commands) || null
  if (c && typeof c.commit === 'function') return c.commit(entity, verb, payload, opts)
  const op = VERB_TO_OP[entity + '.' + verb]
  if (!op) return Promise.reject(new Error('[command-bus] unknown command: ' + entity + '.' + verb))
  return legacyDbCall(op, payload)
}
// Phase-3 demolition: the op-keyed commitOp bridge export is gone (grep-zero callers — pending
// queue replay paths call window.todoAPI.dbCall directly, and the main-side handler still routes
// those manifest writes through the bus). commit() above is the only renderer mutation entry.
