/**
 * Window-binding store (win-bind feature, T8 renderer side).
 *
 * State machine (rendererContract):
 *   bindings: { [taskId]: WindowRef }   — hydrated from winBindList at mount, filtered
 *              against the known todo list (orphan bindings of deleted tasks are hidden,
 *              main-process data is never pruned from the renderer)
 *   identifying / activating: taskId|null — in-flight flags for the two async flows
 *   lastFeedback: { taskId, kind, reason? }|null
 *     kind ∈ 'bound'|'bind-failed'|'activated'|'activate-failed'|'unbound'
 *     (cancel paths produce NO feedback — silent, per contract)
 *
 * The single binding entry point is releaseOutside(taskId), dispatched from
 * TodoItem.onDragEnd when the geometry gate says the release happened outside
 * the window. Identify is zero-argument (the main process reads the cursor
 * itself); the identify returnee `window` is passed to bind VERBATIM.
 *
 * Feature-detect: while the preload/main side is absent (window.todoAPI without
 * the winBind* keys — e.g. older host during rollout), every action degrades
 * silently: no IPC, no feedback, no throw. A missing capability is not a failed
 * operation. Once present, rejections are NEVER swallowed (F8 doctrine): the
 * bind flow surfaces them as bind-failed feedback + error toast.
 */
import i18n from '../i18n/index.js'

const t = (key, params) => {
  try { return i18n.global.t(key, params) } catch (e) { return key }
}
/** Toast through the mounted root proxy (main.js assigns window.appUI after bootstrap).
 *  Absent host (unit tests, early boot) degrades silently — lastFeedback still records everything. */
function toast (kind, msg) {
  try {
    const m = window.appUI && window.appUI.$message
    if (m && typeof m[kind] === 'function') m[kind](msg)
  } catch (e) { /* stub host */ }
}
function api () {
  try { return (typeof window !== 'undefined' && window.todoAPI) || null } catch (e) { return null }
}
/** Full win-bind surface present? One missing key = feature off (rollout guard). */
function winBindApi () {
  const a = api()
  // [QA r1 #1] the key surface is preload's (src/preload/index.js winBindIdentify + contracts.d.ts);
  // an "UnderCursor"-suffixed name here made winBindApi() permanently null — every UI action silently off.
  return (a && a.winBindIdentify && a.winBindBind && a.winBindActivate && a.winBindUnbind && a.winBindList) ? a : null
}

/** Session-once hydration guard: every TodoItem row dispatches initFromList on mount; the FIRST
 *  successful pull settles it for the whole renderer session (a failed pull retries on the next
 *  row mount). Module-level (not state) on purpose: the contract state shape is exactly four
 *  fields; a renderer reload (main window rebuild) resets it with the module. */
let hydratedOnce = false

/** [QA r1 #4] Session-once subscription arming: the main process broadcasts 'win-bind-changed'
 *  {reason:'bind'|'unbind', taskId} to ALL windows on every main-side binding mutation, but
 *  nothing consumed it — other windows' badges never refreshed. initFromList arms the
 *  subscription once per renderer session; the callback re-pulls the list (idempotent full
 *  refresh — the originator window's echo just converges to the same truth, no loop). */
let changeSubscribed = false
function armChangeSubscription (a, dispatch) {
  if (changeSubscribed || !a || typeof a.onWinBindChanged !== 'function') return
  try {
    a.onWinBindChanged(() => {
      try { dispatch('refresh') } catch (e) { /* store torn down (window closing) */ }
    })
    changeSubscribed = true
  } catch (e) {
    // subscription itself failed (old preload without the key is filtered by the typeof check;
    // a throw here means a broken bridge — retry on the next row mount)
  }
}

