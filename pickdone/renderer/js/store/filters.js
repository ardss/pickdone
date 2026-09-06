/** Saved filters (smart lists) — condition sets persisted in the local DB filters table, entered via the sidebar group */
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
    /** Backfill the list after create/update; returns the id for routing */
    async save ({ commit }, f) {
      const id = await window.todoAPI.dbCall('filterUpsert', f)
      const list = await window.todoAPI.dbCall('filterList')
      commit('setList', list)
      return id
    },
    async remove ({ commit }, id) {
      await window.todoAPI.dbCall('filterDelete', id)
      commit('setList', await window.todoAPI.dbCall('filterList'))
    }
  }
}
