/**
 * EditPanel save pipeline -- dirty-flag debounce queue (extracted from EditPanel.vue, 2026-09-12 S4 split).
 *
 * The save pipeline is the panel's global lifeline: child components only emit change events;
 * EditPanel.vue owns the state (subList/imgList/fileList/e) and funnels every mutation through
 * this queue. Semantics are ported verbatim from the original inline implementation:
 *
 * - queueSave(patch): debounce 350ms; on fire, merge the immediate patch with all dirty-flag
 *   fields (read at callback time), drain the flags, then dispatch todo/updateTodoFields once.
 *   The taskId is snapshotted at ENQUEUE time so switching tasks within the debounce window can
 *   never write A's edits onto B. Dispatch failure restores the drained keys into the dirty map
 *   (same retry semantics as flushSave) and surfaces the failure banner.
 * - flushSave(): immediate drain + dispatch of dirty fields MERGED with the still-pending debounce
 *   patch (H1 2026-09-16: clearTimeout used to discard the queued patch — edits made <350ms before
 *   a flush were silently lost); on failure the
 *   drained keys are restored into the dirty map so a later queueSave/flush retries them.
 * - markDirty(k): flag a list-style field (subtasks/imgs/files/preds) whose value is collected
 *   lazily via opts.dirtyPatchFor at drain time.
 * - takeDirty(keysFilter): drain ONLY the listed keys' flags and return their patch fragments
 *   (used by restoreFromBin, which persists subtasks/imgs/files). Unlisted dirty flags survive so
 *   a later queueSave/flushSave still persists them — draining all flags while returning only a
 *   subset silently dropped edits (2026-09-12 S5 fix).
 * - boot(): dirty state becomes live. The panel's immediate watchers fire before created(), so
 *   flush calls before boot are silent no-ops (same guard as the original `_dirtyFlags` check).
 */

