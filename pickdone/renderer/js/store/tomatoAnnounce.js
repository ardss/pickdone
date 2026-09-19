/**
 * Remote running-tomato announcements (feature: a focus started on a paired device is
 * visible live here). Display-ONLY: this store never auto-starts, rings, or records.
 *
 * Data flow:
 *   - the focus-running device writes meta `tomatoRunAnnounce.<deviceId>` on start/attach
 *     change/give up/complete (renderer `announceLocal` below) and on quit (main);
 *   - the row syncs via the meta entity (LAN sync); on apply the main process emits a
 *     'tomato-announce' syncEvent, which `init` subscribes to and lands in `remote`;
 *   - on startup `init` also pulls the current snapshot (`tomatoRunAnnounces`).
 * Staleness/self-healing lives in the shared pure helpers (tomatoAnnounceShared.js,
 * unit-tested + contract-mirrored against the main-process copy) — a peer that crashed
 * mid-focus expires by TTL instead of sticking forever.
 */
import { isStaleAnnounce, buildAnnounceValue } from './tomatoAnnounceShared.js'

// P2f (2026-09-19 UX review round 2): when sync is toggled OFF, a still-fresh `remote` announce
// keeps the chip alive with no data path left to clear it. Pull the enabled flag through the same
// lazy dynamic import the sync-tab utils already use (avoids a static cycle at store-load time).
async function syncEnabledNow () {
  try {
    const m = await import('../utils/lanSync.js')
    const s = await m.getSyncSettings()
    return !!s.enabled
  } catch (e) { return true } // cannot ask (CLI/test host): assume enabled, TTL staleness still applies
}

function api () { return (typeof window !== 'undefined' && window.todoAPI) || null }

/** Compose this device's announce payload from the live tomato store state. */
function composeFromTomatoState (tomatoState, status, deviceId, deviceName) {
  const running = status === 'running' && tomatoState.status === 'startTomatoTime' && tomatoState.startedAt
  const attach = running ? tomatoState.attachTodo : null
  return buildAnnounceValue({
    deviceId, deviceName,
    status: running ? 'running' : 'idle',
    startedAt: running ? tomatoState.startedAt : 0,
    plannedSec: running ? (tomatoState.tomatoTime || 25) * 60 : 0,
    attachTodoId: attach ? attach.taskId : null,
    attachTodoTitle: attach ? attach.taskContent : '',
  })
}

export default {
  namespaced: true,
  state: { remote: {}, inited: false },
  getters: {
    /** Valid (non-stale) remote RUNNING announces, newest first — the UI chip source. */
    remoteRunning (s) {
      const now = Date.now()
      return Object.values(s.remote)
        .filter(v => !isStaleAnnounce(v, now))
        .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    },
    /** First running remote (chip renders one compact line; extras stay in the map). */
    primaryRunning (s, g) { return g.remoteRunning[0] || null },
  },
  mutations: {
    /** Land one announce (from a syncEvent or the startup snapshot); stale entries drop. */
    applyRemote (s, v) {
      if (!v || !v.deviceId) return
      if (isStaleAnnounce(v, Date.now())) { delete s.remote[v.deviceId]; return }
      s.remote = { ...s.remote, [v.deviceId]: v }
    },
    /** Periodic prune: expired entries disappear from the chip without a fresh event. */
    prune (s) {
      const now = Date.now()
      const next = {}
      let changed = false
      for (const [id, v] of Object.entries(s.remote)) {
        if (isStaleAnnounce(v, now)) changed = true
        else next[id] = v
      }
      if (changed) s.remote = next
    },
    setInited (s) { s.inited = true },
    /** P2f: sync toggled off — drop every remote announce so the chip cannot outlive its data path. */
    clearRemote (s) { s.remote = {} },
  },
  actions: {
    /** One-time wiring: subscribe to 'tomato-announce' syncEvents + load the snapshot. */
    init ({ commit, dispatch }) {
      const a = api()
      if (!a) return
      if (a.onSyncEvent) {
        a.onSyncEvent(evt => {
          if (evt && evt.type === 'tomato-announce' && evt.deviceId) commit('applyRemote', evt)
        })
      }
      commit('setInited')
      return dispatch('reload')
    },
    /** Pull the current announce snapshot from the main process (startup + manual refresh). */
    async reload ({ commit }) {
      const a = api()
      if (!a || !a.tomatoRunAnnounces) return
      // P2f: sync off = no channel, no chip. Checked at every refresh so a CLI `sync off` (which
      // bypasses the settings-tab toggle) is also covered.
      if (!(await syncEnabledNow())) { commit('clearRemote'); return }
      try {
        const list = await a.tomatoRunAnnounces()
        for (const v of (Array.isArray(list) ? list : [])) commit('applyRemote', v)
      } catch (e) { console.warn('[tomatoAnnounce] reload failed:', e) }
    },
    /**
     * Report the LOCAL focus transition (call from tomato.js store actions). Fire-and-forget:
     * announce failures must never break the focus flow; the peers' TTL rule self-heals.
     */
    announceLocal ({ rootState }, { status }) {
      const a = api()
      if (!a || !a.tomatoRunAnnounce) return
      const tomatoState = (rootState && rootState.tomato) || {}
      try {
        // deviceId/deviceName are composed by the MAIN process (identity lives there);
        // the renderer only contributes the runtime fields.
        a.tomatoRunAnnounce(composeFromTomatoState(tomatoState, status, '', ''))
      } catch (e) { console.warn('[tomatoAnnounce] announce failed:', e) }
    },
  },
}
