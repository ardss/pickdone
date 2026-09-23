import { safeSet } from '../utils/core.js'
import { isAuxWindow } from '../utils/auxWindow.js'
// P2-3 (maint/dw 2026-09-23): the seeded shortcut map is the SHARED factory table (same module
// src/main/config-store.js reads) — the hand-copied literal here could drift from main's defaults.
import { DEFAULT_SHORTCUTS } from '../../../shared/shortcut-defaults.mjs'
/** Settings module — the full field set matches the reference settingsState */
const LS_KEY = 'settingsState'
/** Persistence blob format version: readers treat old unstamped data as v1 (behavior unchanged); the restore side refuses to import segments >1 (preventing downgrade misreads) */
export const SETTINGS_SCHEMA_V = 1

export const DEFAULT_SETTINGS = {
  foldedTodoList: ['today-done', 'day-done'], // folded group keys (completed groups folded by default, finalized by users 2026-08-30)
  isCompleteWithSubtasks: true,
  isTodoEditModalCloseAutoSave: true,
  isCompleteCheckboxColorFollow: true,
  runWhenComputerStart: false,
  hideMainWindowOnStartup: false,
  enableHardwareAcceleration: true,
  maxRepeat: '2',
  showNoDate: true,
  showCompleteNoDate: true,
  showComplete: true,
  developerMode: false, // developer mode: master gate for unfinished/structural experiments (today-x, habit, projects, deps)
  showTodayXModule: false, // today experimental view (two-layer gate: developerMode && this)
  autoDownloadUpdates: true, // Auto-update: download in background when a new version is found (off = notify only; manual download on the settings page)
  showHabitModule: false, // habit check-in module (two-layer gate: developerMode && this)
  showProjectsModule: false, // projects module (two-layer gate: developerMode && this — still experimental, not graduated)
  showDepsModule: false, // dependency view (two-layer gate: developerMode && this; today deps mode + project deps tab)
  calendarBackground: 'list', // list|theme|system
  isCalendarBackgroundUserSelected: false,
  enableSecurityLock: false,
  securityLockPassword: '',
  isShowSubTask: true,
  isCalendarDimUncompleted: true,
  isShowCalendarPrivacyMode: false,
  isShowCalendarCompleted: false, // maint-d7: read/written by CalendarView + ViewMoreMenu — was undeclared, so updateExternal/inbound sync silently stripped it (LAN sync / machine change = lost toggle)
  isDefaultSubTaskFolded: false,
  calendarFontSize: 'medium', // small|medium|large
  weekStartDay: 'mon', // mon|sun
  newTodoDefaultSort: 'top', // top|bottom
  dailyTomatoTarget: 8, // daily tomato target (user-changeable; the product doesn't bake in a "normal amount" judgment)
  dailyLoadWarnThreshold: 10, // per-day planned-tomato load warning (0 = off); consumed by the Today capacity band and project-panel load badges
  showHolidayMarkers: true,
  todoDescriptionDisplayLineNumber: 3,
  notificationTimeoutInterval: 300000,
  calendarCategory: 0,
  searchDateRange: '',
  searchComplete: '',
  searchCategory: '',
  showTodoCheckboxOrder: true,
  newTodoCategoryId: 0,
  calendarFontColor: 'white', // white|black
  whiteNoiseAudio: '',
  whiteNoiseVolume: 0.55, // White-noise volume (0-1), adjustable via the settings-page slider
  _lsAt: 0, // Monotonic stamp of whole-package LS writes: storage sync uses it to drop out-of-order stale packets (two-ended whole-package write race = root cause of the noise-selection regression)
  expiredCompletedTodoRange: '7d', // today|7d|15d|30d
  recycleBinAutoDeleteDays: 30,
  // Auto backup: switch / interval minutes / copies to keep / last-run timestamp
  autoBackupEnabled: true,
  autoBackupIntervalMin: 30,
  autoBackupKeep: 10,
  backupDir: '', // backup storage location (empty = default App data dir/backups)
  expiredUncompletedTodoRange: '30d', // today|7d|30d|90d (historical values may be Chinese, normalized at load)
  upcomingTodoRange: '30d', // 7d|30d
  todoBoxSortMethod: 'created', // created|due|difficulty
  todoBoxSortOrder: 'desc', // desc|asc
  todoBoxCategoryId: -1,
  tomatoTime: 25, // maint-d7: the REAL focus-minutes key (SettingsModal `set({tomatoTime})` / TomatoPanel write it) — was undeclared, so inbound synced patches were stripped
  restTime: 5, // maint-d7: the REAL rest-minutes key (same writers)
  tomatoTimeDefault: 25, // maint-d7: LEGACY dead key, no live consumer — load() migrates its value to tomatoTime and drops it; declared only so inbound legacy patches sanitize/coerce instead of being unknown junk
  restTimeDefault: 5, // maint-d7: LEGACY dead key, same treatment as tomatoTimeDefault
  enableTomatoFloating: true, // desktop floating window (the antonym of the reference disableTomatoFloating), on by default
  weatherEnabled: false, // sidebar weather (involves network and location, off by default, user enables in settings)
  weatherCity: '', // manually specified city; empty = auto-locate by IP
  weatherSource: 'open-meteo', // weather data source: open-meteo | wttr
  taskFlyAnimation: true, // paper-plane-to-entry animation on task completion (can be turned off in settings)
  sortMode: 'custom', // custom | created | difficulty (historical values may be Chinese, normalized compatibly in todo.js)
  closeActionMinimize: true,
  colorMode: 'light',
  // Y1 (sync-coverage-2): app locale rides the synced settings blob so it syncs field-granular via
  // the settings_rows bridge; localStorage 'appLocale' stays as the boot cache (i18n/index.js:53).
  appLocale: 'zh-CN',
  // Y3: sidebar collapse / category-section fold / tag panel visibility in the synced blob.
  // The forced narrow-viewport collapse stays transient (SideNav never persists it).
  sidebarCollapsed: false,
  catFold: false, // single bool: categories section folded in the sidebar (SideNav.vue semantics)
  showTagPanel: true,
  // Y2: global shortcut map — the SHARED factory table (shared/shortcut-defaults.mjs, same module
  // src/main/config-store.js reads; previously a hand-copied mirror that could drift). Seeded from
  // config.json on first run.
  shortcutKeySettings: { ...DEFAULT_SHORTCUTS },
  // Y4: repeat-rule defaults (repeatSettingsV2State content as one JSON object; store/repeatSettings.js reads/writes through here)
  repeatDefaultSettings: {},
  // Y6: onboarding tours seen ledger ({tourKey: ts}); inbound patches merge per-key max, never clobber
  onboardingToursSeen: {}
}

