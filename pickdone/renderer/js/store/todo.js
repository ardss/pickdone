/**
 * Core todo module — state/action semantics aligned with the reference todo module
 * status: add/update/delete -> sync; local meta.todosVersion acts as the sync cursor
 */
import { genTaskId, nextSort, dayjs, reportError, parsePredecessors } from '../utils/core.js'
import { wouldCycle, isTaskReady } from '../utils/deps.js'
import { nextRepeatInstance, isLastRepeatInstance, renewalCarryFields } from '../utils/repeat.js'
import { removeRenewedInstance } from '../utils/repeatUndo.js'
import { setEstimate, pruneEstimatesForPurged } from '../utils/tomatoEstimate.js'
// D15-B2 (2026-10-03): renewal estimate semantics come from the SHARED estimate core (same clamp the CLI twin enforces).
import { clampEstimate } from '../../../shared/estimate-core.mjs'
import { clearSnapshot } from '../utils/dayPlans.js'
import { scrubMilestonesForPurged } from '../utils/milestones.js'
// Cross-cutting concerns, physically split out of this module (pure relocation — the store's action
// semantics are unchanged; the actions/mutations below delegate to these extracted implementations):
import { enqueueChipSync, rowChipSync, planSnapshotRowSync, snapshotForDelete, snapshotForDeleteMany, restoreSnapshot } from './helpers/planChips.js'
import { historyPush, historyPushKeepRedo, historyClear, historyBreakMerge, historyUndoPop, historyRedoPop, historyRedoPush, historyBarrierCore, undoStep, redoStep, persistSnapshotDiffCore } from './helpers/undo.js'
import { writeEventBackupCore, writeAutoBackupCore, writeCriticalBackupCore } from './helpers/todoBackup.js'
import { commit as commitCommand } from "../utils/commandBus.js"
import { safeUpsert, flushPendingUpserts, queuePendingUpsert, pendingUpserts, supersedePendingRow, adoptDuplicateWinnerRow } from './helpers/todoPendingUpserts.js'
import { DEFAULT_VIEWS, VIEW_AFFECTING_FIELDS, VIEWS_DEBOUNCE_MS, deproxyRows } from './helpers/todoViews.js'
import { snapshotString } from './helpers/snapshotString.js'
// View-computation + sync cores (pure relocation, structure-size ratchet — actions below are thin wrappers)
import { computeViewsCore } from './helpers/todoComputeViews.js'
import { syncTodosCore } from './helpers/todoSync.js'
import { countTags } from '../utils/search.js'
// Re-export: unit tests import the quit-flush retry contract straight from store/todo.js
export { safeUpsert, flushPendingUpserts }
// planSnapshotRowSync stays a named export of this module (tests import it from here)
export { planSnapshotRowSync }
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
    recentlyAddedTaskId: '',
    lastCreatedTodoTaskId: '',
    // Undo/redo (Ctrl+Z / Ctrl+Y): whole-table snapshots taken before mutation-type actions, valid per session, not persisted
    undoStack: [],
    redoStack: [],
    _histLastPushAt: 0,
    _histEpoch: 0, // Round-5 P0: reload epoch — bumped once per preserveHistory reload (see undo.js header)
    // Timestamp of the last local write: for todosChanged broadcast echoes (our own write broadcast back to us), skip full re-reads based on it, without clearing the undo stack
    _lastLocalWriteAt: 0,
    viewsDirty: true, // tasks changed, views pending recompute (the day-rollover timer decides recomputes based on this)
    views: DEFAULT_VIEWS(),
    isSyncing: false,
    holidayList: []          // statutory holiday cache (empty offline)
  }),
  getters: {
    todayTodoList: s => s.views.todayTodoList,
    yesterdayTodoList: s => s.views.yesterdayTodoList,
    /* Wave-5 dedup: tag count aggregation was kept verbatim in THREE components (SideNav /
       SnTagPanel / SnManageTagsModal). Pure derivation from state; Vuex caches it for free.
       The counting core lives in utils/search.js countTags (next to extractTags). */
    tagCounts: (s, _g, rootState) =>
      countTags(s.todoList, (rootState && rootState.ui && rootState.ui.userTags)),
    /* D2 dedup: the two most-repeated filter predicates, shared across views (DepView /
       TagAllView / TodayView for activeList; SnManageCategoriesModal / ProjectView /
       ProjectOverviewView for byCategory). Same derivation as the private views precompute
       above, but as cached getters. */
    activeList: s => s.todoList.filter(t => !t.delete),
    byCategory: s => id => s.todoList.filter(t => t.categoryId === id)
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
    // Round-5 P0: barrier after a preserveHistory reload — epoch bump + redo clear + post-reload snapshot
    historyBarrier (s) { historyBarrierCore(s) },
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
    /* Echo-suppression stamp: the single writer of _lastLocalWriteAt (previously two direct
       cross-module writes: index.js subscribeAction-after and tomato.js bumpSnow). Consumers:
       main.js todosChanged echo gate (1500ms window, protects the undo stack from our own
       broadcast echo's todo/init historyClear). */
    stampLocalWrite (s) { s._lastLocalWriteAt = Date.now() },
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
    async init ({ commit, dispatch }, { preserveHistory = false } = {}) {
      // After data reload, old snapshots no longer match the current rows; void the undo/redo stacks.
      // P1-2 (2026-09-19 UX review round 2): LAN-sync-applied rounds reload with preserveHistory —
      // remote edits are not captured in the local undo stack, so clearing here would only destroy
      // the USER'S OWN pending undo history on every inbound sync round. True external writes
      // (CLI watcher path) keep the clearing behavior.
      if (!preserveHistory) commit('historyClear')
      let rows
      try {
        rows = await window.todoAPI.dbCall('getAll', {})
      } catch (err) { reportError('init:getAll', err); rows = [] }
      commit('setAllRows', rows)
      let v = 0
      try { v = parseInt(await window.todoAPI.dbCall('getMeta', 'todosVersion') || '0', 10) } catch (err) { reportError('init:getMeta', err) }
      commit('setMeta', { todosVersion: v })
      // Round-5 P0: the surviving stacks still hold whole-table snapshots taken BEFORE the peer's rows
      // arrived. Push a barrier entry of the post-reload table and void the redo stack — without it the
      // first undo diffed against a stale pre-sync baseline and tombstoned the peer-created tasks.
      if (preserveHistory) commit('historyBarrier')
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
        // Default follows the user's "new task default position" setting (top|bottom); a caller
        // passing an explicit addToTop still wins (destructuring default only applies when absent)
        addToTop = rootState.settings.newTodoDefaultSort !== 'bottom',
        estimate = 0,
        // D5 (2026-09-20): triage/plan attributes carried by repeat renewal (CLI twin semantics, `t.x || 0`);
        // plain addTodo callers omit them and get the 0 defaults
        priority = 0,
        deadlineTs = 0,
        important = 0,
        urgent = 0,
        dayOverride = null,
        predecessors = null
      } = payload
      // Discrete op: break the 400ms undo merge so following edits don't fuse into the add step
      commit('historyBreakMerge')
      const now = Date.now()
      // Renewal instance idempotency: skip when the same rid + same dayStart already exists (prevents concurrent multi-window + CLI double-triggering creating two renewals at the same moment)
      let targetDay = 0
      if (repeatId) {
        targetDay = dayOverride != null ? dayOverride : (todoDate ? +dayjs(todoDate).startOf('day') : 0)
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
        priority, deadlineTs, important, urgent,
        repeatId, subtasks: todoSublist ? JSON.stringify(todoSublist) : null,
        predecessors: Array.isArray(predecessors) && predecessors.length ? JSON.stringify(predecessors) : null,
        image: todoImage, files: fileList,
        categoryId, updateTime: now, syncTime: 0,
        taskContent: String(todoContent || '').trim(),
        taskDescribe: todoDescription || '',
        // Sort-jitter mitigation (P2, root cause documented): same-day taskSort is computed from each
        // window's possibly-stale in-memory min/max, so two windows adding to the same day can derive the
        // IDENTICAL sort value; with equal keys the list order then flips depending on which row the DB
        // returns first. A real fix needs an atomic DB-side next-sort channel (cross-module design, main
        // process) -- recorded on the skip list. Low-risk mitigation here: a jitter well below the
        // nextSort step (100) so ordinary single-window inserts can never overtake an adjacent row;
        // it only keeps collision-identical values distinct, ordered by actual arrival.
        taskId: genTaskId(userId), taskSort: Math.fround(sort + (Math.random() - 0.5) * 64),
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
      // [D13 #10] repeat-renewal duplicate race, renderer half: the check-then-insert guard above
      // cannot close the window between queryTodos and the row write (multi-window + CLI). The DB
      // layer now carries a UNIQUE partial index on (recurGroupId, scheduledDay) for live rows, so
      // the LOSING renewal write rejects with a constraint error — the caller then adopts the
      // winner's row instead of minting a second instance. Non-renewal adds keep the queued
      // fire-and-forget path.
      if (repeatId && targetDay) {
        let plain
        try { plain = JSON.parse(JSON.stringify(t)) } catch (e) { plain = t }
        supersedePendingRow(plain && plain.taskId)
        try {
          await commitCommand('todo', 'put', plain)
        } catch (e) {
          if (/UNIQUE constraint failed/.test(String((e && e.message) || e))) {
            commit('removeLocal', t.taskId)
            try {
              // [TL-1] the adopt-the-winner routine is the shared adoptDuplicateWinnerRow (todoPendingUpserts.js) —
              // the same query the quit-flush replay uses to convert a UNIQUE-loser entry
              const existing = await adoptDuplicateWinnerRow(t)
              if (existing) {
                commit('upsertLocal', existing)
                dispatch('computeViews')
                return existing // the other trigger's instance wins; both callers resolve to the same row
              }
            } catch (e2) { /* fall through to the queued-retry path below */ }
          }
          queuePendingUpsert({ op: 'upsert', params: plain }) // non-constraint failure / lost race without an adoptable row: replay later
        }
      } else {
        safeUpsert(t)
      }
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
      // [TL-5] durable-store existence authority: a memory miss resolves once via getById — the
      // row may exist in the DB but not yet in this window's memory (broadcast reload window).
      const raw = await resolveForEdit(state, taskId)
      if (raw.notFound) return raw // structured not-found: callers see the rejection, not a fake success
      const prevDayStart = raw.dayStart // capture BEFORE upsertLocal mutates the row in place: the chip-sync job runs in a microtask and must migrate from the day the task is leaving
      const merged = { ...raw, ...patch, updateTime: Date.now(), status: 'update' }
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
        enqueueChipSync(raw.taskId, () => rowChipSync(raw.taskId, prevDayStart, merged))
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
          // Perf (toggle-complete dep scan): one O(N) pass parses each row's predecessors ONCE and
          // feeds both the reverse-dependents index and the readiness check — the old shape ran
          // ~N + D parsePredecessors invocations per toggle (filter re-parse + isTaskReady re-parse
          // per dependent) and rebuilt an O(N) byId map for every candidate dependent. The scan
          // runs BEFORE any mutation, so reading rows directly (no defensive {...x} copy) keeps
          // the output identical.
          const live = state.todoList
          const byId = {}
          const predsByRow = new Map()
          for (const x of live) {
            if (!x.delete) byId[x.taskId] = x
            predsByRow.set(x, parsePredecessors(x.predecessors))
          }
          const newlyReady = live.filter(t => !t.delete && !t.complete &&
            predsByRow.get(t).includes(todo.taskId) &&
            isTaskReady(live, t, { byId, predsOf: r => predsByRow.get(r) }))
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
      if (!target) {
        await removeRenewedInstance({ todo, state, commit, dispatch, safeUpsert, snapshotForDelete })
      }
      // Discrete op: break the 400ms undo merge so a following edit doesn't fuse into the check step
      commit('historyBreakMerge')
      return r
    },

    /** Repeat-group renewal: when the last incomplete instance in a group is completed, generate the next instance per the group rule.
     *  Decision (is-last) + next-occurrence + carried fields all come from shared/repeat-core.mjs (P2-4 single source);
     *  this action keeps only the dispatch('addTodo') thin wrapper and the persistence concerns. */
    async ensureNextRepeatInstance ({ dispatch }, completedTodo) {
      const rid = completedTodo.repeatId
      if (!rid) return
      const group = this.state.todo.todoList.filter(t => t.repeatId === rid && !t.delete && t.dayStart > 0)
      // Only the group's last (latest) instance renews; no-date instances never renew (a bogus 1970 chain)
      if (!isLastRepeatInstance(completedTodo, group)) return
      // The rule's single source of truth is meta (same source as the CLI); the historical LS fallback has been dismantled (all hosts have the meta channel)
      let rule = null
      try { rule = JSON.parse(await window.todoAPI.dbCall('getMeta', 'repeatRule:' + rid) || 'null') } catch { /* empty */ }
      if (!rule) return
      // Single source: next occurrence + reminder time (same computation the CLI twin uses via todo-core.js)
      const next = nextRepeatInstance(completedTodo, group, rule, this.state.todo.holidayList || [])
      if (!next) return
      const t = completedTodo
      // D15-B2 (2026-10-03): read the LIVE per-task meta estimate (same as the CLI twin) — the
      // row estimate COLUMN is dead post-X2 (bumpSnow writes focus minutes into it), so seeding
      // from it polluted the new instance. Meta key first; column only as legacy fallback; 0..20.
      let renewalEstimate = t.estimate || 0
      try {
        const live = await window.todoAPI.dbCall('getMeta', 'tomatoEstimateState:' + t.taskId)
        if (live !== null && live !== undefined && live !== '') renewalEstimate = Number(live) || 0
      } catch (e) { /* read failure: keep the column fallback, clamp below decides */ }
      renewalEstimate = clampEstimate(renewalEstimate)
      // Single source: carried attributes (D5 parity set — the renewal used to drop priority/deadlineTs/
      // important/urgent, `t.x || 0` semantics), mapped onto addTodo's todoX argument names
      const carry = renewalCarryFields(t, next)
      const nt = await dispatch('addTodo', {
        categoryId: t.categoryId,
        todoContent: t.taskContent,
        todoDescription: t.taskDescribe || '',
        todoDate: next.todoTime,
        todoReminderTime: carry.reminderTime,
        todoReminderOffsets: carry.reminderOffsets,
        todoReminderExtra: carry.reminderExtra,
        todoDifficultyLevel: carry.difficulty,
        priority: carry.priority,
        deadlineTs: carry.deadlineTs,
        important: carry.important,
        urgent: carry.urgent,
        estimate: renewalEstimate,
        repeatId: carry.repeatId,
        todoSublist: t.subtasks ? (function(){try{return JSON.parse(t.subtasks)}catch{return[]}})().map(x => ({ ...x, checked: false })) : null,
        addToTop: false
      })
      // U-1 (2026-09-20): the estimate column on the new row is write-once at the DB layer (the upsert
      // ignores it for existing-style reasons) — the live value lives in the per-task meta key
      // `tomatoEstimateState:<taskId>` (the field-granular syncable unit). Copy it there so the renewal
      // keeps its estimated workload on BOTH ends (CLI twin: cli/lib.js renewal — F-Main's commit).
      try { if (nt && nt.taskId) setEstimate(nt.taskId, renewalEstimate) } catch (e) { /* estimate is advisory */ }
      return nt
    },
    async reorderTodos ({ commit, dispatch }, updates) {
      const now = Date.now()
      // Look up within a single table-building loop: previously each update copied the whole table + findIndex; batch-sorting a thousand entries was O(n·u) ≈ millions of comparisons, janking one frame
      const index = new Map([...this.state.todo.todoList, ...this.state.todo.recycleList].map(t => [t.taskId, t]))
      const rows = []
      const notFoundIds = []
      for (const u of updates) {
        // [TL-5] durable-store existence authority: a memory miss resolves once via getById —
        // an external (peer/CLI) row the broadcast reload has not delivered yet is still editable.
        let raw = index.get(u.taskId)
        if (!raw) {
          const r = await resolveForEdit(this.state.todo, u.taskId)
          if (r.notFound) { notFoundIds.push(u.taskId); continue }
          commit('upsertLocal', r)
          index.set(u.taskId, r)
          raw = r
        }
        // [reorder-only no-LWW-re-age fix] a row whose taskSort did not actually change keeps its
        // stamps: re-aging it (fresh updateTime + status='update') made a pure drag-reorder win
        // LWW over a peer's concurrent CONTENT edit of the same row and silently revert it.
        if (raw.taskSort === u.taskSort) { commit('upsertLocal', raw); continue }
        const merged = { ...raw, taskSort: u.taskSort, updateTime: now, status: 'update' }
        commit('upsertLocal', merged)
        rows.push(merged)
      }
      if (!rows.length) return { applied: 0, notFound: notFoundIds } // [TL-5] not-found ids surface instead of a silent fake success
      // Same pending-queue guarantee as safeUpsert: a transient IPC/db failure must not silently drop the
      // whole batch (the rows were already re-sorted in memory, so a lost write resurfaces as a wrong order
      // after restart). flushPendingUpserts replays any queued op verbatim, 'upsertMany' included.
      try {
        await commitCommand("todo", "putMany", deproxyRows(rows))
      } catch (err) {
        reportError('upsertMany', err)
        try { queuePendingUpsert({ op: 'upsertMany', params: deproxyRows(rows) }) } catch { /* keep the UI flow alive even if cloning fails */ }
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
      // [TL-5] durable-store existence authority (same resolveForEdit choke point as updateTodoFields)
      const raw = await resolveForEdit(this.state.todo, todo.taskId)
      if (raw.notFound) return raw
      // The deleted task is bound by tomato focus: detach first, otherwise after focus completes the record is booked to a taskId in the recycle bin
      if (rootState.tomato && rootState.tomato.attachTodo && rootState.tomato.attachTodo.taskId === todo.taskId) {
        dispatch('tomato/attach', null, { root: true })
      }
      // version reset to 0: a re-delete after restore must re-enter the sync snapshot (syncTodos
      // excludes delete rows already acked with version > 0 — P3 2026-09-12)
      const merged = { ...raw, delete: true, deleting: true, deletedAt: Date.now(), updateTime: Date.now(), status: 'delete', version: 0 }
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

    /** maint/dw wave3 F-C1: batch variant of deleteTodo — ONE history snapshot (one undo restores
     *  the whole batch), ONE computeViews, ONE putMany write. The old call sites looped per-row
     *  deleteTodo dispatches: each round broke the 400ms undo merge and pushed a whole-table
     *  snapshot into the undo stack (a 700-row batch ≈ 0.7GB of string churn), ran a debounced
     *  computeViews per row and 3 serial IPCs per row. Same batch shape as reorderTodos
     *  (Map lookup + putMany + single computeViews). Deliberately NOT in index.js's
     *  HISTORY_ACTIONS set: the pre-batch snapshot is pushed here explicitly (once) instead of by
     *  the subscribeAction before-hook, so the whole batch is exactly ONE undo step. */
    async deleteTodosMany ({ commit, dispatch, rootState }, todos) {
      commit('historyBreakMerge')
      const index = new Map([...this.state.todo.todoList, ...this.state.todo.recycleList].map(t => [t.taskId, t]))
      const now = Date.now()
      const rows = []
      const ids = []
      const notFoundIds = []
      for (const todo of (todos || [])) {
        // [TL-5] durable-store existence authority (same resolveForEdit choke point): an id the
        // broadcast reload has not delivered yet is still deletable from the durable store.
        let raw = index.get(todo && todo.taskId)
        if (!raw) {
          const r = await resolveForEdit(this.state.todo, todo && todo.taskId)
          if (r.notFound) { notFoundIds.push(todo && todo.taskId); continue }
          commit('upsertLocal', r)
          index.set(r.taskId, r)
          raw = r
        }
        ids.push(raw.taskId)
        // version reset to 0: same re-delete-after-restore sync semantics as deleteTodo
        rows.push({ ...raw, delete: true, deleting: true, deletedAt: now, updateTime: now, status: 'delete', version: 0 })
      }
      if (!rows.length) { if (notFoundIds.length) console.warn('[todo] deleteTodosMany: ids absent from both memory and the durable store:', notFoundIds); return [] }
      // Single pre-batch snapshot (same shape the before-hook pushes for deleteTodo); round-3 perf:
      // fragment-cache stringify, byte-identical to the old whole-table one (helpers/snapshotString.js)
      const snap = this.state.todo
      commit('historyPush', snapshotString(snap.todoList, snap.recycleList))
      // Focus-bound rows detach first (same as deleteTodo)
      const at = rootState.tomato && rootState.tomato.attachTodo
      if (at && ids.includes(at.taskId)) dispatch('tomato/attach', null, { root: true })
      for (const merged of rows) commit('upsertLocal', merged)
      // deleting is a local-dialect UI flag, not a schema column: strip before persisting (deleteTodo)
      const clean = rows.map(m => { const r = { ...m }; delete r.deleting; return r })
      // Same pending-queue guarantee as reorderTodos: a transient IPC/db failure stays queued for the
      // quit-flush replay instead of silently dropping the batch
      try {
        await commitCommand('todo', 'putMany', deproxyRows(clean))
      } catch (err) {
        reportError('upsertMany', err)
        try { queuePendingUpsert({ op: 'upsertMany', params: deproxyRows(clean) }) } catch { /* keep the UI flow alive */ }
      }
      // Chip cascade per task, snapshot to meta first (same as deleteTodo).
      // D14-C15: ONE shared planAll read for the whole batch (snapshotForDeleteMany) instead of a
      // full-table scan + 3 IPC round-trips per id — a large batch used to stall for seconds.
      try { await snapshotForDeleteMany(ids) } catch (e) { console.warn('[todo] failed to batch-snapshot chips for deleted tasks:', e) }
      dispatch('computeViews')
      dispatch('writeCriticalBackup')
      if (notFoundIds.length) console.warn('[todo] deleteTodosMany: ids absent from both memory and the durable store:', notFoundIds) // [TL-5] surfaced, not silently skipped
      return ids
    },

    async restoreFromRecycle ({ commit, dispatch }, todo) {
      // Row first, snapshot second (verify-then-commit): restoreSnapshot empties the snapshot meta as a side
      // effect, so consuming it before the row update was confirmed meant a mid-way failure (row missing,
      // updateTodoFields throwing) left the snapshot permanently lost and/or a ghost chip on the timeline.
      // The row update alone is harmless to retry; only after it succeeds do we spend the one-shot snapshot.
      // [restore single-path fix] `dayPatch` (RecycleBinView restore-to-today / pick-date) merges the
      // shared crossDayMovePatch fields into the same atomic restore entry, so EVERY restore path
      // gets the chip snapshot restore, the deletedAt reset and the B5 dangling-repeatId guard —
      // the bin view used to dispatch bare updateTodoFields and silently skipped all three.
      const r = await dispatch('updateTodoFields', { taskId: todo.taskId, patch: { delete: false, deletedAt: 0, status: 'update', ...((todo && todo.dayPatch) || {}) } })
      if (r) {
        // D14-B4: a re-dating restore (dayPatch from RecycleBinView's restore-to-today / pick-date)
        // must re-home the snapshot chips onto the NEW day — verbatim restore used to resurrect
        // them as ghost blocks on the OLD day until planPrune GC'd them.
        const patch = (todo && todo.dayPatch) || {}
        const toDay = patch.dayStart ? dayjs(patch.dayStart).format('YYYY-MM-DD') : undefined
        try { await restoreSnapshot(todo.taskId, toDay) } catch { /* No snapshot = originally unscheduled */ }
      }
      // [B5 fix] dangling repeatId guard: startup meta GC (computeMetaGc, shared.js) legitimately purges
      // `repeatRule:<rid>` when the rule was referenced only by recycle-bin rows (the deleted:0 filter
      // closed the leak but never taught restore about the new invariant). Restoring such a task used to
      // resurrect a dangling repeatId: completing it hit ensureNextRepeatInstance's silent `!rule` return
      // and the chain just died. If the rule meta is gone, restore the task as a plain non-repeating task
      // (the rule data is gone; fabricating one would invent UX).
      if (r && todo.repeatId) {
        let rule = null
        try { rule = JSON.parse(await window.todoAPI.dbCall('getMeta', 'repeatRule:' + todo.repeatId) || 'null') } catch { /* treated as gone */ }
        if (!rule) {
          await dispatch('updateTodoFields', { taskId: todo.taskId, patch: { repeatId: null, status: 'update' } })
          console.warn('[todo] restored task', todo.taskId, 'had a dangling repeatId (rule meta GCed) — restored as a non-repeating task')
        }
      }
      // Discrete op: break the 400ms undo merge so a following edit doesn't fuse into the restore step
      commit('historyBreakMerge')
      return r
    },

    async purgeIds ({ commit, dispatch, rootState, state }, ids) {
      // Discrete op: break the 400ms undo merge so following edits don't fuse into the purge step
      commit('historyBreakMerge')
      // F3 (dw wave6 2026-09-24): the snapshot result is no longer swallowed — a failed pre-purge
      // snapshot (IPC error / {ok:false}) is logged loudly here and stamped into runtimeState
      // (eventBackupLastFailAt/eventBackupLastError, surfaced via the Settings→Data status line)
      // instead of purging silently with no evt-*.json on disk. The purge itself still proceeds:
      // blocking the user's explicit destructive command on a backup IO failure trades one bug
      // for a worse one (a purge that can never finish).
      if (ids.length && !(await dispatch('writeEventBackup', 'purge'))) console.error('[todo] purge proceeded WITHOUT its pre-delete event snapshot (see eventBackupLastError)') // snapshot before permanent deletion
      // Permanently deleted tasks still bound by focus: detach (same as deleteTodo)
      const at = rootState.tomato && rootState.tomato.attachTodo
      if (at && ids.includes(at.taskId)) dispatch('tomato/attach', null, { root: true })
      // Delete per id and remove locally only the successful ones: Promise.all swallowing errors then hardRemove-ing the whole batch once let failed ids "revive" back into the recycle bin after restart.
      // Perf (purge batch): one hardDeleteMany commit replaces the per-id hardDelete loop — the
      // server-side bulk op already GCs chips/snow/estimate meta keys per id and returns only the
      // PHYSICALLY deleted ids (absent ids excluded, same per-id honesty as the old loop). If the
      // bulk op rejects wholesale (older host / bus error), fall back to the per-id loop so the
      // failure isolation is preserved.
      let done = []
      try {
        const deleted = await commitCommand("todo", "hardDeleteMany", ids)
        if (!Array.isArray(deleted)) throw new Error('hardDeleteMany returned no per-id result — falling back to per-id hardDelete')
        done = deleted.map(String)
        for (const id of done) clearSnapshot(id)
      } catch (err) {
        reportError('hardDeleteMany', err)
        for (const id of ids) {
          try { await commitCommand("todo", "hardDelete", id); done.push(id); clearSnapshot(id) } catch (e) { reportError('hardDelete', e) }
        }
      }
      // [C15 fix] the empty catch here silently orphaned attachment files on disk when cleanup failed
      // (main throws a structured per-file failure list). Log it like the adjacent hardDelete failures;
      // rows are already hard-deleted, so the purge (and the historyBarrier re-baseline below) still proceeds.
      // Perf (purge batch): ONE delete-todo-files-many IPC for the whole batch instead of a per-id
      // readdir+unlink IPC each.
      try { if (done.length && window.todoAPI.deleteTodoFilesMany) await window.todoAPI.deleteTodoFilesMany(done) } catch (err) { reportError('deleteTodoFilesMany', err) }
      // Drop the purged tasks' pomodoro-estimate meta keys from the renderer mirror: hardDeleteMany
      // already deleted the DB keys server-side (deleteEstimateKeysFor per id, incl. the legacy
      // per-id fallback) — MetaGC/DB owns the DB side; the id-based prune drops the local mirror
      // entries so a recycled numeric id cannot resurrect a stale estimate (review M-C5).
      try { if (done.length) pruneEstimatesForPurged(done) } catch {}
      if (done.length) {
        // D17: scrub across ALL live categories, not just the purged rows' own ones — a milestone of
        // ANOTHER project category may link the purged id (CLI parity: cli/lib.js scans every key);
        // unaffected blobs are skipped by scrubMilestoneTaskIds' same-reference shortcut.
        const purgedCatIds = [...new Set((((rootState && rootState.category) || {}).list || []).filter(c => c && !c.delete).map(c => c.categoryId))]
        commit('hardRemove', done)
        // D5 (2026-09-20): scrub the purged ids from `projectMilestones:<catId>` taskIds — a past
        // milestone whose last link was purged otherwise kept a phantom taskId set (milestoneState
        // fell through to the date-driven 'done' branch, flipping an UNMET milestone to done).
        // (Round-3 P1: shared with purgeAllRecycle — see scrubMilestonesForPurged below.)
        await scrubMilestonesForPurged(purgedCatIds, done)
        // Rows are physically gone (hardDelete + attachment files + chip snapshot meta): undo must not
        // resurrect them. [TL-6] historyBarrier instead of historyClear: the barrier bumps the reload
        // epoch and re-baselines the post-purge table, which invalidates exactly the stale pre-purge
        // baselines — the whole user history stays reachable, and the purged-generation guard in
        // persistSnapshotDiffCore (durable-existence read) makes replaying even a stale baseline safe.
        commit('historyBarrier')
      }
      dispatch('computeViews')
      dispatch('writeCriticalBackup')
      // QC r1: return what actually succeeded so views can converge their toasts on reality
      // (purgeIds swallows per-id failures by design — the return value is the only failure signal)
      return { done, failed: ids.filter(id => !done.includes(id)) }
    },
    async purgeAllRecycle ({ commit, dispatch, rootState, state }) {
      const ids = state.recycleList.map(t => t.taskId)
      if (!ids.length) return true // QC r3: empty bin = nothing to purge = success (a falsy return read as "purge failed" in SettingsDataTab when the bin drained during the confirm dialogs)
      // Discrete op: break the 400ms undo merge so following edits don't fuse into the purge step
      commit('historyBreakMerge')
      // F3 (dw wave6 2026-09-24): same honest-failure handling as purgeIds above — a failed
      // pre-purge snapshot is logged + stamped into runtimeState instead of vanishing
      if (!(await dispatch('writeEventBackup', 'purge-all'))) console.error('[todo] purge-all proceeded WITHOUT its pre-delete event snapshot (see eventBackupLastError)') // snapshot before emptying the recycle bin
      // Round-3 P1 (parity with purgeIds): permanently deleted tasks still bound by focus detach first
      const at = rootState && rootState.tomato && rootState.tomato.attachTodo
      if (at && ids.includes(at.taskId)) dispatch('tomato/attach', null, { root: true })
      // DB rows first, then attachment files: the other order leaves rows pointing at deleted files if the file purge fails.
      // Converge only on success (aligned with purgeIds' per-id guard): when the purge IPC fails we keep the local
      // rows untouched — the old flow hardRemoved locally + cleared the undo stack anyway, so the rows "revived"
      // back into the recycle bin after restart while the user had been told they were gone for good
      let purged = false
      try { purged = await window.todoAPI.purgeRecycleBin() === true } catch (err) { reportError('purgeRecycleBin', err) }
      if (!purged) { dispatch('computeViews'); return false }
      // Attachment cleanup aligned with per-item permanent deletion (the main process's purgeRecycleBin only deletes rows, not files/)
      // [C15 fix, same class as purgeIds] attachment-file cleanup failures are logged, not swallowed
      // Perf (purge batch): ONE delete-todo-files-many IPC for the whole bin instead of a per-id readdir+unlink IPC each.
      try { if (window.todoAPI.deleteTodoFilesMany) await window.todoAPI.deleteTodoFilesMany(ids) } catch (err) { reportError('deleteTodoFilesMany', err) }
      // Drop the pre-delete chip snapshot meta too (rows are gone, the snapshot can never be restored)
      for (const id of ids) clearSnapshot(id)
      // maint-d7: drop the purged tasks' pomodoro-estimate meta keys too — parity with purgeIds
      // (review M-C5) and the CLI purge path (cli/lib.js deletes ESTIMATE_KEY_PREFIX per row); a
      // recycled numeric taskId used to resurrect a stale estimate on the bulk "empty bin" path.
      // DB keys are purged server-side per row; this prunes the local mirror (id-based prune).
      try { pruneEstimatesForPurged(ids) } catch {}
      // Round-3 P1: the bulk path used to SKIP the milestone scrub (phantom taskIds → unmet
      // milestone flipping to 'done'). D17: same widening as purgeIds — ALL live categories
      // (cross-category links), CLI parity.
      const purgedCatIds = [...new Set((((rootState && rootState.category) || {}).list || []).filter(c => c && !c.delete).map(c => c.categoryId))]
      commit('hardRemove', ids)
      await scrubMilestonesForPurged(purgedCatIds, ids)
      // Same resurrect guard as purgeIds: rows + files + snapshots are gone, undo must not cross this
      // generation. [TL-6] historyBarrier (see purgeIds): targeted re-baseline instead of a whole-stack wipe.
      commit('historyBarrier')
      dispatch('computeViews')
      dispatch('writeCriticalBackup')
      return true // QC r1: boolean success flag — RecycleBinView.clearAll toasts error instead of false success
    },
    /** Recycle bin auto-expiry purge: deleted rows past N days by deletion time (updateTime) are permanently deleted (N=0 never).
        Clock sanity check: when the system clock jumps back/forward more than 48h (BIOS battery loss, manual change), skip this round of auto purge,
        preventing the accident of "clock set to the future → startup hard-deletes the whole recycle bin" (finalized in the 2026-08-29 release review). */
    async purgeExpiredRecycle ({ state, rootState, dispatch }, { force = false } = {}) {
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
      // U-8 (2026-09-20) same-day dedupe: computeViews dispatches this on every rebuild, so one day used
      // to run the cutoff scan (and the pre-attempt stamp) many times. Once per LOCAL CALENDAR DAY is the
      // semantic (not a 24h interval); `force` bypasses it for tests/manual triggers.
      if (!force && lastPurgeAt && dayjs(lastPurgeAt).isSame(dayjs(), 'day')) return
      // Calendar-day basis: roll back N days from today at midnight, avoiding boundary drift from "deleted at an arbitrary moment"
      const cutoff = +dayjs().startOf('day').subtract(days, 'day')
      const ids = state.recycleList.filter(t => (t.deletedAt || t.updateTime || 0) < cutoff).map(t => t.taskId)
      try {
        if (ids.length) await dispatch('purgeIds', ids)
      } finally {
        // U-8: the stamp moved AFTER the purge attempt — stamping up front meant a failed attempt (hardDelete
        // errors) was recorded as done for the rest of the day and never retried. The attempt has now
        // completed (success or its logged per-id failures), so the day is consumed either way.
        try { localStorage.setItem('recycleLastPurgeAt', String(now)) } catch { /* ignore */ }
      }
    },

    /* ---------- Undo/redo ---------- */
    async undo (ctx) { return undoStep(ctx) },
    async redo (ctx) { return redoStep(ctx) },
    /** Persist the diff after a snapshot switch (implementation in undo.js; safeUpsert injected) */
    persistSnapshotDiff (ctx, payload) { return persistSnapshotDiffCore(ctx, payload, safeUpsert) },

    scheduleReminder (_, todo) {/* the main process rebuilds the schedule automatically after dbCall */},

    /* ---------- View computation (grouping semantics follow common practice) ----------
       Implementation extracted verbatim to helpers/todoComputeViews.js; the action stays the
       public surface (tests drive it with a fake `this`, which is forwarded as the store). */
    async computeViews (ctx) { return computeViewsCore(this, ctx) },

    /** Trigger a "cloud sync" action — offline implementation: increment the local version and mark everything sync.
        Implementation extracted verbatim to helpers/todoSync.js (structure-size ratchet). */
    async syncTodos (ctx) { return syncTodosCore(ctx) },

    /** Event snapshot before dangerous operations: reason such as purge/import/restore, filename evt-<reason>-*.json */
    writeEventBackup ({ state, rootState }, reason) { return writeEventBackupCore(this, { state, rootState }, reason) },
    /** Auto backup: same structure as critical-state, written to userData/backups/auto-*.json with rolling cleanup */
    writeAutoBackup ({ state, rootState }) { return writeAutoBackupCore(this, { state, rootState }) },
    writeCriticalBackup ({ state, rootState }) { writeCriticalBackupCore(this, { state, rootState }) }
  }
}

/* Small helper for reading root settings (module-internal access) */
function root_getCompleteWithSub (rootState) { return rootState && rootState.settings ? rootState.settings.isCompleteWithSubtasks !== false : true }

/** D15 (TL-5): durable-store existence authority for renderer write actions — ONE choke point.
 *  Previously every write action treated the in-memory table as the existence authority: on a
 *  memory miss (the window between a peer/CLI write and the todos-changed broadcast reload —
 *  docs/sync-matrix.md:60) updateTodoFields/deleteTodo/reorderTodos/deleteTodosMany silently
 *  returned fake success and the user's edit vanished with no rejection and no queue entry,
 *  violating op-feedback (a write either lands or rejects). Resolution: memory hit → row; else
 *  one getById on the durable store (the same allowlisted read door the CLI uses) — a DB hit is
 *  upserted into memory and handed to the caller to merge; a DB miss is a structured not-found
 *  the caller surfaces. Class-complete: every renderer write action routes through this one
 *  helper instead of re-declaring its own memory-miss behavior. */
async function resolveForEdit (state, taskId) {
  const hit = [...(state.todoList || []), ...(state.recycleList || [])].find(t => t.taskId === taskId)
  if (hit) return hit
  try {
    const row = await window.todoAPI.dbCall('getById', taskId)
    if (row && row.taskId != null) return row
  } catch (err) { reportError('resolveForEdit:getById', err) }
  return { notFound: true, taskId }
}

/** Test seams (unit-tested in tests/store-fixes-domain.test.mjs): pending-write requeue and the de-proxy round-trip */
export const _testInternals = { pendingUpserts: pendingUpserts(), safeUpsert, flushPendingUpserts, deproxyRows }
