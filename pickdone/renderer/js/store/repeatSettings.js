import { safeSet } from '../utils/core.js'
/** Repeat settings (repeatSettingsV2 field naming aligned with the project baseline)
 *  Y4 (sync-coverage-2): the defaults map now also rides the synced settings blob as the single
 *  JSON field `repeatDefaultSettings`, so it syncs field-granular via the settings_rows bridge.
 *  localStorage 'repeatSettingsV2State' stays as a write-through cache (seed source for existing users). */
import { REPEAT_DEFAULTS } from '../utils/repeat.js'

const LS = 'repeatSettingsV2State'
/** [W22 P2 key-level whitelist] the module's schema: EXACTLY the keys REPEAT_DEFAULTS declares.
 *  Every inbound boundary (LS load, synced-blob adopt) filters through this set — before the
 *  whitelist, load()/updateFromBlob Object.assigned ANY key found in the LS cache / settings blob,
 *  so junk or foreign keys (habits-family fields, schemaV, future/renamed keys from another build)
 *  seated in live state, were re-committed into settings.repeatDefaultSettings by updateSettings,
 *  and rode persist()/mirrorBlob into LS + db.settingsState + backup exports (the same
 *  pollution vector settings-schema's F-C2 DEFAULT_SETTINGS whitelist closed at the settings
 *  top level — this is the nested-object twin). Single source: keys(shared/repeat-core.mjs
 *  REPEAT_DEFAULTS); a key added there is automatically legal, everything else is dropped. */
export const REPEAT_DEFAULT_SETTINGS = Object.freeze({ ...REPEAT_DEFAULTS })

/** [W22 P2] key-level whitelist filter (pure): keep only declared keys, drop undefined values
 *  (an explicit undefined is junk, not "reset" — the module state is defaults-backed). */
export function sanitizeRepeatDefaults (v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out = {}
  for (const k of Object.keys(v)) {
    if (!(k in REPEAT_DEFAULT_SETTINGS)) continue
    if (v[k] === undefined) continue
    out[k] = v[k]
  }
  return out
}

function load () {
  try {
    // [W22 P2] whitelist before merge: unknown keys in the LS cache never enter state
    return Object.assign({}, REPEAT_DEFAULTS, sanitizeRepeatDefaults(JSON.parse(localStorage.getItem(LS) || '{}')))
  } catch { return { ...REPEAT_DEFAULTS } }
}
export default {
  namespaced: true,
  state: () => load(),
  mutations: {
    /** User change: local state + LS cache + mirror into the synced settings blob. */
    updateSettings (s, p) {
      Object.assign(s, p)
      safeSet(LS, JSON.stringify(s))
      try { this.commit('settings/updateSettings', { repeatDefaultSettings: { ...s } }) } catch (e) { /* root store unavailable in isolated unit tests */ }
    },
    /** Inbound: the settings blob changed (sync / cross-window / DB mirror restore). One-way adopt,
     *  never re-commits to settings — the store/index.js subscription routes blob → here.
     *  [W22 P2] key-level whitelist: only REPEAT_DEFAULT-declared keys are adopted, so a polluted
     *  synced blob can not seat junk in live state or the LS write-through cache. */
    updateFromBlob (s, blob) {
      if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return
      Object.assign(s, sanitizeRepeatDefaults(blob))
      safeSet(LS, JSON.stringify(s))
    }
  }
}
