/**
 * Core todo module — state/action semantics aligned with the reference todo module
 * status: add/update/delete -> sync; local meta.todosVersion acts as the sync cursor
 */
import { genTaskId, nextSort, dayjs, reportError, DAY_MS, rangeDays, parsePredecessors } from '../utils/core.js'
import { expandRepeatDates } from '../utils/repeat.js'
import { sortByMode } from '../utils/sortMode.js'
import { getEstimate } from '../utils/tomatoEstimate.js'
import { clearSnapshot } from '../utils/dayPlans.js'
// Cross-cutting concerns, physically split out of this module (pure relocation — the store's action
// semantics are unchanged; the actions/mutations below delegate to these extracted implementations):
import { enqueueChipSync, rowChipSync, planSnapshotRowSync, snapshotForDelete, restoreSnapshot } from './planChips.js'
import { historyPush, historyPushKeepRedo, historyClear, historyBreakMerge, historyUndoPop, historyRedoPop, historyRedoPush, undoStep, redoStep, persistSnapshotDiffCore } from './undo.js'
import { writeEventBackupCore, writeAutoBackupCore, writeCriticalBackupCore } from './todoBackup.js'

// planSnapshotRowSync stays a named export of this module (tests import it from here)
export { planSnapshotRowSync }


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
  window.todoAPI.onAppQuittingFlush(() => flushPendingUpserts())
}
/** Exit flush: send every pending upsert; a failed entry is put back at the queue head so the next write
 *  replays it (mirrors tomato.js flushPendingLedger — previously failures were only logged and silently lost) */
function flushPendingUpserts () {
  const list = _pendingUpserts.splice(0, _pendingUpserts.length)
  for (const it of list) {
    Promise.resolve(window.todoAPI.dbCall(it.op, it.params))
      .catch(e => {
        console.error('[todo] pending upsert flush failed at quit (requeued):', e)
        _pendingUpserts.unshift(it)
      })
  }
}
/** Strip Vue reactive proxies before IPC: rows come straight from reactive state, and a shallow spread
 *  ({ ...raw }) only unwraps the top level — nested arrays (reminderOffsets/reminderExtra/subtasks JSON is a
 *  string, but reminderOffsets etc. stay Proxies) still fail the structured clone inside invoke
 *  ("An object could not be cloned" = the whole upsertMany batch silently dropped, same root cause
 *  safeUpsert's JSON round-trip at :87-89 documents for single rows) */
function deproxyRows (rows) { return JSON.parse(JSON.stringify(rows)) }

