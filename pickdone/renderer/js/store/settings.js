import { safeSet } from '../utils/core.js'
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
  tomatoTimeDefault: 25,
  restTimeDefault: 5,
  enableTomatoFloating: true, // desktop floating window (the antonym of the reference disableTomatoFloating), on by default
  weatherEnabled: false, // sidebar weather (involves network and location, off by default, user enables in settings)
  weatherCity: '', // manually specified city; empty = auto-locate by IP
  weatherSource: 'open-meteo', // weather data source: open-meteo | wttr
  taskFlyAnimation: true, // paper-plane-to-entry animation on task completion (can be turned off in settings)
  sortMode: 'custom', // custom | created | difficulty (historical values may be Chinese, normalized compatibly in todo.js)
  closeActionMinimize: true,
  colorMode: 'light'
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

function load () {
  // Corrupted-JSON fallback: this module executes at top level; a throw = the whole store chain's import fails and white-screens; falling back to {} lets the DB restore path (initFromDb) take over
  let raw = {}
  try { raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {} } catch (e) { raw = {} }
  if (typeof raw !== 'object' || Array.isArray(raw)) raw = {}
  // Format-version tolerance: old unstamped data treated as v1 (behavior unchanged); higher versions left for future upgrade logic
  const merged = { ...DEFAULT_SETTINGS, ...raw }
  // Strip volatile keys already migrated to runtimeState (leftovers in old localStorage)
  delete merged.autoBackupLastAt; delete merged.tomatoRecordAddCount; delete merged.tomatoRecordAddDate
  coerceNumericSettings(merged)
  // No existing users pre-release: the legacy enum normalization table (LEGACY) was removed together with the old compat code
  // Completed groups folded by default (finalized by users 2026-08-30). Old users' saves with foldedTodoList=[] would override the new default,
  // so a one-time migration backfills it; afterwards the user's manual expand/collapse wins (removal from the list counts as expressed intent, no re-backfill).
  if (merged.doneGroupsFoldMigrated !== true) {
    merged.foldedTodoList = Array.from(new Set([...(merged.foldedTodoList || []), 'today-done', 'day-done']))
    merged.doneGroupsFoldMigrated = true
  }
  return merged
}

let saveTimer = null
let mirrorTimer = null
const MIRROR_AT_KEY = 'settingsMirrorAt'
function persist (state) {
  state._lsAt = Date.now() // Write order: stamped at apply time; storage sync drops stale packets by this
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    safeSet(LS_KEY, JSON.stringify({ ...state, schemaV: SETTINGS_SCHEMA_V }))
    try { localStorage.setItem(MIRROR_AT_KEY, String(Date.now())) } catch (e) { /* empty */ }
  }, 150)
  // Mirror into SQLite meta: settings are user configuration assets, no longer lost when LS is cleared (2s debounce)
  clearTimeout(mirrorTimer)
  mirrorTimer = setTimeout(() => {
    // Node unit-test environment has no window.location (debounce timers still fire after tests end, once blew up with uncaughtException)
    if (typeof window === 'undefined' || !window.location) return
    // Float/quick-add windows don't write the DB directly (todo-db:call is main-window-only; would spam forbidden errors):
    // aux windows write LS only; after main-window storage sync the main window persists
    if (/__tomato-float|__quick-add/.test(window.location.hash)) return
    mirrorToDb('db.settingsState', { ...state, _savedAt: Date.now(), schemaV: SETTINGS_SCHEMA_V })
  }, 2000)
}

import { mirrorToDb, restoreFromDb } from '../utils/dbMirror.js'

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
      Object.assign(state, coerceNumericSettings({ ...DEFAULT_SETTINGS, ...(saved || {}) }))
      persist(state)
    }
  },
  actions: {
    async update ({ commit }, patch) {
      commit('updateSettings', patch)
      try { await window.todoAPI.updateSettings(patch) } catch (e) {
        // IPC failure = LS written but config.json not; next launch config would overwrite it back (settings changed during lock → lost on restart): at least leave a trace
        console.error('[settings] updateSettings IPC failed, patch may be reverted on next launch:', patch, e)
      }
    },
    // On startup judge newness by timestamp: if the DB mirror is newer than LS (e.g. LS cleared / machine change) → restore key-level from DB wholesale; otherwise flush current values back to the DB
    async initFromDb ({ state, commit }) {
      const db = await restoreFromDb('db.settingsState')
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
        if (JSON.stringify(db[k]) !== JSON.stringify(state[k])) patch[k] = db[k]
      }
      coerceNumericSettings(patch)
      if (Object.keys(patch).length) commit('updateSettings', patch)
      else mirrorToDb('db.settingsState', { ...state, _savedAt: db._savedAt, schemaV: SETTINGS_SCHEMA_V })
    }
  }
}
