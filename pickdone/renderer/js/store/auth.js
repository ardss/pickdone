/** Auth module (offline local profile; API signature aligned with the project baseline) */
import { loadLocalUser , safeSet } from '../utils/core.js'

export default {
  namespaced: true,
  state: () => ({ user: loadLocalUser(), loggedIn: true, lastLoginRecord: { method: 1, value: 'offline@local' } }),
  mutations: {
    setUser (state, u) { state.user = u; safeSet('user', JSON.stringify(u)) },
    patchUser (state, patch) {
      state.user = { ...state.user, ...patch }
      safeSet('user', JSON.stringify(state.user))
    },
    setLastLoginRecord (state, r) { state.lastLoginRecord = r; safeSet('lastLoginRecord', JSON.stringify(r)) },
    logout (state) { state.loggedIn = false }
  },
  actions: {
    // When cloud is wired up later: replace with real calls like api.loginByAccount(...)
    async loginByAccount (_, { account }) {
      return new Promise(res => setTimeout(() => res({ ok: true, account }), 200))
    },
    async saveSnowGain ({ commit, state }, gain) {
      const snow = (state.user.snow || 0) + gain
      const tomatoGain = (state.user.tomatoGain || 0) + Math.max(0, gain)
      commit('patchUser', { snow, tomatoGain })
    }
  }
}