/**
 * Settings enum schema (single source of truth) — legal values and copy keys are defined only here; settings-page dropdowns/radios iterate from this.
 * Adding an enum option: 1) add a line here 2) add the i18n entries 3) done (DEFAULT comments keep only non-enum notes).
 * SETTING_ENUMS is the only legal value list for settings enums (pinned by unit tests).
 */
export const SETTING_ENUMS = {
  sortMode: [
    { v: 'custom', l: 'statsE.SettingsModal.customOption' },
    { v: 'created', l: 'statsH.SettingsModal.sortByCreated' },
    { v: 'difficulty', l: 'statsH.SettingsModal.sortByDifficulty' }
  ],
  newTodoDefaultSort: [
    { v: 'top', l: 'statsE.SettingsModal.positionTop' },
    { v: 'bottom', l: 'statsE.SettingsModal.positionBottom' }
  ],
  expiredCompletedTodoRange: [
    { v: 'today', l: 'statsE.SettingsModal.rangeToday' },
    { v: '7d', l: 'statsH.SettingsModal.range7d' },
    { v: '15d', l: 'statsH.SettingsModal.range15d' },
    { v: '30d', l: 'statsH.SettingsModal.range30d' }
  ],
  expiredUncompletedTodoRange: [
    { v: '7d', l: 'statsE.SettingsModal.rangeLastWeek' },
    { v: '30d', l: 'statsH.SettingsModal.range30d' },
    { v: '90d', l: 'statsH.SettingsModal.range90d' }
  ],
  upcomingTodoRange: [
    { v: '7d', l: 'statsE.SettingsModal.rangeSevenDays' },
    { v: '30d', l: 'statsH.SettingsModal.range30d' }
  ],
  weatherSource: [
    { v: 'open-meteo', l: 'statsE.SettingsModal.providerOpenMeteo' },
    { v: 'wttr', l: 'wttr.in' }
  ],
  colorMode: [
    { v: 'light', l: 'statsE.SettingsModal.themeLight' },
    { v: 'dark', l: 'statsE.SettingsModal.themeDark' },
    { v: 'system', l: 'statsE.SettingsModal.themeFollowSystem' }
  ],
  calendarFontSize: [
    { v: 'small', l: 'statsE.SettingsModal.sizeSmall' },
    { v: 'medium', l: 'statsH.SettingsModal.fontMedium' },
    { v: 'large', l: 'statsH.SettingsModal.fontLarge' }
  ]
}

