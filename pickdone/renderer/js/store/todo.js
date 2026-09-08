/**
 * Core todo module — state/action semantics aligned with the reference todo module
 * status: add/update/delete -> sync; local meta.todosVersion acts as the sync cursor
 */
import { genTaskId, nextSort, dayjs, reportError, DAY_MS, rangeDays, parsePredecessors } from '../utils/core.js'
import { expandRepeatDates } from '../utils/repeat.js'
import { sortByMode } from '../utils/sortMode.js'
import { getEstimate } from '../utils/tomatoEstimate.js'
import { saveRuntime } from './runtimeState.js'
import { moveTaskChips, clearTaskChips, snapshotForDelete, restoreSnapshot, clearSnapshot } from '../utils/dayPlans.js'

/** Chip-sync serial chain: when a task's reschedule fires in bursts, guarantees planMoveTask arrival order matches operation order */
const _chipSyncChain = new Map()

/** Persistence blob format version (shared by the todoState/categoryState/habitsState segments in backup dumps);
 *  note this is unrelated to state.version (the sync counter). The restore side refuses to import segments >1 (preventing downgrade misreads). */
const SCHEMA_V = 1

/** Feedback summary for undo/redo moved into persistSnapshotDiff's returned changedRows (2026-09-02:
    the original diffLabel did two more rounds of full stringify over both snapshots just to extract one title; removed with the string-snapshot refactor) */


const DEFAULT_VIEWS = () => ({

    todayTodoList: [],
    todayDoneList: [],
    yesterdayTodoList: [],
  calendar: [],
  todoBox: [],
  todoBoxCount: 0,
  completed: [],
    recycleBin: []
})

/** Unified exit for DB persistence: failures are logged, never producing floating rejections (local/DB mismatch is visible in the console)
 *  JSON round-trip de-proxies: row objects come from reactive state, so nested arrays like reminderOffsets are Proxies
 *  that fail IPC structured cloning (symptom: every task edit logs "An object could not be cloned" and the DB receives no update) */
// ---- Task dependencies (experimental, developerMode gated) ----
// predecessors: JSON array of predecessor taskId strings, stored in a TEXT column (same pattern as subtasks)
// FS semantics: a task is ready only when all of its predecessors are complete. Write-time DFS cycle guard — both renderer store and CLI
// mirror this helper (they bypass each other and share no code).
// parsePredecessors lives in utils/core.js (shared with DepView)
function wouldCycle (list, taskId, newPreds) {
  const byId = {}
  for (const t of list) { if (!t.delete) byId[t.taskId] = t }
  byId[taskId] = Object.assign({}, byId[taskId] || { taskId }, { predecessors: JSON.stringify(newPreds) })
  const done = {}
  const visiting = {}
  const walk = id => {
    if (done[id]) return false
    if (visiting[id]) return true
    visiting[id] = true
    const t = byId[id]
    if (t) {
      for (const p of parsePredecessors(t.predecessors)) {
        if (byId[p] && walk(p)) return true
      }
    }
    visiting[id] = false; done[id] = true
    return false
  }
  return walk(taskId)
}
function isTaskReady (list, t) {
  const preds = parsePredecessors(t.predecessors)
  if (!preds.length) return true
  const byId = {}
  for (const x of list) { if (!x.delete) byId[x.taskId] = x }
  return preds.every(pid => { const p = byId[pid]; return !p || p.complete })
}
// ---- DB write pending queue (mirrors tomato.js's _pendingLedger): a failed task upsert stays queued and replays on the next quit flush, so a transient IPC/db failure can't silently drop a task edit ----
const _pendingUpserts = []
let _todoFlushHooked = false
function safeUpsert (row) {
  let plain
  try { plain = JSON.parse(JSON.stringify(row)) } catch (e) { plain = row }
  const entry = { op: 'upsert', params: plain }
  _pendingUpserts.push(entry)
  Promise.resolve(window.todoAPI.dbCall('upsert', plain))
    .then(() => { const i = _pendingUpserts.indexOf(entry); if (i >= 0) _pendingUpserts.splice(i, 1) })
    .catch(err => console.error('[todo] persist failed (queued for quit-flush retry):', err))
  hookQuitFlush()
}
function hookQuitFlush () {
  if (_todoFlushHooked || !window.todoAPI || !window.todoAPI.onAppQuittingFlush) return
  _todoFlushHooked = true
  window.todoAPI.onAppQuittingFlush(() => {
    const list = _pendingUpserts.splice(0, _pendingUpserts.length)
    for (const it of list) {
      Promise.resolve(window.todoAPI.dbCall(it.op, it.params))
        .catch(e => console.error('[todo] pending upsert flush failed at quit:', e))
    }
  })
}

function daysRangeTs (settings) {
  // "today/yesterday" are semantic options and can't be resolved by extracting digits (would NaN-fallback to 7): today = current day only (1), yesterday = from yesterday (2)
  const num = s => rangeDays(s, 7)
  return {
    expCompletedDays: num(settings.expiredCompletedTodoRange || '7d'),
    expUncompletedDays: num(settings.expiredUncompletedTodoRange || '30d'),
    upcomingDays: num(settings.upcomingTodoRange || '30d')
  }
}

const HISTORY_LIMIT = 50 // undo stack cap (entries)
const HISTORY_BYTES = 24 * 1024 * 1024 // undo stack byte-budget hard cap: one snapshot ~1MB with a thousand tasks; 50 entries once sat resident ~50MB unbounded

