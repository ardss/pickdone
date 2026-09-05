import { safeSet } from '../utils/core.js'
/** Repeat settings (repeatSettingsV2 field naming aligned with the project baseline) */
import { REPEAT_DEFAULTS } from '../utils/repeat.js'

const LS = 'repeatSettingsV2State'
function load () {
  try { return Object.assign({}, REPEAT_DEFAULTS, JSON.parse(localStorage.getItem(LS) || '{}')) } catch { return { ...REPEAT_DEFAULTS } }
}
export default {
  namespaced: true,
  state: load(),
  mutations: {
    updateSettings (s, p) {
      Object.assign(s, p)
      safeSet(LS, JSON.stringify(s))
    }
  }
}