/** Numeric-setting coercion (pure, unit-tested): the CLI settings manifest historically typed some numeric
 *  fields (categoryId / durations / counts) as strings; strict-equality consumers in todo.js then broke
 *  (t.categoryId === settings.todoBoxCategoryId never matched; new tasks got "3" written as categoryId).
 *  Coercion is declaration-driven, not a blanket cast: a field is corrected only when DEFAULT_SETTINGS
 *  declares it as a number AND the incoming value is a string that parses to a finite number. */
export function coerceNumericSettings (merged) {
  for (const k of Object.keys(merged)) {
    if (typeof DEFAULT_SETTINGS[k] !== 'number') continue
    const v = merged[k]
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) merged[k] = Number(v)
  }
  return merged
}

/** P1-3 (2026-09-19 UX review round 2, pure, unit-tested): sanitize an INBOUND settings patch that
 *  crossed a trust boundary (CLI `settings set` watcher, LAN-sync applied setting rows) before it
 *  is committed to the live store. The external-settings-changed path historically Object.assigned
 *  the patch bare — unknown keys and type-mismatched junk from a peer/old build landed verbatim.
 *  Rules: keys not declared in DEFAULT_SETTINGS are dropped; values whose type differs from the
 *  declared default are dropped; remaining numeric-string values are coerced exactly like
 *  load()/restore() (coerceNumericSettings). */
export function sanitizeSettingsPatch (patch, current) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return {}
  const out = {}
  for (const k of Object.keys(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue // unknown junk
    const def = DEFAULT_SETTINGS[k]
    const v = patch[k]
    if (v === null || v === undefined) continue // tombstones are not a valid live-patch value here
    if (typeof def === 'number' && typeof v === 'string') {
      // CLI legacy numeric-string shape: coerce exactly like coerceNumericSettings, drop non-numeric strings
      const n = Number(v)
      if (v.trim() !== '' && Number.isFinite(n)) out[k] = n
      continue
    }
    if (typeof def !== typeof v) continue // type-mismatched junk (e.g. object where boolean declared)
    // U3 (2026-09-20): a partial inbound shortcut map must not reset the other bindings — the merge
    // base is the CURRENT LIVE STATE (passed in by the caller), not DEFAULT_SETTINGS: merging over
    // defaults wiped every local customization and persisted the wipe to config.json. The sanitizer
    // stays pure — callers without live state (pure validation) pass no base and get defaults-merged
    // output. Arrays are junk for OBJECT-typed fields, but fields whose DEFAULT is an array
    // (foldedTodoList) legitimately carry arrays — dropping them made an inbound LAN-sync fold
    // apply to the main-process rows while live state kept the stale list, and the next persist
    // re-stamped the stale value over the peer (fold state ping-ponged forever).
    if (k === 'shortcutKeySettings' && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = { ...(current && current.shortcutKeySettings ? current.shortcutKeySettings : DEFAULT_SETTINGS.shortcutKeySettings), ...v }
      continue
    }
    // wave2 P3 (2026-09-23): symmetric junk drop — an ARRAY-default field (foldedTodoList) receiving
    // a non-array object (typeof both 'object') slipped past every branch above and landed verbatim
    // in live state + persist mirror. Declared arrays only ever accept arrays (entries filtered below).
    if (Array.isArray(def) && !Array.isArray(v)) continue
    if (typeof def === 'object' && !Array.isArray(def) && Array.isArray(v)) continue
    // Round-2 P1 (2026-09-21): array-valued fields (foldedTodoList) sanitize their ENTRIES too —
    // an inbound array carrying non-string junk (numbers, booleans, nested objects) used to be
    // mirrored verbatim into live state and re-persisted. Keep non-empty strings only.
    if (Array.isArray(def) && Array.isArray(v)) out[k] = v.filter(e => typeof e === 'string' && e.trim() !== '')
    else out[k] = v
  }
  return clampNumericSettings(out)
}

