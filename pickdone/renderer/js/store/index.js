/** Vuex root — module split follows common practice (auth/todo/tomato/repeatSettings/category/settings/ui etc.)
 *  Vuex 4: createStore (replaces Vue2's new Vuex.Store, no Vue.use needed) */
import auth from './auth.js'
import todo from './todo.js'
import tomato from './tomato.js'
import settings, { tomatoLedgerPatch } from './settings.js'
import category from './category.js'
import habits from './habits.js'
import ui from './ui.js'
import repeatSettings from './repeatSettings.js'
import filters from './filters.js'
import tomatoAnnounce from './tomatoAnnounce.js'
import { snapshotString } from './helpers/snapshotString.js'

const Vuex = window.Vuex

const store = Vuex.createStore({
  modules: { auth, todo, tomato, settings, category, habits, ui, repeatSettings, filters, tomatoAnnounce },
  state: () => ({ cloudEnabled: false }),
  getters: {
    tomatoBarVisible (state) {
      const busy = state.tomato.status && state.tomato.status !== 'default'
      return busy || state.ui.activeNav === 'today'
    }
  },
  strict: false
})

// Undo/redo: push a whole-table snapshot before mutation-type actions execute (todo/historyPush does 400ms chained merging with a cap of 50)
// ⚠️This set is the "snapshot-push set" and must never include undo/redo themselves — otherwise undo triggers the before hook, pushing the current state back onto the stack top,
// and undo would forever restore "the moment of undoing" = a fake undo; the <400ms merge branch would also overwrite and destroy real history snapshots (reproduced in the 4th review round's P0 testing; the fdc7c9d baseline didn't include them)
const HISTORY_ACTIONS = new Set([
  'todo/addTodo', 'todo/updateTodoFields', 'todo/toggleComplete', 'todo/deleteTodo',
  'todo/restoreFromRecycle', 'todo/purgeIds', 'todo/purgeAllRecycle', 'todo/reorderTodos'
])
// Full set of write actions that persist and trigger cross-window broadcasts: the echo-suppression window's timestamp stamping must cover all of them; missing one causes
// "our own broadcast echo reloading todo/init and clearing the undo stack" — the 2026-08-31 incident of this class only plugged ten whitelist entries
// F-C1 review fix: deleteTodosMany is a REAL DB write (todo.putMany) but deliberately kept out of
// HISTORY_ACTIONS (it pushes its own single pre-batch snapshot in-action; the before-hook would
// double-push). Without WRITE_ACTIONS membership its echo stamped no _lastLocalWriteAt, so the
// main-process broadcast of its own write fell outside the 1500ms suppression window and the
// echo's todo/init (no preserveHistory) cleared the undo stack — "one undo restores the whole
// batch" died at runtime exactly as it did pre-2026-08-31.
const WRITE_ACTIONS = new Set([...HISTORY_ACTIONS, 'todo/undo', 'todo/redo', 'todo/syncTodos', 'todo/deleteTodosMany'])
store.subscribeAction({
  before (action) {
    if (!HISTORY_ACTIONS.has(action.type)) return
    const t = store.state.todo
    // Snapshots stored as strings, not objects: stringify only once on the push side (previously stringify+parse double work); parse only at undo time.
    // Round-3 perf: snapshotString serializes only rows whose updateTime/version changed (per-row
    // fragment cache) — output stays byte-identical to the previous whole-table JSON.stringify.
    store.commit('todo/historyPush', snapshotString(t.todoList, t.recycleList))
  },
  after (action) {
    if (!WRITE_ACTIONS.has(action.type)) return
    store.commit('todo/stampLocalWrite')
  }
})

// Y4 (sync-coverage-2): fan the synced settings blob's repeatDefaultSettings into the live
// repeatSettings module whenever the blob changes (inbound sync via settings/updateExternal,
// cross-window storage sync, DB-mirror restore all land on settings/updateSettings). One-way:
// updateFromBlob never re-commits to settings, so there is no loop.
store.subscribe(mutation => {
  // wave2 P2 (2026-09-23): settings/restore is an inbound blob path too (backup restore), but the
  // fan-out below only matched settings/updateSettings — after a restore the repeatSettings module
  // and the tours LS cache kept their PRE-restore values, and the next repeatSettings/updateSettings
  // re-committed the stale whole package over the freshly restored blob. For restore the payload is
  // the RAW saved blob; the mutation has already merged it with defaults, so fan out from the
  // EFFECTIVE live state instead.
  const isRestore = mutation.type === 'settings/restore'
  if (!((mutation.type === 'settings/updateSettings' && mutation.payload) || isRestore)) return
  const blob = isRestore ? store.state.settings : mutation.payload
  if ('repeatDefaultSettings' in blob) {
    store.commit('repeatSettings/updateFromBlob', blob.repeatDefaultSettings)
  }
  // Y6: blob → LS write-through for the tours ledger (LS is the synchronous read cache of
  // utils/onboardingTours.js). Merge per-key max so a stale whole-package echo can't unsee a tour.
  if (blob.onboardingToursSeen && typeof blob.onboardingToursSeen === 'object') {
    try {
      const cur = JSON.parse(localStorage.getItem('onboardingToursSeen') || '{}')
      for (const [k, v] of Object.entries(blob.onboardingToursSeen)) {
        if (!(k in cur) || (Number(v) || 0) > (Number(cur[k]) || 0)) cur[k] = v
      }
      localStorage.setItem('onboardingToursSeen', JSON.stringify(cur))
    } catch (e) { /* stub host without LS */ }
  }
  // wave2 P2: restore is the one inbound path that still skipped the tomato duration mirror —
  // the backup blob can carry durations different from the running tomato ledger, and the live
  // countdown (tomato tick) stayed on stale values until restart. Same sink as update/initFromDb.
  if (isRestore) {
    const tp = tomatoLedgerPatch(blob)
    if (Object.keys(tp).length) store.commit('tomato/patch', tp, { root: true })
  }
})
// Y4 first-run seed: the blob field starts empty — adopt the LS-loaded defaults so existing users
// are mirrored once, after which the blob is authoritative on every change.
try {
  if (!Object.keys(store.state.settings.repeatDefaultSettings || {}).length && Object.keys(store.state.repeatSettings || {}).length) {
    store.commit('settings/updateSettings', { repeatDefaultSettings: { ...store.state.repeatSettings } })
  }
} catch (e) { /* isolated unit-test stores may lack one side */ }

// Cross-window tomatoState sync uniformly goes through main.js's storage listener → tomato/syncFromStorage (with normalization);
// no duplicate listener here (double listeners would parse twice and bypass syncFromStorage's normalization with a direct Object.assign)

export default store