function daysRangeTs (settings) {
  // "today/yesterday" are semantic options and can't be resolved by extracting digits (would NaN-fallback to 7): today = current day only (1), yesterday = from yesterday (2)
  const num = s => rangeDays(s, 7)
  return {
    expCompletedDays: num(settings.expiredCompletedTodoRange || '7d'),
    expUncompletedDays: num(settings.expiredUncompletedTodoRange || '30d'),
    upcomingDays: num(settings.upcomingTodoRange || '30d')
  }
}

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
/* History bookkeeping lives in undo.js (pure state-transform functions); these mutations are thin adapters. */
    historyPush (s, snapRaw) { historyPush(s, snapRaw) },
    historyPushKeepRedo (s, snapRaw) { historyPushKeepRedo(s, snapRaw) },
    historyRestore (s, snap) {
      s.todoList = snap.todoList
      s.recycleList = snap.recycleList
    },
    historyClear (s) { historyClear(s) },
    historyBreakMerge (s) { historyBreakMerge(s) },
    historyUndoPop (s) { historyUndoPop(s) },
    historyRedoPop (s) { historyRedoPop(s) },
    historyRedoPush (s, snap) { historyRedoPush(s, snap) },
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
        // dayStart derivation mirrors the DB rule (db.js re-derives unconditionally from todoTime): when only
        // todoTime is given (time-block cell without an explicit date), todoTime>0 while todoDate is missing —
        // deriving dayStart from todoDate alone split memory (dayStart=0 → todo box) from DB (scheduled day),
        // and the task switched groups after restart
        dayStart: dayOverride != null ? dayOverride : (todoDate ? +dayjs(todoDate).startOf('day') : (Number(todoTime) > 0 ? +dayjs(Number(todoTime)).startOf('day') : 0))
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
        enqueueChipSync(all[i].taskId, () => rowChipSync(all[i].taskId, prevDayStart, merged))
      }
      dispatch('writeCriticalBackup')
      return unlocked ? Object.assign({}, merged, { _unlocked: unlocked }) : merged
    },

    async toggleComplete ({ state, commit, dispatch, rootState }, todo) {
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
      const r = await dispatch('updateTodoFields', { taskId: todo.taskId, patch })
      // Discrete op: break the 400ms undo merge so a following edit doesn't fuse into the check step
      commit('historyBreakMerge')
      return r
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
      // Same pending-queue guarantee as safeUpsert: a transient IPC/db failure must not silently drop the
      // whole batch (the rows were already re-sorted in memory, so a lost write resurfaces as a wrong order
      // after restart). flushPendingUpserts replays any queued op verbatim, 'upsertMany' included.
      try {
        await window.todoAPI.dbCall('upsertMany', deproxyRows(rows))
      } catch (err) {
        reportError('upsertMany', err)
        try { _pendingUpserts.push({ op: 'upsertMany', params: deproxyRows(rows) }) } catch { /* keep the UI flow alive even if cloning fails */ }
        hookQuitFlush()
      }
      // Discrete op: break the 400ms undo merge so a following edit doesn't fuse into the drag step
      commit('historyBreakMerge')
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
      // Row first, snapshot second (verify-then-commit): restoreSnapshot empties the snapshot meta as a side
      // effect, so consuming it before the row update was confirmed meant a mid-way failure (row missing,
      // updateTodoFields throwing) left the snapshot permanently lost and/or a ghost chip on the timeline.
      // The row update alone is harmless to retry; only after it succeeds do we spend the one-shot snapshot.
      const r = await dispatch('updateTodoFields', { taskId: todo.taskId, patch: { delete: false, deletedAt: 0, status: 'update' } })
      if (r) {
        try { await restoreSnapshot(todo.taskId) } catch { /* No snapshot = originally unscheduled */ }
      }
      // Discrete op: break the 400ms undo merge so a following edit doesn't fuse into the restore step
      commit('historyBreakMerge')
      return r
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
      if (done.length) {
        commit('hardRemove', done)
        // Rows are physically gone (hardDelete + attachment files + chip snapshot meta): any later undo replaying a
        // pre-purge snapshot would safeUpsert the deleted rows straight back from the dead. Void history so undo
        // can never cross the purge generation.
        commit('historyClear')
      }
      dispatch('computeViews')
      dispatch('writeCriticalBackup')
    },
    async purgeAllRecycle ({ commit, dispatch, state }) {
      const ids = state.recycleList.map(t => t.taskId)
      if (!ids.length) return
      // Discrete op: break the 400ms undo merge so following edits don't fuse into the purge step
      commit('historyBreakMerge')
      await dispatch('writeEventBackup', 'purge-all') // snapshot before emptying the recycle bin
      // DB rows first, then attachment files: the other order leaves rows pointing at deleted files if the file purge fails.
      // Converge only on success (aligned with purgeIds' per-id guard): when the purge IPC fails we keep the local
      // rows untouched — the old flow hardRemoved locally + cleared the undo stack anyway, so the rows "revived"
      // back into the recycle bin after restart while the user had been told they were gone for good
      let purged = false
      try { purged = await window.todoAPI.purgeRecycleBin() === true } catch (err) { reportError('purgeRecycleBin', err) }
      if (!purged) { dispatch('computeViews'); return }
      // Attachment cleanup aligned with per-item permanent deletion (the main process's purgeRecycleBin only deletes rows, not files/)
      try { for (const id of ids) await window.todoAPI.deleteTodoFilesRelevant?.(id) } catch {}
      // Drop the pre-delete chip snapshot meta too (rows are gone, the snapshot can never be restored)
      for (const id of ids) clearSnapshot(id)
      commit('hardRemove', ids)
      // Same resurrect guard as purgeIds: rows + files + snapshots are gone, undo must not cross this generation
      commit('historyClear')
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
    async undo (ctx) { return undoStep(ctx) },
    async redo (ctx) { return redoStep(ctx) },
    /** Persist the diff after a snapshot switch (implementation in undo.js; safeUpsert injected) */
    persistSnapshotDiff (ctx, payload) { return persistSnapshotDiffCore(ctx, payload, safeUpsert) },

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
      // Declared out here (not in the try) so the catch's retry-enqueue can reach it — a `const`
      // inside the try block is invisible to catch, which silently killed the whole compensation
      let snapshot = []
      try {
        commit('bumpVersion')
        const serverV = state.version
        // Snapshot only dirty rows (status !== 'sync'); during the await, the user's new edits (status='update') aren't wrongly marked synced.
        // An already-synced whole table skips the wholesale upsertMany write entirely (Ctrl+S with no changes = no write)
        snapshot = [...state.todoList, ...state.recycleList].filter(t => t.status !== 'sync')
        if (!snapshot.length) return
        const snapshotIds = new Set(snapshot.map(t => t.taskId))
        // Atomic commit (W3 2026-09-12): rows + todosVersion cursor go to the DB in ONE transaction
        // (commitSyncBatch) instead of two separate dbCalls. Crash safety: previously a crash between the
        // upsertMany and the setMeta left rows at 'add'/'update' (harmless — they were just re-sent), but
        // writing status='sync' into the DB without atomicity would create a fatal intermediate state —
        // rows marked 'sync' with the cursor behind get skipped by the dirty-row filter and the cursor
        // never advances again = silent permanent non-convergence. Inside one transaction there is no
        // intermediate state: after a crash the batch is either fully re-sent (old dirty semantics) or
        // fully acknowledged (new semantics). The db layer forces status='sync' on every row.
        await window.todoAPI.dbCall('commitSyncBatch', { rows: deproxyRows(snapshot), version: serverV })
        // Only rows in the snapshot that weren't re-edited during the await are marked synced (can't do a wholesale markSyncedAll)
        ;[...state.todoList, ...state.recycleList]
          .filter(t => snapshotIds.has(t.taskId) && t.status !== 'update' && t.status !== 'delete')
          .forEach(t => { t.status = 'sync'; t.version = serverV })
      } catch (err) {
        reportError('syncTodos', err)
        // Enqueue for retry like reorderTodos/safeUpsert (round-6 leftover): rows stay dirty in memory,
        // but the quit-flush replay needs the op verbatim to survive a close-before-retry
        try { _pendingUpserts.push({ op: 'commitSyncBatch', params: { rows: deproxyRows(snapshot), version: state.version } }) } catch { /* keep the UI flow alive */ }
      } finally {
        commit('setSyncing', false)
        // In the finally block: the empty-snapshot early return used to skip the critical backup entirely
        dispatch('writeCriticalBackup')
      }
      // Stay quiet on sync success (per common practice, auto sync doesn't disturb the user); the version number is an implementation detail and goes into no copy
    },

    /** Event snapshot before dangerous operations: reason such as purge/import/restore, filename evt-<reason>-*.json */
    writeEventBackup ({ state, rootState }, reason) { return writeEventBackupCore(this, { state, rootState }, reason) },
    /** Auto backup: same structure as critical-state, written to userData/backups/auto-*.json with rolling cleanup */
    writeAutoBackup ({ state, rootState }) { return writeAutoBackupCore(this, { state, rootState }) },
    writeCriticalBackup ({ state, rootState }) { writeCriticalBackupCore(this, { state, rootState }) }
  }
}

/* Small helper for reading root settings (module-internal access) */
function root_getCompleteWithSub (rootState) { return rootState && rootState.settings ? rootState.settings.isCompleteWithSubtasks !== false : true }

function showNoDateFilter (arr, settings) {
  return settings.showNoDate ? arr : []
}

/* Calendar view data: for the current month's span (±half a year), the daily set can render directly from raw todoList rows */
function buildCalendarList (live) { return live.slice() }

/** Test seams (unit-tested in tests/store-fixes-domain.test.mjs): pending-write requeue and the de-proxy round-trip */
export const _testInternals = { pendingUpserts: _pendingUpserts, safeUpsert, flushPendingUpserts, deproxyRows }
