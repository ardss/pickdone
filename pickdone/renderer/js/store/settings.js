import { safeSet } from '../utils/core.js'
import { isAuxWindow } from '../utils/auxWindow.js'
// P2-3 (maint/dw 2026-09-23): the seeded shortcut map is the SHARED factory table (same module
// src/main/config-store.js reads) — the hand-copied literal here could drift from main's defaults.
import { DEFAULT_SHORTCUTS } from '../../../shared/shortcut-defaults.mjs'
/** Settings module — the full field set matches the reference settingsState */
const LS_KEY = 'settingsState'

// Pure schema + helpers live in settings-schema.js (size-ratchet split); the store
// imports what it uses and re-exports everything so consumer imports stay stable.
import {
  SETTINGS_SCHEMA_V, DEFAULT_SETTINGS, coerceNumericSettings,
  sanitizeSettingsPatch as _sanitizeSettingsPatchBase,
  isLegalAppLocale, clampNumericSettings,
  mergeTourMap, canonicalJson, MAIN_CONSUMED_SETTINGS, mainConsumedSettingsDiff,
  tomatoLedgerPatch,
} from './settings-schema.js'
// [W22 P2] the nested repeatDefaultSettings whitelist lives beside its schema (store/repeatSettings.js)
import { sanitizeRepeatDefaults } from './repeatSettings.js'
/** [W22 P2] sanitizeSettingsPatch with the nested-object whitelist added. The base sanitizer
 *  (settings-schema.js) treats repeatDefaultSettings as a declared OBJECT key, so any object
 *  passed type-checking — and its keys were then adopted verbatim (bare object passthrough), the
 *  exact bypass the F-C2 DEFAULT_SETTINGS whitelist closed at the settings TOP level. This wrapper
 *  applies the twin key-level whitelist (repeatSettings.js sanitizeRepeatDefaults) to the nested
 *  map, so unknown keys entering via ANY inbound trust boundary (updateExternal LAN/CLI patches,
 *  restore backup blobs) never reach live state, LS, db.settingsState or backup exports. */
export function sanitizeSettingsPatch (patch, current) {
  const clean = _sanitizeSettingsPatchBase(patch, current)
  if (clean.repeatDefaultSettings !== undefined) {
    clean.repeatDefaultSettings = sanitizeRepeatDefaults(clean.repeatDefaultSettings)
  }
  return clean
}
export {
  SETTINGS_SCHEMA_V, DEFAULT_SETTINGS, SETTING_ENUMS, coerceNumericSettings,
  SETTING_RANGES, isLegalAppLocale, clampNumericSettings,
  mergeTourMap, canonicalJson, MAIN_CONSUMED_SETTINGS, mainConsumedSettingsDiff,
  TOMATO_LEDGER_KEYS, tomatoLedgerPatch,
} from './settings-schema.js'
// restore's secret carve-out reads SECRET_KEYS directly (the sanitize copy lives in the schema module)
import { SECRET_KEYS } from '../../../shared/settings-manifest.mjs'

