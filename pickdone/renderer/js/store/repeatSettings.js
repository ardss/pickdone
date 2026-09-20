import { safeSet } from '../utils/core.js'
/** Repeat settings (repeatSettingsV2 field naming aligned with the project baseline)
 *  Y4 (sync-coverage-2): the defaults map now also rides the synced settings blob as the single
 *  JSON field `repeatDefaultSettings`, so it syncs field-granular via the settings_rows bridge.
 *  localStorage 'repeatSettingsV2State' stays as a write-through cache (seed source for existing users). */
import { REPEAT_DEFAULTS } from '../utils/repeat.js'

const LS = 'repeatSettingsV2State'
function load () {
  try { return Object.assign({}, REPEAT_DEFAULTS, JSON.parse(localStorage.getItem(LS) || '{}')) } catch { return { ...REPEAT_DEFAULTS } }
}
export default {
  namespaced: true,
  state: load(),
  mutations: {
    /** User change: local state + LS cache + mirror into the synced settings blob. */
    updateSettings (s, p) {
      Object.assign(s, p)
      safeSet(LS, JSON.stringify(s))
      try { this.commit('settings/updateSettings', { repeatDefaultSettings: { ...s } }) } catch (e) { /* root store unavailable in isolated unit tests */ }
    },
    /** Inbound: the settings blob changed (sync / cross-window / DB mirror restore). One-way adopt,
     *  never re-commits to settings — the store/index.js subscription routes blob → here. */
    updateFromBlob (s, blob) {
      if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return
      Object.assign(s, blob)
      safeSet(LS, JSON.stringify(s))
    }
  }
}
