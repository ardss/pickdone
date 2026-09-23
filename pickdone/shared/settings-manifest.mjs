/**
 * CLI settings manifest (dw wave 3, single-source move out of cli/lib.js).
 * Mirrors renderer store/settings.js DEFAULT_SETTINGS/SETTING_ENUMS (keep in sync; security keys
 * are never settable — see SETTINGS_DENIED in cli/lib.js).
 * Key-migration convention: when the renderer renames a key, this manifest follows the NEW name
 * only (legacy names must not linger — a "working" write to a dead key silently no-ops in the App).
 * Intentionally local-only (never manifest-exposed): shortcutKeySettings and foldedTodoList.
 *
 * Consumed by cli/lib.js (re-exported as lib.SETTINGS_MANIFEST) and, in its wave, by the
 * renderer's sanitize path (domain 3 contract — exported surface: SETTINGS_MANIFEST with
 * boolean/number/enum/string arrays + ranges {min,max}).
 */
export const SETTINGS_MANIFEST = {
  boolean: ['autoDownloadUpdates', 'enableTomatoFloating', 'weatherEnabled', 'taskFlyAnimation', 'closeActionMinimize', 'isCompleteWithSubtasks', 'isTodoEditModalCloseAutoSave', 'isCompleteCheckboxColorFollow', 'runWhenComputerStart', 'hideMainWindowOnStartup', 'enableHardwareAcceleration', 'showNoDate', 'showCompleteNoDate', 'showComplete', 'developerMode', 'showTodayXModule', 'showHabitModule', 'showProjectsModule', 'showDepsModule', 'isShowSubTask', 'isCalendarDimUncompleted', 'isShowCalendarPrivacyMode', 'isDefaultSubTaskFolded', 'showHolidayMarkers', 'showTodoCheckboxOrder', 'enableSecurityLock', 'autoBackupEnabled', 'isCalendarBackgroundUserSelected', 'isShowCalendarCompleted', 'sidebarCollapsed', 'catFold', 'showTagPanel'],
  number: ['dailyTomatoTarget', 'dailyLoadWarnThreshold', 'recycleBinAutoDeleteDays', 'notificationTimeoutInterval', 'todoDescriptionDisplayLineNumber', 'autoBackupIntervalMin', 'autoBackupKeep', 'whiteNoiseVolume', 'tomatoTime', 'restTime',
    // Category-id settings are NUMBERS on the App side (renderer store/settings.js DEFAULT_SETTINGS: newTodoCategoryId: 0,
    // todoBoxCategoryId: -1) and the render path filters with strict equality (store/todo.js todoBoxCategoryId !== -1,
    // TodoBoxView c.categoryId === settings.todoBoxCategoryId) — the CLI used to declare them string and write back
    // "5" (string), which silently failed every strict-equality filter. Type fixed here; the renderer load path gets a
    // coeresion guard in parallel (double insurance, independent).
    'newTodoCategoryId', 'todoBoxCategoryId',
    // calendarCategory is a numeric category id in the app (DEFAULT_SETTINGS calendarCategory: 0);
    // declaring it string made `settings list` report the wrong type (value only survived via coercion)
    'calendarCategory'],
  // P3-6 (dw wave): per-key numeric bounds, mirrored from the UI's input controls (SettingsModal.vue)
  // so the CLI enforces the same clamps instead of only isFinite/≥0. Keys without an entry keep the
  // generic ≥0 gate.
  ranges: {
    tomatoTime: { min: 5, max: 180 },   // SettingsModal.vue focus-length input-number (:min=5 :max=180)
    restTime: { min: 1, max: 60 },      // SettingsModal.vue break-length input-number (:min=1 :max=60)
    dailyTomatoTarget: { min: 1, max: 50 },        // SettingsModal.vue daily-goal input (:min=1 :max=50)
    dailyLoadWarnThreshold: { min: 0, max: 50 },   // SettingsModal.vue load-warn threshold (:min=0 :max=50)
    todoDescriptionDisplayLineNumber: { min: 1, max: 6 } // SettingsModal.vue desc-lines slider (:min=1 :max=6)
  },
  enum: {
    colorMode: ['light', 'dark', 'system'],
    calendarFontSize: ['small', 'medium', 'large'],
    weekStartDay: ['mon', 'sun'],
    newTodoDefaultSort: ['top', 'bottom'],
    calendarBackground: ['list', 'theme', 'system'],
    calendarFontColor: ['white', 'black'],
    sortMode: ['custom', 'created', 'difficulty'],
    expiredCompletedTodoRange: ['today', '7d', '15d', '30d'],
    expiredUncompletedTodoRange: ['7d', '30d', '90d'], // no 'today' — the renderer's SETTING_ENUMS (store/settings.js) has no 'today' option; a CLI-written 'today' would fail the renderer's coerce and fall back to the default (no migration needed; historical 'today' values just coerce back on the App side)
    upcomingTodoRange: ['7d', '30d'],
    weatherSource: ['open-meteo', 'wttr'],
    todoBoxSortMethod: ['created', 'due', 'difficulty'],
    todoBoxSortOrder: ['desc', 'asc']
  },
  // calendarCategory is a numeric category id in the app (DEFAULT_SETTINGS calendarCategory: 0);
  // declaring it string made `settings list` report the wrong type (value only survived via coercion)
  string: ['backupDir', 'whiteNoiseAudio', 'weatherCity', 'searchDateRange', 'searchComplete', 'searchCategory', 'maxRepeat', 'appLocale']
}
