import { commit as commitCommand } from "../utils/commandBus.js"
/** Saved filters (smart lists) — condition sets persisted in the local DB filters table, entered via the sidebar group */

/** [D18-DOM3] Pure duplicate-name check for FilterModal.save: true when ANOTHER filter (different
 *  id) already carries the same trimmed name. Names are compared trimmed; ids compared loosely so
 *  numeric ids from the DB never fork from string route params. */
export function filterNameTaken (list, name, exceptId) {
  const n = String(name || '').trim()
  if (!n) return false
  return (list || []).some(f => f && f.id !== exceptId && String(f.name || '').trim() === n)
}
export default {
  namespaced: true,
  state: () => ({ list: [] }),
  mutations: {
    setList (s, l) { s.list = l || [] }
  },
  actions: {
    async load ({ commit }) {
      try { commit('setList', await window.todoAPI.dbCall('filterList')) } catch (e) { console.error('[filters] load', e) }
    },
    /** Backfill the list after create/update; returns the id for another-wise-successful write */
    async save ({ commit }, f) {
      const id = await commitCommand("filter", "put", f)
      // [d21-A7] the refetch runs in its OWN try: a successful commit followed by a failed
      // filterList read used to reject the whole action — callers reported total failure while
      // the write had landed, and a user retry then hit the duplicate-name guard. On refetch
      // failure keep the optimistic list and still resolve with the id (success).
      try {
        const list = await window.todoAPI.dbCall('filterList')
        commit('setList', list)
      } catch (e) { console.error('[filters] post-save refetch failed (write stands):', e) }
      return id
    },
    async remove ({ commit }, id) {
      await commitCommand("filter", "delete", id)
      commit('setList', await window.todoAPI.dbCall('filterList'))
    }
  }
}