// Fields affecting a view's group membership (one-to-one with computeViews' grouping criteria):
// delete/deletedAt (active/recycle bin), todoTime/dayStart (date grouping), complete/completedAt (completed grouping), categoryId (todo-box category filter)
// Only writes to these fields need an immediate full view rebuild; the rest (title/description/subtask plain-text edits) take the lightweight path
const VIEW_AFFECTING_FIELDS = ['delete', 'deletedAt', 'todoTime', 'dayStart', 'complete', 'completedAt', 'categoryId']
const VIEWS_DEBOUNCE_MS = 600 // View-rebuild debounce for plain-text edits: staggered from EditPanel's 350ms save cadence; continuous typing recomputes only once

export default {
  namespaced: true,
  state: () => ({
    loaded: false,
    search: '',
    todoList: [],            // all active tasks (deleted=0)
    recycleList: [],         // recycle bin (deleted=1)
    version: 1,              // local push counter
    todosVersion: 0,         // synced cursor (meta)
    remoteVersion: 0,
    todayTimestamp: Date.now(),
    ignoreReminder: 0,
    recentlyAddedTaskId: '',
    lastCreatedTodoTaskId: '',
    // Undo/redo (Ctrl+Z / Ctrl+Y): whole-table snapshots taken before mutation-type actions, valid per session, not persisted
    undoStack: [],
    redoStack: [],
    _histLastPushAt: 0,
    // Timestamp of the last local write: for todosChanged broadcast echoes (our own write broadcast back to us), skip full re-reads based on it, without clearing the undo stack
    _lastLocalWriteAt: 0,
    viewsDirty: true, // tasks changed, views pending recompute (the day-rollover timer decides recomputes based on this)
    views: DEFAULT_VIEWS(),
    isSyncing: false,
    holidayList: []          // statutory holiday cache (empty offline)
  }),
  getters: {
    todayTodoList: s => s.views.todayTodoList,
    yesterdayTodoList: s => s.views.yesterdayTodoList
  },
  mutations: {
    setLoaded: (s, v) => { s.loaded = v },
    setSearch: (s, v) => { s.search = v },
    setAllRows (s, rows) {
      s.todoList = rows.filter(r => !r.delete)
      s.recycleList = rows.filter(r => r.delete)
    },
    upsertLocal (s, todo) {
      s.viewsDirty = true
      const list = todo.delete ? s.recycleList : s.todoList
      const i = list.findIndex(t => t.taskId === todo.taskId)
      if (i >= 0) Object.assign(list[i], todo)
      else list.push(todo)
      // Moving into / restoring from the recycle bin: remove the same-id record on the other side to avoid duplicates
      const other = todo.delete ? s.todoList : s.recycleList
      const j = other.findIndex(t => t.taskId === todo.taskId)
      if (j >= 0) other.splice(j, 1)
    },
    removeLocal (s, taskId) {
      const i = s.todoList.findIndex(t => t.taskId === taskId)
      if (i >= 0) s.todoList.splice(i, 1)
      else {
        const j = s.recycleList.findIndex(t => t.taskId === taskId)
        if (j >= 0) s.recycleList.splice(j, 1)
      }
    },
    hardRemove: (s, ids) => { s.viewsDirty = true; s.recycleList = s.recycleList.filter(t => !ids.includes(t.taskId)) },


/* ---------- Undo/redo (snapshots pushed by index.js's subscribeAction before mutation-type actions) ---------- */
    /* Snapshot = JSON string: stringify once on the push side, parse only at undo time; byte budget hard-caps stack memory (with a thousand tasks, 50 full snapshots once sat ~50MB unbounded) */
    historyPush (s, snapRaw) {
      // Chained changes within 400ms (EditPanel 350ms debounced saves, batch loops) merge into the stack top
      const now = Date.now()
      if (now - (s._histLastPushAt || 0) < 400 && s.undoStack.length) {
        const top = s.undoStack.length - 1
        s._histBytes = Math.max(0, (s._histBytes || 0) + snapRaw.length - s.undoStack[top].length)
        s.undoStack[top] = snapRaw
        s._histLastPushAt = now
        s.redoStack = []
        s._histRedoBytes = 0
        return
      }
      s._histLastPushAt = now
      s.undoStack.push(snapRaw)
      s._histBytes = (s._histBytes || 0) + snapRaw.length
      // Dual limits: entry cap (old) + byte budget; evicted from the oldest end
      while (s.undoStack.length > 1 && (s.undoStack.length > HISTORY_LIMIT || s._histBytes > HISTORY_BYTES)) {
        s._histBytes -= s.undoStack[0].length
        s.undoStack.shift()
      }
      s.redoStack = []
      s._histRedoBytes = 0
    },
    // redo()'s post-restore push: same eviction budget as historyPush but keeps the remaining redo
    // entries alive (historyPush resets redoStack, which used to kill every redo step after the first),
    // and breaks the merge window so a following edit starts a fresh undo step instead of fusing
    historyPushKeepRedo (s, snapRaw) {
      s._histLastPushAt = 0
      s.undoStack.push(snapRaw)
      s._histBytes = (s._histBytes || 0) + snapRaw.length
      while (s.undoStack.length > 1 && (s.undoStack.length > HISTORY_LIMIT || s._histBytes > HISTORY_BYTES)) {
        s._histBytes -= s.undoStack[0].length
        s.undoStack.shift()
      }
    },
    historyRestore (s, snap) {
      s.todoList = snap.todoList
      s.recycleList = snap.recycleList
    },
    historyClear (s) { s.undoStack = []; s.redoStack = []; s._histLastPushAt = 0; s._histBytes = 0; s._histRedoBytes = 0 },
    // Break the 400ms chained merge: discrete ops (add/delete/purge) call this so the next push starts a fresh undo step,
    // keeping those ops undoable on their own instead of fusing into a following EditPanel edit
    historyBreakMerge (s) { s._histLastPushAt = 0 },
    historyUndoPop (s) {
      const popped = s.undoStack.pop()
      if (popped) s._histBytes = Math.max(0, (s._histBytes || 0) - popped.length)
    },
    historyRedoPop (s) { s.redoStack.pop() },
    historyRedoPush (s, snap) {
      s.redoStack.push(snap)
      if (s.redoStack.length > HISTORY_LIMIT) s.redoStack.shift()
    },
    viewsClean (s) { s.viewsDirty = false },
    setSyncing (s, v) { s.isSyncing = v },
    setViews (s, views) { s.views = views },
    setTodayTs (s, ts) { s.todayTimestamp = +dayjs(ts || Date.now()).startOf('day') },
    setMeta (s, { todosVersion }) { if (todosVersion != null) { s.todosVersion = todosVersion; s.version = Math.max(s.version, todosVersion + 1) } },
    setRecentlyAdded: (s, id) => { s.recentlyAddedTaskId = id; s.lastCreatedTodoTaskId = id },
    setHolidayList: (s, l) => { s.holidayList = l || [] },
    bumpVersion (s) { s.version++ }
  },
  actions: {
    /* ---------- Initialization: load from SQLite ---------- */
    async init ({ commit, dispatch }) {
      // After data reload, old snapshots no longer match the current rows; void the undo/redo stacks
      commit('historyClear')
      let rows
      try {
        rows = await window.todoAPI.dbCall('getAll', {})
      } catch (err) { reportError('init:getAll', err); rows = [] }
      commit('setAllRows', rows)
      let v = 0
      try { v = parseInt(await window.todoAPI.dbCall('getMeta', 'todosVersion') || '0', 10) } catch (err) { reportError('init:getMeta', err) }
      commit('setMeta', { todosVersion: v })
      await dispatch('computeViews')
      commit('setLoaded', true)
      dispatch('writeCriticalBackup')
    },

    /** Add a task (field naming matches the reference addTodo) */
    async addTodo ({ state, rootState, commit, dispatch }, payload) {
      const {
        categoryId = rootState.settings.newTodoCategoryId || 0,
        todoContent,
        todoDescription = '',
        todoDate = 0,
        // Specific time of day (passed when creating from a time-block hour cell); falls back to the day of todoDate when absent
        todoTime = 0,
        todoReminderTime = 0,
        todoReminderOffsets = null,
        todoReminderExtra = null,
        todoDifficultyLevel = 0,
        repeatId = null,
        todoSublist = null,
        todoImage = null,
        fileList = null,
        addToTop = true,
        estimate = 0,
        dayOverride = null,
        predecessors = null
      } = payload
      // Discrete op: break the 400ms undo merge so following edits don't fuse into the add step
      commit('historyBreakMerge')
      const now = Date.now()
      // Renewal instance idempotency: skip when the same rid + same dayStart already exists (prevents concurrent multi-window + CLI double-triggering creating two renewals at the same moment)
      if (repeatId) {
        const targetDay = dayOverride != null ? dayOverride : (todoDate ? +dayjs(todoDate).startOf('day') : 0)
        if (targetDay) {
          try {
            const existing = await window.todoAPI.dbCall('queryTodos', { deleted: 0, repeatId, dayStartFrom: targetDay, dayStartTo: targetDay })
            if (Array.isArray(existing) && existing.length) {
              return existing[0] // return the existing renewal instance, transparent to the caller
            }
          } catch (e) { /* a DB error doesn't block renewal; let addTodo continue its main flow */ }
        }
      }
      const sameDay = state.todoList.filter(t =>
        !t.delete && t.dayStart && dayjs(t.dayStart).isSame(dayjs(todoDate).startOf('day'), 'ms'))
      let sort
      if (sameDay.length) {
        const mins = sameDay.map(t => t.taskSort)
        sort = nextSort(addToTop, Math.min(...mins), Math.max(...mins))
      } else if (!todoDate) {
        // No-date tasks (todo box): previously a constant 1024, making addToTop ineffective; take min/max within the same pool
        const pool = state.todoList.filter(t => !t.delete && !t.dayStart).map(t => t.taskSort)
        sort = pool.length ? nextSort(addToTop, Math.min(...pool), Math.max(...pool)) : nextSort(addToTop, 0, 0)
      } else sort = nextSort(addToTop, 0, 0)
      const userId = rootState.auth.user.userId
      const t = {
        complete: false, createTime: now, delete: false,
        reminderTime: todoReminderTime, reminderOffsets: Array.isArray(todoReminderOffsets) ? todoReminderOffsets : [], reminderExtra: Array.isArray(todoReminderExtra) ? todoReminderExtra : [], estimate, difficulty: todoDifficultyLevel,
        repeatId, subtasks: todoSublist ? JSON.stringify(todoSublist) : null,
        predecessors: Array.isArray(predecessors) && predecessors.length ? JSON.stringify(predecessors) : null,
        image: todoImage, files: fileList,
        categoryId, updateTime: now, syncTime: 0,
        taskContent: String(todoContent || '').trim(),
        taskDescribe: todoDescription || '',
        taskId: genTaskId(userId), taskSort: Math.fround(sort),
        todoTime: Number(todoTime) || Number(todoDate) || 0,
        userId, status: 'add', version: 0,
        dayStart: dayOverride != null ? dayOverride : (todoDate ? +dayjs(todoDate).startOf('day') : 0)
      }
      commit('upsertLocal', t)
      commit('setRecentlyAdded', t.taskId)
      safeUpsert(t)
      dispatch('scheduleReminder', t)
      dispatch('computeViews')
      dispatch('writeCriticalBackup')
      return t
    },

    async updateTodoFields ({ state, commit, dispatch }, { taskId, patch }) {
      const unlocked = patch._unlocked; if (unlocked) delete patch._unlocked // advisory payload, never persisted
      const deferViews = patch._deferViews; if (deferViews) delete patch._deferViews // advisory: caller batches the view rebuild (bulk reschedule/migration)
      if (patch.predecessors !== undefined) {
        // write-time cycle guard (dependencies are devMode-gated): a dep set that closes a loop is rejected outright
        const next = Array.isArray(patch.predecessors)
          ? patch.predecessors.filter(pid => pid && pid !== taskId)
          : (() => { try { return parsePredecessors(patch.predecessors) } catch { return [] } })()
        if (wouldCycle(state.todoList, taskId, next)) throw new Error('dependency-cycle')
        patch.predecessors = next.length ? JSON.stringify(next) : null
      }
      const all = [...state.todoList, ...state.recycleList]
      const i = all.findIndex(t => t.taskId === taskId)
      if (i < 0) return
      const prevDayStart = all[i].dayStart // capture BEFORE upsertLocal mutates the row in place: the chip-sync job runs in a microtask and must migrate from the day the task is leaving
      const merged = { ...all[i], ...patch, updateTime: Date.now(), status: 'update' }
      delete merged.deleting
      // When the due date changes, sync the derived field dayStart, consistent with the main process's persistence logic (db.js:124);
      // otherwise the task stays in the old group in memory until restart
      if (patch.todoTime !== undefined) merged.dayStart = merged.todoTime ? +dayjs(merged.todoTime).startOf('day') : 0
      commit('upsertLocal', merged)
      safeUpsert(merged)
      dispatch('scheduleReminder', merged)
      // Group-membership fields (complete/delete/date/category) rebuild views immediately — list membership changed, so it must change at once;
      // plain-text/metadata edits take the lightweight path: the row object is already reactively updated, so the component itself refreshes the UI in place;
      // the full computeViews (O(n) rebuild of 8 groups + purgeExpiredRecycle) is debounced/merged,
      // otherwise every 350ms-debounced title save in EditPanel would trigger the whole chain, making typing a full recompute at thousand-task scale
      if (!deferViews && VIEW_AFFECTING_FIELDS.some(f => patch[f] !== undefined)) {
        clearTimeout(this._viewsDebounceTimer)
        dispatch('computeViews')
      } else {
        clearTimeout(this._viewsDebounceTimer)
        this._viewsDebounceTimer = setTimeout(() => { dispatch('computeViews') }, VIEWS_DEBOUNCE_MS)
      }
      // Schedule chips follow (after the storage-layer root fix, via db row ops, broadcast-driven full-end sync): reschedule → migrate; remove date/delete → clear.
      // Placed after commit, based on merged (new state); serialized per taskId to prevent migration disorder from EditPanel's 350ms debounced bursts
      if (patch.todoTime !== undefined || patch.delete === true) {
        const taskId = all[i].taskId
        const prev = _chipSyncChain.get(taskId) || Promise.resolve()
        const job = prev.catch(() => {}).then(async () => {
          try {
            const toDay = patch.delete === true ? null : (merged.dayStart ? dayjs(merged.dayStart).format('YYYY-MM-DD') : null)
            if (toDay === null) { await snapshotForDelete(taskId); await clearTaskChips(taskId); return }
            const fromDay = prevDayStart ? dayjs(prevDayStart).format('YYYY-MM-DD') : null
            await moveTaskChips(taskId, fromDay, toDay)
          } catch (e) { console.warn('[todo] schedule chip sync failed (task updated, chip will converge on next op):', e) }
        })
        _chipSyncChain.set(taskId, job)
        if (_chipSyncChain.size > 64) { for (const k of _chipSyncChain.keys()) { if (k !== taskId) _chipSyncChain.delete(k) } }
      }
      dispatch('writeCriticalBackup')
      return unlocked ? Object.assign({}, merged, { _unlocked: unlocked }) : merged
    },

    async toggleComplete ({ state, dispatch, rootState }, todo) {
      const target = !todo.complete
      const patch = { complete: target, completedAt: target ? Date.now() : 0 }
      if (target) {
        // dependency linkage: completing this task may unlock dependents — attach their names so the completion toast can mention it
        try {
          const newlyReady = state.todoList.filter(t => !t.delete && !t.complete &&
            parsePredecessors(t.predecessors).includes(todo.taskId) &&
            isTaskReady(state.todoList.map(x => x.taskId === t.taskId ? { ...x } : x), t))
          if (newlyReady.length) patch._unlocked = newlyReady.map(t => t.taskContent || t.taskId)
        } catch { /* dep info is advisory; never block completion */ }
      }
      if (target && root_getCompleteWithSub(rootState)) {
        // Checking the main task complete also checks all subtasks (controlled by the isCompleteWithSubtasks setting)
        try {
          const subs = JSON.parse(todo.subtasks || '[]')
          if (Array.isArray(subs) && subs.length && subs.some(s => !s.checked)) {
            patch.subtasks = JSON.stringify(subs.map(s => ({ ...s, checked: true })))
          }
        } catch { /* skip the cascade when subtask JSON is malformed */ }
      }
      if (!target && root_getCompleteWithSub(rootState)) {
        // Un-checking the main task also unchecks all subtasks (symmetric with the complete cascade above, same setting gate);
        // without this, subsCompleteTarget in core.js would instantly re-complete a manually un-completed parent whose subs are all checked
        try {
          const subs = JSON.parse(todo.subtasks || '[]')
          if (Array.isArray(subs) && subs.length && subs.some(s => s.checked)) {
            patch.subtasks = JSON.stringify(subs.map(s => ({ ...s, checked: false })))
          }
        } catch { /* skip the cascade when subtask JSON is malformed */ }
      }
      if (target && todo.repeatId) dispatch('ensureNextRepeatInstance', { ...todo, complete: true })
      return dispatch('updateTodoFields', { taskId: todo.taskId, patch })
    },

    /** Repeat-group renewal: when the last incomplete instance in a group is completed, generate the next instance per the group rule */
    async ensureNextRepeatInstance ({ dispatch }, completedTodo) {
      const rid = completedTodo.repeatId
      if (!rid) return
      if (!completedTodo.dayStart) return // no-date instances don't renew after completion (otherwise pseudo-instances expand from 1970; same guard as the core single source)
      const group = this.state.todo.todoList.filter(t => t.repeatId === rid && !t.delete && t.dayStart > 0)
      const lastDay = Math.max(...group.map(t => t.dayStart || 0))
      // Only renew when the completed one is the group's last (latest) instance; leave it alone if future instances remain
      if ((completedTodo.dayStart || 0) < lastDay) return
      // The rule's single source of truth is meta (same source as the CLI); the historical LS fallback has been dismantled (all hosts have the meta channel)
      let rule = null
      try { rule = JSON.parse(await window.todoAPI.dbCall('getMeta', 'repeatRule:' + rid) || 'null') } catch { /* empty */ }
      if (!rule) return
      const dates = expandRepeatDates(lastDay || completedTodo.todoTime, rule, this.state.todo.holidayList || [])
      const next = dates.map(d => +d).find(ts => ts > (completedTodo.dayStart || 0))
      if (!next) return
      const t = completedTodo
      let remind = 0
      if (t.reminderTime > 0 && t.dayStart) {
        const r = dayjs(t.reminderTime)
        remind = dayjs(next).hour(r.hour()).minute(r.minute()).second(0).valueOf()
      }
      await dispatch('addTodo', {
        categoryId: t.categoryId,
        todoContent: t.taskContent,
        todoDescription: t.taskDescribe || '',
        todoDate: next,
        todoReminderTime: remind,
        todoReminderOffsets: Array.isArray(t.reminderOffsets) ? t.reminderOffsets : [],
        todoReminderExtra: Array.isArray(t.reminderExtra) ? t.reminderExtra : [],
        todoDifficultyLevel: t.difficulty || 0,
        repeatId: rid,
        todoSublist: t.subtasks ? (function(){try{return JSON.parse(t.subtasks)}catch{return[]}})().map(x => ({ ...x, checked: false })) : null,
        addToTop: false
      })
    },
    async reorderTodos ({ commit, dispatch }, updates) {
      const now = Date.now()
      // Look up within a single table-building loop: previously each update copied the whole table + findIndex; batch-sorting a thousand entries was O(n·u) ≈ millions of comparisons, janking one frame
      const index = new Map([...this.state.todo.todoList, ...this.state.todo.recycleList].map(t => [t.taskId, t]))
      const rows = []
      for (const u of updates) {
        const raw = index.get(u.taskId)
        if (!raw) continue
        const merged = { ...raw, taskSort: u.taskSort, updateTime: now, status: 'update' }
        commit('upsertLocal', merged)
        rows.push(merged)
      }
      if (!rows.length) return
      try { await window.todoAPI.dbCall('upsertMany', rows) } catch (err) { reportError('upsertMany', err) }
      dispatch('computeViews')
      dispatch('writeCriticalBackup')
    },

    /** Move into the recycle bin (soft delete) */
    async deleteTodo ({ commit, dispatch, rootState }, todo) {
      // Discrete op: break the 400ms undo merge so following edits don't fuse into the delete step
      commit('historyBreakMerge')
      const all = [...this.state.todo.todoList, ...this.state.todo.recycleList]
      const raw = all.find(t => t.taskId === todo.taskId)
      if (!raw) return
      // The deleted task is bound by tomato focus: detach first, otherwise after focus completes the record is booked to a taskId in the recycle bin
      if (rootState.tomato && rootState.tomato.attachTodo && rootState.tomato.attachTodo.taskId === todo.taskId) {
        dispatch('tomato/attach', null, { root: true })
      }
      const merged = { ...raw, delete: true, deleting: true, deletedAt: Date.now(), updateTime: Date.now(), status: 'delete' }
      commit('upsertLocal', merged)
      // Cleanup of related attachments is left to manual action (on permanent deletion from the recycle bin)
      // deleting is a local-dialect UI flag, not a schema column: strip it before persisting, otherwise the dirty field spreads forever via undo snapshots/sync
      const row = { ...merged }; delete row.deleting
      safeUpsert(row)
      // Schedule chip cascade: snapshot to meta first (written back when the task is restored), then clear rows (2026-09-03 P0 review: the original soft-delete path bypassed chip cleanup)
      try { await snapshotForDelete(todo.taskId) } catch (e) { console.warn('[todo] failed to snapshot chips for deleted task:', e) }
      dispatch('computeViews')
      dispatch('writeCriticalBackup')
    },

    async restoreFromRecycle ({ commit, dispatch }, todo) {
      // Write back the pre-delete schedule chip snapshot when restoring (eliminates the "delete→restore loses schedule" regression)
      try { await restoreSnapshot(todo.taskId) } catch { /* No snapshot = originally unscheduled */ }
      return dispatch('updateTodoFields', { taskId: todo.taskId, patch: { delete: false, deletedAt: 0, status: 'update' } })
    },

    async purgeIds ({ commit, dispatch, rootState }, ids) {
      // Discrete op: break the 400ms undo merge so following edits don't fuse into the purge step
      commit('historyBreakMerge')
      if (ids.length) await dispatch('writeEventBackup', 'purge') // snapshot before permanent deletion
      // Permanently deleted tasks still bound by focus: detach (same as deleteTodo)
      const at = rootState.tomato && rootState.tomato.attachTodo
      if (at && ids.includes(at.taskId)) dispatch('tomato/attach', null, { root: true })
      // Delete per id and remove locally only the successful ones: Promise.all swallowing errors then hardRemove-ing the whole batch once let failed ids "revive" back into the recycle bin after restart
      const done = []
      for (const id of ids) {
        try { await window.todoAPI.dbCall('hardDelete', id); done.push(id); clearSnapshot(id) } catch (err) { reportError('hardDelete', err) }
      }
      try { for (const id of done) await window.todoAPI.deleteTodoFilesRelevant?.(id) } catch {}
      if (done.length) commit('hardRemove', done)
      dispatch('computeViews')
      dispatch('writeCriticalBackup')
    },
    async purgeAllRecycle ({ commit, dispatch, state }) {
      const ids = state.recycleList.map(t => t.taskId)
      if (!ids.length) return
      // Discrete op: break the 400ms undo merge so following edits don't fuse into the purge step
      commit('historyBreakMerge')
      await dispatch('writeEventBackup', 'purge-all') // snapshot before emptying the recycle bin
      // DB rows first, then attachment files: the other order leaves rows pointing at deleted files if the file purge fails
      try { await window.todoAPI.purgeRecycleBin() } catch (err) { reportError('purgeRecycleBin', err) }
      // Attachment cleanup aligned with per-item permanent deletion (the main process's purgeRecycleBin only deletes rows, not files/)
      try { for (const id of ids) await window.todoAPI.deleteTodoFilesRelevant?.(id) } catch {}
      // Drop the pre-delete chip snapshot meta too (rows are gone, the snapshot can never be restored)
      for (const id of ids) clearSnapshot(id)
      commit('hardRemove', ids)
      dispatch('computeViews')
      dispatch('writeCriticalBackup')
    },
    /** Recycle bin auto-expiry purge: deleted rows past N days by deletion time (updateTime) are permanently deleted (N=0 never).
        Clock sanity check: when the system clock jumps back/forward more than 48h (BIOS battery loss, manual change), skip this round of auto purge,
        preventing the accident of "clock set to the future → startup hard-deletes the whole recycle bin" (finalized in the 2026-08-29 release review). */
    async purgeExpiredRecycle ({ state, rootState, dispatch }) {
      const days = rootState.settings.recycleBinAutoDeleteDays
      if (!days) return
      const now = Date.now()
      let lastPurgeAt = 0
      try { lastPurgeAt = parseInt(localStorage.getItem('recycleLastPurgeAt') || '0', 10) || 0 } catch { /* no record */ }
      // Only guards against "the clock being set into the past" (rolling back shrinks cutoff which is tolerable, but the real risk is a forward jump mass-hard-deleting:
      // now < lastPurgeAt means the clock was rolled back, skip this round); long forward gaps (days away without opening the app) are normal, not blocked
      if (lastPurgeAt && now < lastPurgeAt - 60000) {
        console.warn('[todo] system clock rollback detected, skipping trash auto-purge this round')
        return
      }
      try { localStorage.setItem('recycleLastPurgeAt', String(now)) } catch { /* ignore */ }
      // Calendar-day basis: roll back N days from today at midnight, avoiding boundary drift from "deleted at an arbitrary moment"
      const cutoff = +dayjs().startOf('day').subtract(days, 'day')
      const ids = state.recycleList.filter(t => (t.deletedAt || t.updateTime || 0) < cutoff).map(t => t.taskId)
      if (ids.length) await dispatch('purgeIds', ids)
    },

    /* ---------- Undo/redo ---------- */
    async undo ({ state, commit, dispatch }) {
      if (!state.undoStack.length) return false
      const prevRaw = state.undoStack[state.undoStack.length - 1]
      commit('historyUndoPop')
      const cur = { todoList: state.todoList, recycleList: state.recycleList }
      commit('historyRedoPush', JSON.stringify(cur)) // stringify once here only, on the push side
      const prev = JSON.parse(prevRaw)
      commit('historyRestore', prev)
      const changedRows = (await dispatch('persistSnapshotDiff', { from: cur, to: prev })) || []
      dispatch('computeViews')
      dispatch('writeCriticalBackup')
      // label reuses the diff result; no more two rounds of full stringify over both snapshots
      return { ok: true, label: changedRows.length === 1 ? (changedRows[0].taskContent || '') : '' }
    },
    async redo ({ state, commit, dispatch }) {
      if (!state.redoStack.length) return false
      const nextRaw = state.redoStack[state.redoStack.length - 1]
      commit('historyRedoPop')
      const cur = { todoList: state.todoList, recycleList: state.recycleList }
      commit('historyPushKeepRedo', JSON.stringify(cur))
      const next = JSON.parse(nextRaw)
      commit('historyRestore', next)
      const changedRows = (await dispatch('persistSnapshotDiff', { from: cur, to: next })) || []
      dispatch('computeViews')
      dispatch('writeCriticalBackup')
      return { ok: true, label: changedRows.length === 1 ? (changedRows[0].taskContent || '') : '' }
    },
    /** Persist the diff after a snapshot switch: rows present in "after" but missing/different in "before" are upserted;
        rows present in "before" but missing in "after" (undoing a "create") are soft-deleted, guaranteeing they can be restored again.
        Returns the changed-rows list (reused for the undo toast's label). Row-change detection uses the updateTime invariant (all writes bump it uniformly via updateTodoFields/reorder/delete). */
    async persistSnapshotDiff ({ commit }, { from, to }) {
      const fromMap = new Map(from.todoList.concat(from.recycleList).map(t => [t.taskId, t]))
      const toRows = to.todoList.concat(to.recycleList)
      const toIds = new Set(toRows.map(t => t.taskId))
      const changedRows = []
      for (const row of toRows) {
        const before = fromMap.get(row.taskId)
        if (!before || before.updateTime !== row.updateTime) {
          commit('upsertLocal', row)
          safeUpsert({ ...row, status: 'update' })
          changedRows.push(row)
        }
      }
      for (const row of from.todoList.concat(from.recycleList)) {
        if (!toIds.has(row.taskId)) {
          const merged = { ...row, delete: true, updateTime: Date.now(), status: 'delete' }
          commit('upsertLocal', merged)
          safeUpsert(merged)
          changedRows.push(merged)
        }
      }
      return changedRows
    },

    scheduleReminder (_, todo) {/* the main process rebuilds the schedule automatically after dbCall */},

    /* ---------- View computation (grouping semantics follow common practice) ---------- */
    async computeViews ({ commit, rootState, dispatch }) {
      // After crossing midnight, keep the global todayTimestamp consistent with the grouping basis (main.js dirt-checks every 60s)
      commit('setTodayTs', Date.now())
      dispatch('purgeExpiredRecycle')
      const settings = rootState.settings
      const { expCompletedDays, expUncompletedDays, upcomingDays } = daysRangeTs(settings)
      const today = dayjs().startOf('day').valueOf()
      const live = this.state.todo.todoList.filter(t => !t.delete)

      const recentExpiredCompleted = []
      const recentExpiredUncompleted = []
      const todayList = []
      const tomorrowList = []
      const after2List = []
      const upcomingList = []
      const noDateList = []
      const todayDoneList = []

      live.forEach(t => {
        const ds = t.dayStart
        if (!ds) {
          // Completed no-date tasks go into "today completed" (otherwise completing one makes it vanish from the today page with no way to un-complete in place)
          if (t.complete) {
            const ct = t.completedAt || t.updateTime || 0
            if (ct >= today && ct < +dayjs(today).add(1, 'day')) todayDoneList.push(t)
            else noDateList.push(t)
          } else {
            noDateList.push(t)
          }
          return
        }
        if (t.complete) {
          // "Today completed" groups by completion time (completedAt, falling back to updateTime), not the original due date:
          // a task due yesterday but completed today belongs in today completed (where it can be un-completed), not vanished into history
          const ct = t.completedAt || t.updateTime || 0
          if (ct >= today && ct < +dayjs(today).add(1, 'day')) todayDoneList.push(t)
          return
        }
        const diff = Math.round((ds - today) / DAY_MS)
        if (diff < 0) {
          if (-diff <= expUncompletedDays) recentExpiredUncompleted.push(t)
        } else if (diff === 0) todayList.push(t)
        else if (diff === 1) tomorrowList.push(t)
        else if (diff === 2) after2List.push(t)
        else if (diff <= upcomingDays) upcomingList.push(t)
      })

      // Expired completed: overdue tasks completed within the last N days (counted by completion time completedAt)
      const completedCutoff = +dayjs(today).subtract(expCompletedDays, 'day')
      live.forEach(t => {
        const doneTs = t.completedAt || t.updateTime || 0
        if (t.complete && t.dayStart && t.dayStart < today && doneTs >= completedCutoff) {
          recentExpiredCompleted.push(t)
        }
      })

      const completedList = live.filter(t => t.complete)
        .sort((a, b) => (b.completedAt || b.updateTime) - (a.completedAt || a.updateTime))

      // Todo box: no-date incomplete
      let box = noDateList.filter(t => !t.complete)
      if (settings.todoBoxCategoryId !== -1) box = box.filter(t => t.categoryId === settings.todoBoxCategoryId)
      const dir = settings.todoBoxSortOrder === 'asc' ? 1 : -1
      box.sort((a, b) => {
        switch (settings.todoBoxSortMethod) {
          case 'due': return ((a.todoTime || a.createTime) - (b.todoTime || b.createTime)) * dir
          case 'difficulty': return (getEstimate(a.taskId) - getEstimate(b.taskId)) * dir // Difficulty retired: by estimated workload = estimated tomatoes
          default: return (a.createTime - b.createTime) * dir
        }
      })

      // Sort mode: stable-key normalization + comparator extracted to utils/sortMode.js (pure function, unit-testable)
      const applySort = arr => sortByMode(arr, settings.sortMode)

      // Yesterday's unfinished (day-rollover leftovers)
      const yesterday = live.filter(t => !t.complete && t.dayStart === +dayjs(today).subtract(1, 'day'))

      commit('setViews', {
        recent: {
          expiredCompleted: recentExpiredCompleted.sort((a, b) => a.dayStart - b.dayStart),
          expiredUncompleted: recentExpiredUncompleted.sort((a, b) => a.dayStart - b.dayStart),
          today: applySort(todayList),
          tomorrow: tomorrowList,
          dayAfterTomorrow: after2List,
          upcoming: upcomingList,
          noDate: showNoDateFilter(noDateList.filter(t => !t.complete), settings)
        },

        todayTodoList: applySort(todayList),
        // Completed-group sort matches the grouping basis (completedAt first, avoiding sort misplacement when editing after completion)
        todayDoneList: todayDoneList.sort((a, b) => (b.completedAt || b.updateTime) - (a.completedAt || a.updateTime)),
        yesterdayTodoList: yesterday,
        calendar: buildCalendarList(live),
        todoBox: box,
        todoBoxCount: box.length, // Same source as box above (category filter/sort share one chain); previously computed independently here too — fixing one but not the other made the number and list disagree
        completed: completedList,
        recycleBin: [...this.state.todo.recycleList].sort((a, b) => (b.deletedAt || b.updateTime) - (a.deletedAt || a.updateTime))
      })
      commit('viewsClean')
    },

    /** Trigger a "cloud sync" action — offline implementation: increment the local version and mark everything sync */
    async syncTodos ({ state, commit, dispatch }) {
      if (state.isSyncing) return
      commit('setSyncing', true)
      try {
        commit('bumpVersion')
        const serverV = state.version
        // Snapshot only dirty rows (status !== 'sync'); during the await, the user's new edits (status='update') aren't wrongly marked synced.
        // An already-synced whole table skips the wholesale upsertMany write entirely (Ctrl+S with no changes = no write)
        const snapshot = [...state.todoList, ...state.recycleList].filter(t => t.status !== 'sync')
        if (!snapshot.length) return
        const snapshotIds = new Set(snapshot.map(t => t.taskId))
        await window.todoAPI.dbCall('upsertMany', snapshot)
        await window.todoAPI.dbCall('setMeta', ['todosVersion', String(serverV)])
        // Only rows in the snapshot that weren't re-edited during the await are marked synced (can't do a wholesale markSyncedAll)
        ;[...state.todoList, ...state.recycleList]
          .filter(t => snapshotIds.has(t.taskId) && t.status !== 'update' && t.status !== 'delete')
          .forEach(t => { t.status = 'sync'; t.version = serverV })
      } catch (err) { reportError('syncTodos', err) } finally { commit('setSyncing', false) }
      // Stay quiet on sync success (per common practice, auto sync doesn't disturb the user); the version number is an implementation detail and goes into no copy
      dispatch('writeCriticalBackup')
    },

    /** Event snapshot before dangerous operations: reason such as purge/import/restore, filename evt-<reason>-*.json */
    async writeEventBackup ({ state, rootState }, reason) {
      try {
        if (!window.todoAPI || !window.todoAPI.runAutoBackup) return false
        const dump = buildBackupDump(rootState, state)
        await window.todoAPI.runAutoBackup(JSON.stringify(dump), { tag: String(reason || 'op').toLowerCase(), eventKeep: 10, backupDir: rootState.settings.backupDir || '' })
      } catch (e) { console.error('[event-backup] failed:', e && e.message) }
    },
    /** Auto backup: same structure as critical-state, written to userData/backups/auto-*.json with rolling cleanup */
    async writeAutoBackup ({ state, rootState }) {
      try {
        if (!window.todoAPI || !window.todoAPI.runAutoBackup) return
        const dump = buildBackupDump(rootState, state, { stripVolatileSettings: true })
        const r = await window.todoAPI.runAutoBackup(JSON.stringify(dump), { recent: rootState.settings.autoBackupKeep || 24, backupDir: rootState.settings.backupDir || '' })
        if (r && r.ok) saveRuntime({ autoBackupLastAt: Date.now() })
        else saveRuntime({ autoBackupLastAt: 0 }) // retry next time on failure
        return !!r && !!(r.ok)
      } catch (e) { console.error('[auto-backup] failed:', e && e.message) }
    },
    async writeCriticalBackup ({ state, rootState }) {
      const buildDump = () => buildBackupDump(rootState, state)
      const writeNow = () => { try { window.todoAPI.writeCriticalStateBackup(JSON.stringify(buildDump())) } catch {} }
      // Quit flush: main process before-quit broadcast; pending debounced snapshots flush to disk immediately (state/rootState are live references, so flush reads the latest values)
      if (!this._flushHooked && window.todoAPI && window.todoAPI.onAppQuittingFlush) {
        this._flushHooked = true
        window.todoAPI.onAppQuittingFlush(() => { if (this._cbTimer) { clearTimeout(this._cbTimer); this._cbTimer = null; writeNow() } })
      }
      // Debounced backup: structure matches the reference critical-state-backup.json
      clearTimeout(this._cbTimer)
      // 5s debounce: full stringify + IPC disk write is expensive with thousands of tasks; 800ms would fire on nearly every continuous edit
      this._cbTimer = setTimeout(writeNow, 800)
    }
  }
}

