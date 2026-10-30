import { commit as commitCommand } from "../utils/commandBus.js"
/** Saved filters (smart lists) — condition sets persisted in the local DB filters table, entered via the sidebar group */

/** [D18-DOM3] Pure duplicate-name check for FilterModal.save: true when ANOTHER filter (different
 *  id) already carries the same trimmed name. Names are compared trimmed; ids compared via String()
 *  [W8 fix] so a numeric DB id never forks from a string route param — the old strict `!==` let a
 *  filter "rename itself" fail with duplicate-name when the caller passed the id in the other type
 *  (e.g. the row id is the number 5 but the modal hands back "5" from the route). */
export function filterNameTaken (list, name, exceptId) {
  const n = String(name || '').trim()
  if (!n) return false
  return (list || []).some(f => f && String(f.id) !== String(exceptId) && String(f.name || '').trim() === n)
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
    async remove ({ commit, state }, id) {
      await commitCommand("filter", "delete", id)
      // [d-wave 2026-10-14] Same discipline as the save() refetch (d21-A7): the delete has landed,
      // so a failed filterList read must NOT reject the whole action — callers saw a spurious
      // failure while a stale (still-containing) list lingered in the sidebar. On refetch failure
      // keep the local removal optimistic and still resolve.
      try {
        commit('setList', await window.todoAPI.dbCall('filterList'))
      } catch (e) {
        console.error('[filters] post-remove refetch failed (delete stands, keeping local removal):', e)
        commit('setList', (state.list || []).filter(f => f && f.id !== id))
      }
    }
  }
}
