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
 *   never write A's edits onto B. Dispatch failure surfaces the failure banner (flags are NOT
 *   restored here -- same as the original).
 * - flushSave(): immediate drain + dispatch of dirty fields only (no extra patch); on failure the
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

  const queueSave = (patch) => {
    clearTimeout(timer)
    // Race protection: snapshot the task id at enqueue time; the callback commits to the task "at enqueue time"
    const taskId = getTaskId()
    timer = setTimeout(async () => {
      if (!taskId) return
      if (opts.onSaving) opts.onSaving(true)
      try {
        const { patch: dirtyPatch } = drain()
        const all = Object.assign({}, patch || {}, dirtyPatch)
        if (Object.keys(all).length) {
          await store.dispatch('todo/updateTodoFields', { taskId, patch: all })
        }
        if (opts.onDone) opts.onDone()
      } catch (e) {
        if (opts.onFail) opts.onFail()
      } finally {
        if (opts.onSaving) opts.onSaving(false)
      }
    }, debounceMs)
  }

  const flushSave = () => {
    if (!booted) return // the immediate watcher fires before created; the dirty state is not yet initialized
    clearTimeout(timer)
    const taskId = getTaskId()
    if (!taskId) return
    const { keys, patch } = drain()
    if (keys.length) {
      store.dispatch('todo/updateTodoFields', { taskId, patch }).catch(() => {
        // Restore the dirty flags for the keys that failed to persist and surface the failure banner
        restore(keys)
        if (opts.onFail) opts.onFail()
      })
    }
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