/** F-C3 (maint/dw wave3, pure): range clamp for numeric settings — sanitizeSettingsPatch used to do
 *  type validation only, so an inbound patch like {tomatoTime: 9999, restTime: 0} passed straight
 *  through the mirror chain (mirrorTomatoLedger → tomato/patch) into the RUNNING countdown and was
 *  persisted to LS + db.settingsState + config.json. The ranges mirror the only two bounded-UI
 *  surfaces (SettingsModal :min/:max) and the CLI manifest (cli/lib.js SETTINGS_MANIFEST.ranges).
 *  TODO(maint/dw wave4): consume domain2's shared/settings-manifest.mjs instead of this inline
 *  table once that module lands (values identical to the CLI manifest). */
export const SETTING_RANGES = {
  tomatoTime: { min: 5, max: 180 }, // SettingsModal focus-length input-number (:min=5 :max=180)
  restTime: { min: 1, max: 60 }, // SettingsModal break-length input-number (:min=1 :max=60)
  dailyTomatoTarget: { min: 1, max: 50 } // SettingsModal daily-goal input (:min=1 :max=50)
}
export function clampNumericSettings (patch) {
  if (!patch || typeof patch !== 'object') return patch
  for (const k of Object.keys(SETTING_RANGES)) {
    const v = patch[k]
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    const { min, max } = SETTING_RANGES[k]
    if (v < min) patch[k] = min
    else if (v > max) patch[k] = max
  }
  return patch
}

/** Y6 pure helper (unit-tested): union-merge two {tourKey: ts} ledgers keeping the max ts per key. */
export function mergeTourMap (local, inbound) {
  const out = { ...(local && typeof local === 'object' ? local : {}) }
  for (const k of Object.keys(inbound || {})) {
    const v = Number(inbound[k]) || 0
    if (!(k in out) || v > (Number(out[k]) || 0)) out[k] = v
  }
  return out
}

/** U5 (2026-09-20, pure): canonical JSON — object keys sorted recursively, arrays in order. Replaces
 *  the key-order-sensitive JSON.stringify equality checks (a synced map whose keys arrived in a
 *  different order used to read as "different" and reseed/repatch spuriously). */
export function canonicalJson (v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v)
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']'
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}'
}

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

import { mirrorToDb, restoreFromDb, DB_MIRROR_ERROR } from '../utils/dbMirror.js'

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

/** maint-d7: settings the MAIN process consumes from config.json / its own handlers. A renderer-side
 *  commit that skips the `settings/update` action's `updateSettings` IPC leaves these reverted on
 *  next launch (config.json is windows.js's sole source; runWhenComputerStart hot-applies via
 *  app.setLoginItemSettings). securityLockPassword rides the same channel — the per-sender
 *  stripForbiddenSettingsKeys on main's side allows it from the main window. */
export const MAIN_CONSUMED_SETTINGS = ['shortcutKeySettings', 'appLocale', 'closeActionMinimize', 'runWhenComputerStart', 'hideMainWindowOnStartup', 'enableHardwareAcceleration', 'enableSecurityLock', 'securityLockPassword']

/** maint-d7 (pure, unit-tested): the subset of MAIN_CONSUMED_SETTINGS whose live value differs from
 *  the declared default — i.e. what a bare restore/commit must hand to main's updateSettings IPC. */
