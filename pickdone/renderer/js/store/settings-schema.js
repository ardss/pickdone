/**
 * settings-schema — pure settings schema + pure helpers, split from store/settings.js
 * (2026-10-24 size-ratchet split queue). No module state, no LS/db access: everything
 * here is constants and pure functions over plain data. The store re-exports every name
 * so existing consumers keep importing from store/settings.js unchanged.
 */
import { DEFAULT_SHORTCUTS } from '../../../shared/shortcut-defaults.mjs'
import { SETTINGS_MANIFEST, SECRET_KEYS } from '../../../shared/settings-manifest.mjs'
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
  ],
  // B6 (daily 2026-09-24): the five keys below existed only in the shared manifest enum
  // (shared/settings-manifest.mjs) — SETTING_ENUMS (the schema the settings page and the
  // sanitize path treat as the legal-value list) was missing them, so inbound patches carrying
  // a junk weekStartDay/calendarBackground/calendarFontColor/todoBoxSortMethod/todoBoxSortOrder
  // passed sanitizeSettingsPatch unvalidated. Values are pinned to the manifest's enum lists by
  // unit test (single source for the VALUE SET is the manifest; this table only adds i18n labels).
  // Labels reuse existing i18n keys where one exists; the calendarBackground/calendarFontColor
  // options have no shipped label keys yet and fall back to their raw value via $t passthrough.
  weekStartDay: [
    { v: 'mon', l: 'statsE.SettingsModal.weekStartMonday' },
    { v: 'sun', l: 'statsE.SettingsModal.weekStartSunday' }
  ],
  calendarBackground: [
    { v: 'list', l: 'list' },
    { v: 'theme', l: 'theme' },
    { v: 'system', l: 'statsE.SettingsModal.themeFollowSystem' }
  ],
  calendarFontColor: [
    { v: 'white', l: 'white' },
    { v: 'black', l: 'black' }
  ],
  todoBoxSortMethod: [
    { v: 'created', l: 'statsE.TodoBoxView.sortByCreated' },
    { v: 'due', l: 'statsE.TodoBoxView.sortByDueDate' },
    { v: 'difficulty', l: 'statsE.TodoBoxView.sortByDifficulty' }
  ],
  todoBoxSortOrder: [
    { v: 'desc', l: 'statsE.TodoBoxView.sortDescending' },
    { v: 'asc', l: 'statsE.TodoBoxView.sortAscending' }
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
 *  load()/restore() (coerceNumericSettings). B3: an explicit null marker (deletion tombstone from
 *  computeSettingsPatch) resets the key to its declared DEFAULT value; C3: secret keys are
 *  stripped regardless of value. */
export function sanitizeSettingsPatch (patch, current) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return {}
  const out = {}
  for (const k of Object.keys(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue // unknown junk
    // C3 (maint): last inbound gate — strip machine-local secret fields. Both real producers
    // already strip them upstream (settings-hot-sync SECRET_KEYS; LAN ingress isMachineLocalSettingKey),
    // but a future fourth path or an upstream-gate regression must not let a peer's secret
    // overwrite the local lock. The /^securityLock/ prefix mirrors sync-apply.js's predicate
    // (narrower than it: any future securityLock* key is covered even if undeclared below).
    if (SECRET_KEYS.includes(k) || /^securityLock/.test(k)) continue
    const def = DEFAULT_SETTINGS[k]
    const v = patch[k]
    if (v === null) {
      // B3 (maint): explicit deletion marker from computeSettingsPatch — a key removed from the
      // synced blob (peer tombstone / deprecated key). The store is defaults-backed and
      // DEFAULT_SETTINGS keys are always present in live state, so 'deleted' == revert to the
      // declared default: exactly what a restart already produces for an absent key. Object/array
      // defaults are cloned so mutating live state can never corrupt the module default.
      out[k] = def && typeof def === 'object' ? (Array.isArray(def) ? [...def] : { ...def }) : def
      continue
    }
    if (v === undefined) continue
    if (typeof def === 'number' && typeof v === 'string') {
      // CLI legacy numeric-string shape: coerce exactly like coerceNumericSettings, drop non-numeric strings
      const n = Number(v)
      if (v.trim() !== '' && Number.isFinite(n)) out[k] = n
      continue
    }
    if (typeof def !== typeof v) continue // type-mismatched junk (e.g. object where boolean declared)
    // B6 (daily 2026-09-24): enum membership check — a key with a legal-value list in the SHARED
    // manifest (SETTINGS_MANIFEST.enum, the single source the value sets are pinned against)
    // only accepts members; anything else (e.g. a peer writing weekStartDay:'monday' or
    // appLocale:'fr-FR') used to land verbatim and silently break the consuming UI, which
    // falls back to defaults on an unknown value. Dropped, not clamped: enums have no order.
    const legalEnums = SETTINGS_MANIFEST.enum[k]
    if (legalEnums && !legalEnums.includes(v)) continue
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
 *  persisted to LS + db.settingsState + config.json. The ranges are the SHARED manifest table
 *  (domain2's shared/settings-manifest.mjs — same source cli/lib.js enforces on the CLI side, and
 *  the same values the SettingsModal :min/:max render; wave3 review: the wave4 TODO to converge is
 *  now fulfilled, no second copy to drift). */
export const SETTING_RANGES = SETTINGS_MANIFEST.ranges
/** [W7-R 2026-10-23 P3] the single appLocale enum gate (SETTINGS_MANIFEST.enum.appLocale — the
 *  same source the sanitizer pins values against). Every writer path that can seat a locale into
 *  live state / the LS boot cache / main's config.json routes through this one predicate: the
 *  updateSettings mutation's boot channel, restore()'s LS-adoption branch, and the `update`
 *  action's Y1 write-through + hot-apply path (which previously accepted any non-empty string —
 *  dispatch('settings/update', { appLocale: 'junk' }) wrote 'junk' into LS 'appLocale' and pushed
 *  it at main). CONSISTENCY PREDICATE: only ever tightened, never loosened. */
export function isLegalAppLocale (loc) {
  const legal = SETTINGS_MANIFEST.enum.appLocale
  return typeof loc === 'string' && !!loc && (!legal || legal.includes(loc))
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



/** maint-d7: settings the MAIN process consumes from config.json / its own handlers. A renderer-side
 *  commit that skips the `settings/update` action's `updateSettings` IPC leaves these reverted on
 *  next launch (config.json is windows.js's sole source; runWhenComputerStart hot-applies via
 *  app.setLoginItemSettings). autoDownloadUpdates rides it too — src/main/updater.js re-reads it
 *  from config.json on every update check (syncAutoDownload). securityLockPassword rides the same
 *  channel — the per-sender stripForbiddenSettingsKeys on main's side allows it from the main window. */
export const MAIN_CONSUMED_SETTINGS = ['shortcutKeySettings', 'appLocale', 'closeActionMinimize', 'runWhenComputerStart', 'hideMainWindowOnStartup', 'enableHardwareAcceleration', 'enableSecurityLock', 'securityLockPassword', 'autoDownloadUpdates']

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