/**
 * lib-chips — the chips/focus snapshot family, split from cli/lib.js (2026-10-24
 * size-ratchet split queue). Factory-injected with the db facade (commit/open) plus the
 * tomato state probes (readTomatoState/writeTomatoCmd, themselves provided to lib.js by
 * lib-tomato.cjs); localDayKey is a pure util required directly. No dispatch, no policy.
 */
const { localDayKey } = require('../src/main/fix-util.js') // P3-8: single source for the local-day key
module.exports = ({ commit, open, readTomatoState, writeTomatoCmd }) => {
/** [F2 2026-10-17] Is a RUNNING focus currently bound to this taskId (durable session row first, last command receipt as fallback)? Only a FRESH receipt counts — cliTomatoState is a single slot that survives App death, so without the freshness bound a long-gone session would still trigger the detach write. 15s mirrors the renderer's receipt write cadence with generous slack. */
function focusBoundTo (taskId) {
  try {
    const sess = JSON.parse(open().call('getMeta', 'tomatoRunningSession') || 'null')
    if (sess && sess.status === 'startTomatoTime' && sess.attachTaskId === taskId) return 'session'
  } catch { /* absent/corrupt row: fall through to the receipt */ }
  try {
    const st = readTomatoState()
    if (st && st.status === 'startTomatoTime' && st.attach && st.attach.taskId === taskId &&
        st.at && (Date.now() - st.at) < 15000) return 'receipt'
  } catch { /* unreadable receipt: not bound */ }
  return null
}

/** Renderer parity detach: write the attach-null command slot so the running App drops the focus
 *  binding before the row lands in the recycle bin. Loud-not-silent on a channel failure, same
 *  policy as chipsSnapshotForDelete. */
function detachFocusedTomato (taskId) {
  if (!taskId || !focusBoundTo(taskId)) return
  try {
    writeTomatoCmd({ action: 'attach', taskId: null }, { silent: true })
    console.error(`note: an active focus was attached to ${taskId} — a detach command was written so the completion record does not book to a recycle-bin task`)
  } catch (e) {
    console.error(`warning: could not write the tomato detach command for focused task ${taskId} (${e && e.message ? e.message : e}) — the running focus may stay bound to a recycle-bin task`)
  }
}

/** Snapshot all of a task's chips into meta (planChipsSnapshot:<taskId>) before clearing its rows.
 *  D18-DOM2 (#11): a cascade failure is not a SILENT bare catch — it warns to stderr with the task id and the deletion still proceeds (App parity: warn + continue). */
function chipsSnapshotForDelete (taskId) {
  try {
    const rows = open().call('planAll', []).filter(r => r.taskId === taskId)
    if (rows.length) commit('meta', 'put', ['planChipsSnapshot:' + taskId, JSON.stringify(rows)])
    commit('plan', 'deleteTask', taskId)
  } catch (e) {
    // snapshot failure must not block deletion — but it must be loud (orphan-chip signal)
    console.error(`warning: chip snapshot/cascade failed for task ${taskId} (${e && e.message ? e.message : e}) — schedule chips may be orphaned`)
  }
}

/** P3-10 (dw wave): chipsRemoveTask deleted — dead export (zero callers repo-wide; deleteTodo goes
 *  through chipsSnapshotForDelete, purgeRecycleBin relies on the db-layer cascade). */

/** Day-change chip migration (same semantics as the UI's moveTaskChips and the `edit --date` follow-up):
 *  existing chips keep their times and follow the task to the new day. Best-effort — never blocks the patch. */
function migrateChipsOnDayChange (taskId, oldDay, newDay) {
  if (!oldDay || !newDay || oldDay === newDay) return 0
  try {
    if (localDayKey(oldDay) === localDayKey(newDay)) return 0
    commit('plan', 'moveTask', { taskId, fromDay: localDayKey(oldDay), toDay: localDayKey(newDay) })
    return 1
  } catch { return 0 }
}

/** Restore a task: backfill the schedule chips snapshotted before deletion.
 *  LWW re-stamp on restore (renderer twin: renderer/js/utils/dayPlans.js restoreSnapshot): the snapshot rows carry their PRE-DELETE updatedAt (planAddMany preserves explicit stamps) while the delete stamped a FRESH tombstone — over LAN the restored chips lost every LWW round against newer peer chip-tombstones and were silently re-deleted; re-stamp fresh instead. */
function chipsRestoreSnapshot (taskId) {
  try {
    const raw = open().call('getMeta', 'planChipsSnapshot:' + taskId)
    if (!raw) return 0
    const rows = JSON.parse(raw)
    if (Array.isArray(rows) && rows.length) commit('plan', 'putMany', rows.map(r => ({ ...r, updatedAt: Date.now() })))
  // Round-3 P1: '' → deleteMeta (file-wide convention, renderer clearSnapshot parity) — a '' value is NOT a tombstone here, it is a stale meta row a later task-id collision could misread as an (empty) snapshot; deleteMeta propagates the removal to peers too.
    commit('meta', 'delete', 'planChipsSnapshot:' + taskId)
    return rows.length
  } catch { return 0 }
}
  return {
    focusBoundTo,
    detachFocusedTomato,
    chipsSnapshotForDelete,
    migrateChipsOnDayChange,
    chipsRestoreSnapshot,
  }
}