export function mainConsumedSettingsDiff (state) {
  const patch = {}
  for (const k of MAIN_CONSUMED_SETTINGS) {
    if (canonicalJson(state ? state[k] : undefined) !== canonicalJson(DEFAULT_SETTINGS[k])) patch[k] = state[k]
  }
  return patch
}

/** P1-1 (maint/dw 2026-09-23): the pomodoro durations live in TWO ledgers — this module holds the
 *  synced settings blob, but the running countdown reads the tomato module's runtime state. The
 *  settings PAGE used to be the only place that mirrored the two (SettingsModal.set), so every
 *  other inbound path (CLI `settings set`, LAN sync via updateExternal, DB restore via initFromDb)
 *  updated the settings ledger and left the live countdown on stale values until restart. The
 *  mirror now lives HERE: every write that carries one of these keys also patches the tomato
 *  ledger. Pure helper (unit-tested) — callers pass their own commit so mutations/actions share it. */
export const TOMATO_LEDGER_KEYS = ['tomatoTime', 'restTime', 'dailyTomatoTarget']
export function tomatoLedgerPatch (patch) {
  if (!patch || typeof patch !== 'object') return {}
  const tp = {}
  for (const k of TOMATO_LEDGER_KEYS) if (patch[k] != null) tp[k] = patch[k]
  return tp
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
      Object.assign(state, patch)
      persist(state)
    },
    restore (state, saved) {
      const merged = clampNumericSettings(coerceNumericSettings({ ...DEFAULT_SETTINGS, ...(saved || {}) }))
      if (merged.shortcutKeySettings === DEFAULT_SETTINGS.shortcutKeySettings) merged.shortcutKeySettings = { ...DEFAULT_SHORTCUTS }
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
    }
  },
  actions: {
    async update ({ commit }, patch) {
      commit('updateSettings', patch)
      // P1-1: mirror duration keys into the tomato runtime ledger (all inbound paths converge here —
      // updateExternal re-dispatches through this action; see tomatoLedgerPatch above).
      mirrorTomatoLedger(commit, patch)
      // Y1: locale hot-apply — mirror the local-change path (main handlers/settings.js 'set-app-locale'):
      // main-process i18n + tray rebuild. LS 'appLocale' stays as i18n's boot cache (write-through).
      if (patch && patch.appLocale && typeof patch.appLocale === 'string') {
        try { localStorage.setItem('appLocale', patch.appLocale) } catch (e) { /* empty */ }
        try {
          const i18nMod = await import('../i18n/index.js')
          if (i18nMod.default && i18nMod.default.global) i18nMod.default.global.locale = patch.appLocale
        } catch (e) { /* i18n unavailable in degraded hosts */ }
        try { if (window.todoAPI && window.todoAPI.setAppLocale) window.todoAPI.setAppLocale(patch.appLocale) } catch (e) { /* empty */ }
      }
      // P2-2 (maint/dw 2026-09-23): the IPC result is now REPORTED instead of swallowed — the
      // shortcuts tab awaits it and must not show "saved" (nor advance its dirty snapshot) when
      // config.json was not written. A missing bridge (tests / browser host) counts as ok.
      if (typeof window !== 'undefined' && window.todoAPI && window.todoAPI.updateSettings) {
        try { await window.todoAPI.updateSettings(patch) } catch (e) {
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
    async updateExternal ({ state, dispatch }, patch) {
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
      if (!db || typeof db !== 'object' || (db._savedAt || 0) <= lsAt) {
        mirrorToDb('db.settingsState', { ...state, _savedAt: Date.now(), schemaV: SETTINGS_SCHEMA_V })
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
        // Same unknown-key policy as sanitizeSettingsPatch.
        // TODO(maint/dw wave4): consume domain2's shared/settings-families.mjs for the habits-family
        // field set (HABITS_BLOB_FIELDS) once that module lands; the whitelist already makes them
        // unreachable here, the shared module is only the documented export surface.
        if (!(k in DEFAULT_SETTINGS)) continue
        if (canonicalJson(db[k]) !== canonicalJson(state[k])) patch[k] = db[k]
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