/* Single source for every backup dump (event/auto/critical). Previously hand-copied 3× and already drifting —
   a recovery dump missing a field means silently losing data on restore, so any new store goes here once. */
function buildBackupDump (rootState, state, { stripVolatileSettings = false } = {}) {
  const settings = { ...rootState.settings }
  if (stripVolatileSettings) { settings.autoBackupLastAt = 0; settings.tomatoRecordAddCount = 0; settings.tomatoRecordAddDate = 0 } // strip volatile timestamps so content dedupe stays effective
  return {
    backup: {
      settingsState: JSON.stringify(settings),
      user: JSON.stringify(rootState.auth.user),
      lastLoginRecord: JSON.stringify(rootState.auth.lastLoginRecord),
      todoState: JSON.stringify({
        schemaV: SCHEMA_V,
        search: state.search, todoList: state.todoList, recycleList: state.recycleList, version: state.version,
        remoteVersion: state.remoteVersion, todayTimestamp: state.todayTimestamp,
        ignoreReminder: state.ignoreReminder, todosVersion: state.todosVersion, isSyncing: false,
        views: {}
      }),
      tomatoState: localStorage.getItem('tomatoState') || '{}',
      // 账本行集随份走(blob 已被掏空,不含记录;恢复端按行表幂等回灌)——无它则 JSON 灾备恢复任务回而专注账全丢
      tomatoRecords: JSON.stringify(rootState.tomato && rootState.tomato.tomatoRecordList || []),
      categoryState: JSON.stringify({ schemaV: SCHEMA_V, list: rootState.category.list }),
      habitsState: JSON.stringify({ schemaV: SCHEMA_V, habits: rootState.habits.habits, moments: rootState.habits.moments, savedAt: rootState.habits.savedAt || 0 })
    }
  }
}

/* Small helper for reading root settings (module-internal access) */
function root_getCompleteWithSub (rootState) { return rootState && rootState.settings ? rootState.settings.isCompleteWithSubtasks !== false : true }

function showNoDateFilter (arr, settings) {
  return settings.showNoDate ? arr : []
}

/* Calendar view data: for the current month's span (±half a year), the daily set can render directly from raw todoList rows */
function buildCalendarList (live) { return live.slice() }