export function createSaveQueue (store, opts) {
  const getTaskId = opts.getTaskId || (() => null)
  const dirtyPatchFor = opts.dirtyPatchFor || (() => ({}))
  const debounceMs = opts.debounceMs == null ? 350 : opts.debounceMs
  let timer = null
  let dirty = {}
  let booted = false

  const markDirty = (k) => { dirty[k] = 1 }

  const snapshot = (keys) => {
    const patch = {}
    for (const k of keys) Object.assign(patch, dirtyPatchFor(k) || {})
    return patch
  }

  /** Drain flags; with keysFilter only the listed keys are drained and returned (others stay dirty). */
  const drain = (keysFilter) => {
    const keys = Object.keys(dirty)
    if (!keysFilter) {
      dirty = {}
      return { keys, patch: snapshot(keys) }
    }
    const taken = keys.filter(k => keysFilter.includes(k))
    for (const k of taken) delete dirty[k]
    return { keys: taken, patch: snapshot(taken) }
  }

  /** Re-mark drained keys after a failed flush, merged with anything marked since (same merge order as the original). */
  const restore = (keys) => {
    const restored = {}
    for (const k of keys) restored[k] = 1
    dirty = Object.assign(restored, dirty)
  }

  /** [w16 P2 fix 2026-10-28] `pending` is now a MAP keyed by String(taskId) (entry: {taskId,
   *  patch}) — it used to be a single slot that queueSave's task-switch branch replaced wholesale,
   *  so a requeued failed dispatch for task A was silently overwritten by a later queueSave on
   *  task B (and vice versa) inside the debounce window. Same-task patches still merge. */
  let pending = {}

  /** Read back the pending entries in insertion order (values only). */
  const pendingEntries = () => Object.values(pending)

  /** Merge a patch into the pending slot of `taskId` (same-task patches merge; a different task
   *  gets its own slot — see the pending map comment above). */
  const setPending = (taskId, patch) => {
    const key = String(taskId)
    const cur = pending[key]
    pending[key] = { taskId, patch: cur ? Object.assign({}, cur.patch, patch) : Object.assign({}, patch) }
  }

  /** P2-5 (maint/dw 2026-09-23): re-queue a failed dispatch's immediate patch so retrySave / the
   *  next queueSave can actually replay it. Immediate fields (title, date, reminders) go through
   *  queueSave WITHOUT markDirty — they leave no trace in the dirty map, so the old catch blocks
   *  (which only restored dirty FLAGS) permanently dropped them. Each entry returns to its own
   *  per-taskId slot (same merge rule as queueSave: same-task patches merge). */
  const requeue = (entries) => {
    for (const queued of entries || []) {
      if (!queued || !Object.keys(queued.patch || {}).length) continue
      const cur = pending[String(queued.taskId)]
      setPending(queued.taskId, cur ? Object.assign({}, cur.patch, queued.patch) : queued.patch)
    }
  }

  const queueSave = (patch) => {
    clearTimeout(timer)
    // Race protection: snapshot the task id at enqueue time; the callback commits to the task "at enqueue time"
    setPending(getTaskId(), patch || {})
    timer = setTimeout(async () => {
      const entries = pendingEntries()
      pending = {}
      if (!entries.length) return
      const taskId = getTaskId()
      if (opts.onSaving) opts.onSaving(true)
      let drainedKeys = []
      const failedEntries = []
      try {
        const { keys: drained, patch: dirtyPatch } = drain()
        drainedKeys = drained
        const sameTask = taskId && entries.length === 1 && entries[0].taskId === taskId ? entries[0] : null
        if (sameTask) {
          const all = Object.assign({}, sameTask.patch, dirtyPatch)
          if (Object.keys(all).length) {
            await store.dispatch('todo/updateTodoFields', { taskId, patch: all })
          }
        } else {
          // Aligned with flushSave (H1 follow-up): each queued entry commits to its ENQUEUE-time
          // task — patches must never be silently dropped just because the current taskId went
          // null; dirty fields drained meanwhile go to the CURRENT task, never merged onto an old
          // one (same split as flushSave's task-switched branch). Per-entry failure isolation: a
          // failed dispatch requeues only ITS OWN patch (w16 fix).
          for (const ent of entries) {
            if (!ent.taskId || !Object.keys(ent.patch).length) continue
            try {
              await store.dispatch('todo/updateTodoFields', { taskId: ent.taskId, patch: ent.patch })
            } catch (e) { failedEntries.push(ent) }
          }
          if (taskId && Object.keys(dirtyPatch).length) {
            await store.dispatch('todo/updateTodoFields', { taskId, patch: dirtyPatch })
          }
          if (failedEntries.length) {
            restore(drainedKeys)
            requeue(failedEntries)
            if (opts.onFail) opts.onFail()
          }
        }
        // [w20 P2 fix 2026-10-30] onDone must not fire when the multi-task branch just failed:
        // it used to run unconditionally, so a per-entry failure lit the onFail banner and then
        // extinguished it in the same tick ("已保存" while the writes were only requeued). The
        // sameTask success path still lands here (failedEntries stays empty; a sameTask dispatch
        // failure throws into the outer catch, which also skips onDone).
        if (!failedEntries.length && opts.onDone) opts.onDone()
      } catch (e) {
        // The dispatch failed: re-mark the drained keys (merged with anything marked since, same order
        // as flushSave) so a later queueSave/flushSave retries them. Without this the drained batch was
        // gone for good -- onFail surfaced the banner but the edits were silently never persisted.
        // P2-5: the queued IMMEDIATE patches are re-queued too — they never had dirty flags, so
        // restoring flags alone discarded them forever (retrySave spun on an empty pending).
        restore(drainedKeys)
        requeue(entries)
        if (opts.onFail) opts.onFail()
      } finally {
        if (opts.onSaving) opts.onSaving(false)
      }
    }, debounceMs)
  }

  const flushSave = () => {
    if (!booted) return Promise.resolve() // the immediate watcher fires before created; the dirty state is not yet initialized
    clearTimeout(timer)
    const outs = []
    const entries = pendingEntries()
    pending = {}
    const taskId = getTaskId()
    const { keys, patch } = drain()
    const sameTask = taskId && entries.length === 1 && entries[0].taskId === taskId ? entries[0] : null
    if (sameTask) {
      // Same task: merge the pending debounce patch with the dirty fields into one dispatch (H1 fix —
      // previously clearTimeout here dropped `queued.patch` entirely).
      const all = Object.assign({}, sameTask.patch, patch)
      if (Object.keys(all).length) {
        outs.push(store.dispatch('todo/updateTodoFields', { taskId, patch: all }).catch(() => {
          restore(keys)
          requeue([sameTask]) // P2-5: the immediate half of the failed batch must survive too
          if (opts.onFail) opts.onFail()
        }))
      }
      return Promise.all(outs)
    }
    for (const ent of entries) {
      if (!ent.taskId || !Object.keys(ent.patch).length) continue
      // Task switched inside the debounce window: each queued entry still commits to its
      // enqueue-time task (same snapshot semantics as the debounce callback); dirty fields go to
      // the current task. [w16 fix] a failed entry requeues ONLY itself — never clobbers the
      // other tasks' pending slots.
      outs.push(store.dispatch('todo/updateTodoFields', { taskId: ent.taskId, patch: ent.patch }).catch(() => {
        requeue([ent])
        if (opts.onFail) opts.onFail()
      }))
    }
    if (taskId && keys.length) {
      outs.push(store.dispatch('todo/updateTodoFields', { taskId, patch }).catch(() => {
        // Restore the dirty flags for the keys that failed to persist and surface the failure banner
        restore(keys)
        if (opts.onFail) opts.onFail()
      }))
    }
    // Review P2 (2026-09-22): the flush promise is now RETURNED so callers (ui/closeEditCleanup's
    // orphan cleanup) can await the pending dispatch — previously fire-and-forget, forcing the
    // cleanup to guess with a fixed 60ms sleep while a fast typist's title was still in flight.
    return Promise.all(outs)
  }

  return {
    queueSave,
    flushSave,
    markDirty,
    /** Drain only `keysFilter` flags, returning their patch fragments (other flags stay dirty). */
    takeDirty: (keysFilter) => drain(keysFilter).patch,
    clearTimer: () => clearTimeout(timer),
    boot: () => { booted = true }
  }
}