export default {
  namespaced: true,
  state: () => ({
    bindings: {},
    identifying: null,
    activating: null,
    lastFeedback: null
  }),
  mutations: {
    SET_BINDINGS (s, map) { s.bindings = map || {} },
    SET_BINDING (s, { taskId, ref }) { s.bindings = { ...s.bindings, [taskId]: ref } },
    REMOVE_BINDING (s, taskId) {
      if (!(taskId in s.bindings)) return
      const next = { ...s.bindings }
      delete next[taskId]
      s.bindings = next
    },
    PATCH_STATUS (s, { key, value }) {
      if (key === 'identifying' || key === 'activating') s[key] = value
    },
    SET_FEEDBACK (s, fb) { s.lastFeedback = fb }
  },
  actions: {
    /** Pull bindings and keep only tasks the renderer still knows (orphan filtering — main
     *  never GCs deleted tasks' bindings by contract). Shared by hydration and the
     *  win-bind-changed refresh; resolves true on success. */
    async refresh ({ commit, rootState }) {
      const a = winBindApi()
      if (!a) return false
      try {
        const { bindings } = await a.winBindList()
        const known = new Set(((rootState && rootState.todo && rootState.todo.todoList) || []).map(x => x && x.taskId).filter(Boolean))
        const map = {}
        for (const b of bindings || []) {
          if (b && b.taskId && known.has(b.taskId) && b.ref) map[b.taskId] = b.ref
        }
        commit('SET_BINDINGS', map)
        return true
      } catch (e) {
        console.error('[winbind] list failed:', e)
        return false
      }
    },
    /** Mount-time hydration: first successful pull settles the session (failed pulls retry on
     *  the next row mount). Also the single arming point of the win-bind-changed subscription
     *  (armed regardless of hydration outcome — changeSubscribed is its own session-once guard). */
    async initFromList ({ dispatch }) {
      const a = winBindApi()
      if (!a) return
      armChangeSubscription(a, dispatch)
      if (hydratedOnce) return
      if (await dispatch('refresh')) hydratedOnce = true
    },
    /** The ONLY binding entry: called from TodoItem.onDragEnd when the release was
     *  outside the window. window==null (BUTTON_DOWN/NO_WINDOW/DESKTOP/OWN_WINDOW/
     *  ADAPTER_ERROR/TIMEOUT — Esc-outside, desktop, taskbar drops) is a silent cancel. */
    async releaseOutside ({ state, commit }, taskId) {
      const a = winBindApi()
      if (!a || !taskId) return
      commit('PATCH_STATUS', { key: 'identifying', value: taskId })
      try {
        const r = await a.winBindIdentify()
        if (!r || !r.window) return // silent cancel — every null-window reason is user-intent or nothing-to-bind
        const b = await a.winBindBind(taskId, r.window)
        if (b && b.ok) {
          commit('SET_BINDING', { taskId, ref: r.window })
          commit('SET_FEEDBACK', { taskId, kind: 'bound' })
          toast('success', t('statsJ.winbind.bound', { name: r.window.processName || '' }))
        } else {
          const reason = (b && b.reason) || 'BAD_ARGS'
          commit('SET_FEEDBACK', { taskId, kind: 'bind-failed', reason })
          toast('error', t('statsJ.winbind.boundFailed'))
        }
      } catch (e) {
        // rejected identify/bind promise: never swallow silently (F8 doctrine)
        console.error('[winbind] releaseOutside failed:', e)
        commit('SET_FEEDBACK', { taskId, kind: 'bind-failed', reason: 'ADAPTER_ERROR' })
        toast('error', t('statsJ.winbind.identifyFailed'))
      } finally {
        if (state.identifying === taskId) commit('PATCH_STATUS', { key: 'identifying', value: null })
      }
    },
    /** One-click window wake-up. Every failure reason has user-facing copy — none silent. */
    async activate ({ commit }, taskId) {
      const a = winBindApi()
      if (!a || !taskId) return
      commit('PATCH_STATUS', { key: 'activating', value: taskId })
      try {
        const r = await a.winBindActivate(taskId)
        if (r && r.ok) {
          commit('SET_FEEDBACK', { taskId, kind: 'activated' })
          toast('success', t('statsJ.winbind.activated'))
          return
        }
        const reason = (r && r.reason) || 'ACTIVATE_FAILED'
        commit('SET_FEEDBACK', { taskId, kind: 'activate-failed', reason })
        if (reason === 'NOT_FOUND' || reason === 'NO_BINDING') {
          toast('error', t('statsJ.winbind.notFound'))
        } else if (reason === 'AMBIGUOUS') {
          const n = (r.candidates && r.candidates.length) || 0
          toast('error', t('statsJ.winbind.ambiguous', { n }))
        } else if (reason === 'ADAPTER_ERROR') {
          toast('error', t('statsJ.winbind.adapterUnavailable'))
        } else if (r.flashed) {
          // SetForegroundWindow failed but the main process degraded to FlashWindow — honest copy
          toast('warning', t('statsJ.winbind.flashed'))
        } else {
          toast('error', t('statsJ.winbind.activateFailed'))
        }
      } catch (e) {
        console.error('[winbind] activate failed:', e)
        commit('SET_FEEDBACK', { taskId, kind: 'activate-failed', reason: 'ADAPTER_ERROR' })
        toast('error', t('statsJ.winbind.adapterUnavailable'))
      } finally {
        commit('PATCH_STATUS', { key: 'activating', value: null })
      }
    },
    /** Idempotent unbind: main returns {ok:true,removed:false} for unknown taskIds — never an error. */
    async unbind ({ commit }, taskId) {
      const a = winBindApi()
      if (!a || !taskId) return
      try {
        await a.winBindUnbind(taskId)
      } catch (e) {
        console.error('[winbind] unbind failed:', e)
      }
      commit('REMOVE_BINDING', taskId)
      commit('SET_FEEDBACK', { taskId, kind: 'unbound' })
      toast('success', t('statsJ.winbind.unbound'))
    }
  }
}