function load () {
  // Corrupted-JSON fallback: this module executes at top level; a throw = the whole store chain's import fails and white-screens; falling back to {} lets the DB restore path (initFromDb) take over
  let raw = {}
  try { raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {} } catch (e) { raw = {} }
  if (typeof raw !== 'object' || Array.isArray(raw)) raw = {}
  // Format-version tolerance: old unstamped data treated as v1 (behavior unchanged); higher versions left for future upgrade logic
  const merged = { ...DEFAULT_SETTINGS, ...raw }
  // shortcutKeySettings now references the SHARED factory object (shared/shortcut-defaults.mjs):
  // clone it per store instance so mutating live state can never corrupt the shared default.
  if (merged.shortcutKeySettings === DEFAULT_SETTINGS.shortcutKeySettings) merged.shortcutKeySettings = { ...DEFAULT_SHORTCUTS }
  // Strip volatile keys already migrated to runtimeState (leftovers in old localStorage)
  delete merged.autoBackupLastAt; delete merged.tomatoRecordAddCount; delete merged.tomatoRecordAddDate
  coerceNumericSettings(merged)
  // maint-d7: legacy tomatoTimeDefault/restTimeDefault carried the real user values while the live
  // keys tomatoTime/restTime were undeclared (stripped by inbound-sync sanitization). Migrate the
  // old values into the new keys (new key absent from the blob = untouched default) and delete the
  // legacy keys — read-only compat: a blob that still carries them re-migrates on the next load.
  for (const [legacy, live] of [['tomatoTimeDefault', 'tomatoTime'], ['restTimeDefault', 'restTime']]) {
    if (raw[live] == null && raw[legacy] != null) {
      const n = Number(raw[legacy])
      if (Number.isFinite(n) && n > 0) merged[live] = n
    }
    delete merged[legacy]
  }
  // No existing users pre-release: the legacy enum normalization table (LEGACY) was removed together with the old compat code
  // Completed groups folded by default (finalized by users 2026-08-30). Old users' saves with foldedTodoList=[] would override the new default,
  // so a one-time migration backfills it; afterwards the user's manual expand/collapse wins (removal from the list counts as expressed intent, no re-backfill).
  if (merged.doneGroupsFoldMigrated !== true) {
    merged.foldedTodoList = Array.from(new Set([...(merged.foldedTodoList || []), 'today-done', 'day-done']))
    merged.doneGroupsFoldMigrated = true
  }
  // Y1/Y3 first-run seeding: the blob fields start at defaults; adopt legacy localStorage values so
  // existing users keep their locale / collapsed sidebar (blob fields win from then on).
  if (merged.appLocale === DEFAULT_SETTINGS.appLocale) {
    try { const ls = localStorage.getItem('appLocale'); if (ls) merged.appLocale = ls } catch (e) { /* empty */ }
  }
  if (merged.sidebarCollapsed === false) {
    try { if (localStorage.getItem('sidebarCollapsed') === 'true') merged.sidebarCollapsed = true } catch (e) { /* empty */ }
  }
  return merged
}

let saveTimer = null
let mirrorTimer = null
const MIRROR_AT_KEY = 'settingsMirrorAt'
/** Live module state reference for the quit-flush hook (persist is only ever called with this module's state) */
let liveState = null
/** Synchronous LS write (shared by the debounce timer and the quit flush) */
function writeLsBlob (state) {
  safeSet(LS_KEY, JSON.stringify({ ...state, schemaV: SETTINGS_SCHEMA_V }))
  try { localStorage.setItem(MIRROR_AT_KEY, String(Date.now())) } catch (e) { /* empty */ }
}
function mirrorBlob (state) {
  return { ...state, _savedAt: Date.now(), schemaV: SETTINGS_SCHEMA_V }
}
function canMirrorDb () {
  // Float/quick-add windows don't write the DB directly (todo-db:call is main-window-only; would spam forbidden errors):
  // aux windows write LS only; after main-window storage sync the main window persists
  // (review P3 2026-09-22: detection centralized in utils/auxWindow.js)
  return typeof window !== 'undefined' && window.location && !isAuxWindow()
}
function persist (state) {
  liveState = state
  state._lsAt = Date.now() // Write order: stamped at apply time; storage sync drops stale packets by this
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => writeLsBlob(state), 150)
  // Mirror into SQLite meta: settings are user configuration assets, no longer lost when LS is cleared (2s debounce)
  clearTimeout(mirrorTimer)
  mirrorTimer = setTimeout(() => {
    // Node unit-test environment has no window.location (debounce timers still fire after tests end, once blew up with uncaughtException)
    if (!canMirrorDb()) return
    mirrorToDb('db.settingsState', mirrorBlob(state))
  }, 2000)
}

import { mirrorToDb, restoreFromDb, DB_MIRROR_ERROR, consumeUnflushed, isOwnMirrorStamp } from '../utils/dbMirror.js'

// P1 (D5 2026-09-20) quit-flush: direct `commit('settings/updateSettings')` paths (component shortcuts,
// CLI-watcher apply, LAN-sync) bypass the `settings/update` action, and both the 150ms LS timer and the
// 2s mirror timer can still be pending when the app quits — the last ≤2s of setting changes were lost.
// This hook runs AFTER dbMirror's own quit hook (import order registers dbMirror first), so the
// immediate mirrorToDb write lands into a drained pending set and is handed to the bridge synchronously.
if (typeof window !== 'undefined' && window.todoAPI && window.todoAPI.onAppQuittingFlush) {
  window.todoAPI.onAppQuittingFlush(() => {
    if (!liveState) return
    writeLsBlob(liveState)
    if (canMirrorDb()) mirrorToDb('db.settingsState', mirrorBlob(liveState), true)
  })
}
function mirrorTomatoLedger (commit, patch) {
  const tp = tomatoLedgerPatch(patch)
  if (Object.keys(tp).length) commit('tomato/patch', tp, { root: true })
}

export default {
  namespaced: true,
  state: load(),
  getters: {},
  mutations: {
    updateSettings (state, patch) {
      const prevLocale = state.appLocale
      Object.assign(state, patch)
      persist(state)
      // D2-LOC (2026-10-22 round-2 journey audit): this mutation is the BOOT channel — main.js
      // bootstrap's dual-channel fallback ("restore known keys from config.json when localStorage
      // was cleared") lands here — and it was a bare assign+persist: a config-carried appLocale
      // reached the store while LS (i18n's boot cache) and i18n.global.locale stayed stale, so the
      // UI booted in the old language (live-proven: config 'en-US' + store 'en-US' + LS null +
      // $i18n 'zh-CN' in one boot dump). Same contract as restore()'s F9 block: enum-gated,
      // changed-only, fire-and-forget; the update action's Y1 path and setAppLocale IPC stay.
      const loc = state.appLocale
      if (isLegalAppLocale(loc) && loc !== prevLocale) {
        try { localStorage.setItem('appLocale', loc) } catch (e) { /* empty */ }
        import('../i18n/index.js').then(m => {
          if (m && m.setLocale && typeof document !== 'undefined') m.setLocale(loc)
          else if (m && m.default && m.default.global) m.default.global.locale = loc
        }).catch(() => { /* degraded host (tests / stub env) must not break the write */ })
      }
    },
    restore (state, saved) {
      const prevLocale = state.appLocale
      // [restore-sanitize fix] the backup blob is an untrusted input (old dump / tampered file):
      // merge it through sanitizeSettingsPatch like every other trust boundary — unknown-key drop,
      // type-junk drop, null-tombstone-to-default, enum gates — instead of a bare coerce/clamp that
      // let deprecated/junk keys land verbatim in live state, LS and the db mirror. The sanitizer
      // ends with clampNumericSettings and its numeric-string branch covers coerceNumericSettings.
      const merged = sanitizeSettingsPatch({ ...DEFAULT_SETTINGS, ...(saved || {}) }, state)
      // C3 carve-out: restore is the user's own explicit backup import, not a peer push. The
      // secret keys the sanitizer strips on inbound sync paths are the backup's real values and
      // must survive here — maint-d7 pushes securityLockPassword through the main-consumed diff so
      // the lock survives a machine change; dropping it in restore would silently disable the lock.
      for (const k of Object.keys(saved || {})) {
        if ((SECRET_KEYS.includes(k) || /^securityLock/.test(k)) && typeof saved[k] === typeof DEFAULT_SETTINGS[k]) merged[k] = saved[k]
      }
      // Secret keys absent from the blob get their declared defaults back, so the defaults backstop
      // still seats them in state (a defaults-only restore must not leave them undefined).
      for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if ((SECRET_KEYS.includes(k) || /^securityLock/.test(k)) && !(k in merged)) merged[k] = DEFAULT_SETTINGS[k]
      }
      if (merged.shortcutKeySettings === DEFAULT_SETTINGS.shortcutKeySettings) merged.shortcutKeySettings = { ...DEFAULT_SHORTCUTS }
      // appLocale write-back race (2026-09-26 check:all confirmed red): a DB blob whose appLocale is
      // still the untouched default ('zh-CN') must not clobber an LS-forced boot locale. load() already
      // adopts LS in exactly this case (see the Y1/Y3 seeding above, merged.appLocale === default →
      // adopt localStorage); restore happening a beat AFTER boot was missing the same adoption, so on a
      // fresh/isolated instance it wrote 'zh-CN' back over LS 'appLocale'='en-US' and hot-flipped the UI
      // to zh mid-session (ui-smoke's 'Todo box' highlight + 'Time blocks' text assertions failed on it).
      // Same rule, same precedence: blob==default → LS wins. An explicitly chosen locale writes BOTH
      // stores (setLocale / update action), so a real user's explicit choice is never overridden here.
      if (merged.appLocale === DEFAULT_SETTINGS.appLocale) {
        try { const ls = localStorage.getItem('appLocale'); if (ls) merged.appLocale = ls } catch (e) { /* empty */ }
      }
      Object.assign(state, merged)
      persist(state)
      // maint-d7: restore used to be a bare Object.assign+persist — no `settings/update` action, so
      // no updateSettings IPC and main's config.json-consumed keys (launch-at-startup, shortcuts,
      // locale, security lock...) were silently reverted by the restored (older) values. Diff the
      // main-consumed keys against defaults and push the changed ones through the SAME IPC channel
      // the update action uses; main's per-sender stripForbiddenSettingsKeys accepts these from the
      // main window. Best-effort: a degraded host (tests, no bridge) must not break the restore.
      try {
        const diff = mainConsumedSettingsDiff(state)
        if (Object.keys(diff).length && typeof window !== 'undefined' && window.todoAPI && window.todoAPI.updateSettings) {
          window.todoAPI.updateSettings(diff)
        }
      } catch (e) { console.error('[settings] restore: main-process settings sync failed:', e) }
      // F9 (2026-09-24): the main-consumed diff above pushed appLocale to MAIN's config.json, but
      // the RENDERER side stayed on the old locale until restart — LS 'appLocale' (i18n's boot
      // cache) and i18n.global.locale are only written by the `update` action's locale path
      // (SettingsModal/Onboarding setLocale). Reuse that same path on restore: LS write-through +
      // hot-apply, only when the restored blob actually changes the locale. Fire-and-forget like
      // the update action: a degraded host (no i18n module) must not break the restore.
      const loc = state.appLocale
      // [restore-locale-enum fix] same SETTINGS_MANIFEST.enum gate the sanitizer applies on other
      // trust-boundary paths (the sanitizer above already drops junk locales, but the LS adoption
      // branch can still seat a stale/junk LS value): a junk locale string must neither flip i18n
      // nor reach the LS boot cache. (W7-R: routed through the shared isLegalAppLocale helper.)
      if (isLegalAppLocale(loc) && loc !== prevLocale) {        try { localStorage.setItem('appLocale', loc) } catch (e) { /* empty */ }
        import('../i18n/index.js').then(m => {
          if (m && m.setLocale && typeof document !== 'undefined') m.setLocale(loc)
          else if (m && m.default && m.default.global) m.default.global.locale = loc
        }).catch(e => { console.error('[settings] restore: locale hot-apply failed:', e) })
      }
    }
  },
  actions: {
    async update ({ commit }, patch) {
      // [W7-R P3 locale-enum-gate] a junk appLocale is rejected at the action boundary: stripped
      // before the commit (never seats in state / LS / config.json) and the Y1 hot-apply block
      // below never sees it. Same SETTINGS_MANIFEST.enum.appLocale gate as the mutation's boot
      // channel and restore()'s adoption branch (shared isLegalAppLocale helper).
      let effective = patch
      if (patch && patch.appLocale !== undefined && !isLegalAppLocale(patch.appLocale)) {
        console.warn('[settings] update: illegal appLocale rejected:', patch.appLocale)
        effective = { ...patch }
        delete effective.appLocale
      }
      commit('updateSettings', effective)
      // P1-1: mirror duration keys into the tomato runtime ledger (all inbound paths converge here —
      // updateExternal re-dispatches through this action; see tomatoLedgerPatch above).
      mirrorTomatoLedger(commit, effective)
      // Y1: locale hot-apply — mirror the local-change path (main handlers/settings.js 'set-app-locale'):
      // main-process i18n + tray rebuild. LS 'appLocale' stays as i18n's boot cache (write-through).
      if (isLegalAppLocale(effective && effective.appLocale)) {
        const loc = effective.appLocale
        try { localStorage.setItem('appLocale', loc) } catch (e) { /* empty */ }
        try {
          const i18nMod = await import('../i18n/index.js')
          if (i18nMod.default && i18nMod.default.global) i18nMod.default.global.locale = loc
        } catch (e) { /* i18n unavailable in degraded hosts */ }
        try { if (window.todoAPI && window.todoAPI.setAppLocale) window.todoAPI.setAppLocale(loc) } catch (e) { /* empty */ }
      }
      // P2-2 (maint/dw 2026-09-23): the IPC result is now REPORTED instead of swallowed — the
      // shortcuts tab awaits it and must not show "saved" (nor advance its dirty snapshot) when
      // config.json was not written. A missing bridge (tests / browser host) counts as ok.
      if (typeof window !== 'undefined' && window.todoAPI && window.todoAPI.updateSettings) {
        try { await window.todoAPI.updateSettings(effective) } catch (e) {
          // IPC failure = LS written but config.json not; next launch config would overwrite it back (settings changed during lock → lost on restart): at least leave a trace
          console.error('[settings] updateSettings IPC failed, patch may be reverted on next launch:', patch, e)
          return { ok: false, error: e }
        }
      }
      return { ok: true }
    },
    /** P1-3: inbound patch from a trust boundary (CLI watcher / LAN-sync applied settings rows).
     *  Sanitized via sanitizeSettingsPatch (same coercion/validation family as restore()), then
     *  re-dispatched through the normal update action so LS/config.json/shortcuts stay in sync.
     *  Y6: the onboardingToursSeen ledger merges per-key max on inbound (never whole-doc clobber) —
     *  a peer seeing tour "pips" must not erase this device's other seen entries. Local writes
     *  (resetToursSeen) still replace wholesale because they bypass this merge. */
    async updateExternal ({ state, dispatch }, payload, maybeOrigin) {
      // [J-audit P2 fix 2026-10-22] Echo suppression: the CLI watcher hot-applies db.settingsState
      // changes, but the renderer's OWN debounced mirror lands in that same channel — and its
      // two-layer debounce (persist 2s + dbMirror 2s) lets a STALE generation land AFTER a newer
      // user write, which the watcher then hot-applies over it (measured: 专注时长 5→10 double
      // write bounced store/LS/UI/config back to 5 at +4.3s). A patch whose origin _savedAt is
      // covered by this window's own mirror watermark is our own echo, not an external change.
      // Callers without an origin (LAN sync, DB restore re-dispatch) are unaffected; aux windows
      // never mirror, so their watermark stays empty and every patch applies.
      // PAYLOAD SHAPE: store.dispatch() only forwards (type, payload, options) — a bare third arg
      // is dropped as Vuex options (the v1 of this fix died exactly there: suppression inert in
      // the real app while the direct-call unit test passed). In-app callers pack
      // { patch, originSavedAt }; legacy/plain callers (LAN sync, DB restore, unit tests) pass a
      // bare patch and the optional direct-call origin still works.
      const packed = payload && typeof payload === 'object' && !Array.isArray(payload) && 'patch' in payload
      const patch = packed ? payload.patch : payload
      const originSavedAt = packed ? payload.originSavedAt : maybeOrigin
      if (originSavedAt && isOwnMirrorStamp('db.settingsState', originSavedAt)) return
      if (!patch) return
      const clean = sanitizeSettingsPatch(patch, state) // U3: live state is the merge base for partial object fields
      if (clean.onboardingToursSeen && typeof clean.onboardingToursSeen === 'object' && !Array.isArray(clean.onboardingToursSeen)) {
        clean.onboardingToursSeen = mergeTourMap(state.onboardingToursSeen, clean.onboardingToursSeen)
      }
      if (Object.keys(clean).length) await dispatch('update', clean)
    },
    // On startup judge newness by timestamp: if the DB mirror is newer than LS (e.g. LS cleared / machine change) → restore key-level from DB wholesale; otherwise flush current values back to the DB
    // U5: the seed/restore of main-consumed fields (shortcutKeySettings, appLocale) is dispatched
    // through the `update` action (not a raw commit), so main's updateSettings IPC fires and the
    // shortcuts are hot re-registered from the synced map — the renderer and main-process no longer
    // disagree until restart. Equality checks use canonicalJson (key-order-insensitive).
    async initFromDb ({ state, commit, dispatch }) {
      // Y2 first-run seeding: if the blob still carries the untouched default shortcut map, adopt the
      // machine's real config.json values (read via the existing get-settings IPC). Seeding runs BEFORE
      // the DB-mirror restore so an already-synced blob value always wins over local config.
      try {
        const def = DEFAULT_SETTINGS.shortcutKeySettings
        const isDefault = canonicalJson(state.shortcutKeySettings) === canonicalJson(def)
        if (isDefault && window.todoAPI && window.todoAPI.getSettings) {
          const cfg = await window.todoAPI.getSettings()
          if (cfg && cfg.shortcutKeySettings && typeof cfg.shortcutKeySettings === 'object' &&
              canonicalJson(cfg.shortcutKeySettings) !== canonicalJson(def)) {
            await dispatch('update', { shortcutKeySettings: { ...def, ...cfg.shortcutKeySettings } })
          }
        }
      } catch (e) { /* degraded host: keep defaults */ }
      // [D13 #12] unflushed-mirror parking: the previous session gave up mirroring this key after
      // its retry budget — the LS copy is NEWER than whatever reached the DB. DB-precedence
      // assumes the mirror actually landed; when it provably did not, prefer LS (already live in
      // state) and re-mirror it with a fresh retry budget instead of letting the stale DB blob
      // drown it. The marker is consumed (cleared) here; a landed write retires it (dbMirror).
      const parked = consumeUnflushed('db.settingsState')
      if (parked && parked.blob) {
        mirrorToDb('db.settingsState', { ...state, _savedAt: Date.now(), schemaV: SETTINGS_SCHEMA_V })
        return
      }
      const db = await restoreFromDb('db.settingsState')
      // F-C4: a READ ERROR (bridge present but getMeta rejected / blob unparseable) is NOT "no
      // mirror" — the old code fell through to the mirrorToDb below and drowned a possibly newer
      // DB copy under the in-memory defaults. On error: warn and leave both sides untouched.
      if (db === DB_MIRROR_ERROR) {
        console.warn('[settings] initFromDb: DB mirror read failed this startup — skipping both the restore and the write-back so the DB copy is preserved')
        return
      }
      let lsAt = 0
      try { lsAt = Number(localStorage.getItem(MIRROR_AT_KEY) || 0) } catch (e) { /* empty */ }
      // D13 finding 15 (two-part fix):
      // (a) ties resolve in DB's favor (`<`, not `<=`): an equal stamp makes the DB branch a
      //     canonical no-op or an honest restore, never a stale-LS write-back.
      // (b) when the write-back branch runs while a DB blob exists, the mirrored doc carries the
      //     PRIOR db._savedAt instead of a fresh now(): that stamp is the BRIDGE GATE the
      //     db-sync-schema setMeta mirror reads (gateTs = _savedAt), so putRow can still skip
      //     settings_rows newer than the pre-write-back snapshot instead of re-aging
      //     peer-applied rows to now (a crash between sync-apply and the next persist used to
      //     drown the peer's edit with gateTs=now, which skips nothing).
      const priorStamp = (db && typeof db === 'object') ? Number(db._savedAt) : NaN
      if (!db || typeof db !== 'object' || (db._savedAt || 0) < lsAt) {
        // 2026-10-09 P3: the write-back's stamp must advance WITH its content. This branch writes
        // the NEWER LS values (snapshot age = lsAt) but used to stamp them with the OLD db._savedAt
        // — content newer than its own watermark, so a peer blob arriving in the gap between
        // priorStamp and the write-back could arbitrate "newer than the doc" and compress over the
        // local settings. Gate on the content's ACTUAL age (lsAt; the LS persist stamp the branch
        // is conditioned on): stamp >= every peer row the LS snapshot already supersedes, while
        // rows written AFTER that snapshot still win putRow's gate — the anti-re-age semantics
        // finding 15 protects are preserved (we no longer fake a now() stamp, we use the real
        // snapshot time). Only a machine with no LS stamp at all falls back to now().
        const gateStamp = lsAt > 0
          ? lsAt
          : (Number.isFinite(priorStamp) && priorStamp > 0 ? priorStamp : Date.now())
        mirrorToDb('db.settingsState', { ...state, _savedAt: gateStamp, schemaV: SETTINGS_SCHEMA_V })
        return
      }
      // Downgrade protection: reject import when the DB mirror's schemaV is higher than the version this code supports (prevents "new config poured into old code" misreads), same semantics as dbRecovery.parseSegment;
      // and don't write the mirror back — a write-back would wash away the future version's mirror data, left for the upgraded version to consume
      if ((db.schemaV || 1) > SETTINGS_SCHEMA_V) return
      const patch = {}
      for (const k of Object.keys(db)) {
        if (k === '_savedAt') continue
      // F-C2 (maint/dw wave3): DEFAULT_SETTINGS whitelist — the old loop adopted EVERY db key
      // (only skipping _savedAt), so a polluted mirror blob (habits-family keys such as
      // schemaV/habits/moments riding db.settingsState) landed verbatim in the live settings
      // state and was then re-persisted by persist()/mirrorBlob to LS + DB + backup exports.
      // Same unknown-key policy as sanitizeSettingsPatch. The habits-family field SET is domain2's
      // shared/settings-families.mjs (HABITS_EXCLUSIVE_FIELDS — landed 82fb2e95, no longer a
      // wave4 TODO); the whitelist makes those keys unreachable here, and a unit test pins that
      // the family can never re-enter DEFAULT_SETTINGS (single-source drift guard).
      if (!(k in DEFAULT_SETTINGS)) continue
        // D14-B6 (2026-10-01): onboardingToursSeen obeys the Y6 per-key merge contract on EVERY
        // inbound boundary — the key-level restore used to adopt the DB map wholesale, so
        // local-only seen tour keys (tours dismissed on this device but not yet synced to the
        // peer's map) were dropped and the onboarding tour replayed after a restart.
        if (k === 'onboardingToursSeen' && db[k] && typeof db[k] === 'object' && !Array.isArray(db[k])) {
          const merged = mergeTourMap(state.onboardingToursSeen, db[k])
          if (canonicalJson(merged) !== canonicalJson(state[k])) patch[k] = merged
        } else if (canonicalJson(db[k]) !== canonicalJson(state[k])) patch[k] = db[k]
      }
      coerceNumericSettings(patch)
      clampNumericSettings(patch) // F-C3: the DB-mirror restore path is a trust boundary too
      if (Object.keys(patch).length) {
        // F3 (2026-09-21): the config-consumed key set must ALSO ride the `update` action. main's
        // 'notify-settings-updated' writes config.json (the sole source windows.js consumes for
        // closeActionMinimize / hideMainWindowOnStartup / enableSecurityLock / hardware-accel relaunch)
        // and hot-applies runWhenComputerStart via app.setLoginItemSettings — a raw commit updated only
        // the renderer store, so a CLI-written (or LAN-synced) value reverted on next launch while the
        // OS login item never followed. Same rationale as the U5 shortcut/appLocale dispatch above.
        // maint-d7: the key set is shared with restore()'s diff (MAIN_CONSUMED_SETTINGS) so the
        // two paths can never drift apart.
        const needsMainApply = MAIN_CONSUMED_SETTINGS.some(k => k in patch)
        if (needsMainApply) await dispatch('update', patch)
        else { commit('updateSettings', patch); mirrorTomatoLedger(commit, patch) } // P1-1: the raw-commit branch must mirror the tomato ledger too
      } else mirrorToDb('db.settingsState', { ...state, _savedAt: db._savedAt, schemaV: SETTINGS_SCHEMA_V })
    }
  }
}
