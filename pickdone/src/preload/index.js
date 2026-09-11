/**
 * preload —— renderer-process security bridge (replaces the reference nodeIntegration)
 * Channel names align with the reference ipc channels where possible, so it can later be swapped for a real cloud implementation
 */
const { contextBridge, ipcRenderer } = require('electron')

const invoke = (ch, ...args) => ipcRenderer.invoke(ch, ...args)

contextBridge.exposeInMainWorld('todoAPI', {
  // Version is injected by the main process via env var (app.getVersion()), avoiding hardcoded drift in the renderer
  version: process.env.APP_VERSION || '0.0.0',

  // Data-directory isolation flag (TODO_USER_DATA_DIR injected = isolated test/dev instance). Attach-mode smoke tests use this to refuse writing the real user database
  isDataIsolated: !!process.env.TODO_USER_DATA_DIR,

  // ---- Database (same as the reference todo-db:call) ----
  dbCall: (op, params) => invoke('todo-db:call', op, params),
  // Dangerous purge goes through a dedicated channel (bypasses the todo-db:call op whitelist; executed inside the main process)
  purgeRecycleBin: () => invoke('db:purge-recycle-bin'),
  purgeSeedTodos: () => invoke('db:purge-seed-todos'),
  logWrite: entries => invoke('log:write', entries),
  openLogsDir: () => invoke('log:open-dir'),
  setAppLocale: locale => invoke('set-app-locale', locale),

  // ---- Settings / config ----
  getSettings: () => invoke('get-settings'),
  updateSettings: patch => invoke('notify-settings-updated', patch),
  writeCriticalStateBackup: jsonText => invoke('write-critical-state-backup', jsonText),
  runAutoBackup: (jsonText, opts) => invoke('run-auto-backup', jsonText, opts),
  listAutoBackups: backupDir => invoke('list-auto-backups', backupDir),
  readAutoBackup: (backupDir, fileName) => invoke('read-auto-backup', backupDir, fileName),
  pickBackupDir: () => invoke('pick-backup-dir'),
  getDefaultBackupDir: () => invoke('get-default-backup-dir'),
  encryptSecret: plain => invoke('encrypt-secret', plain),
  decryptSecret: stored => invoke('decrypt-secret', stored),
  readCriticalStateBackup: () => invoke('read-critical-state-backup'),
  // One-click CSV migration (other todo apps → 拾事): pick file + preview / run by path; engine lives in main-process cli/import.js
  importCsvPickPreview: () => invoke('import:pick-preview'),
  importCsvRun: file => invoke('import:run', file),

  // ---- Security lock (verification happens inside the main process; the plaintext password never leaves it) ----
  quickAddHide: () => invoke('quick-add-hide'),
  onQuickAddFocus: cb => {
    const h = () => cb()
    ipcRenderer.on('quick-add-focus', h)
    return () => ipcRenderer.removeListener('quick-add-focus', h)
  },
    lockApp: () => invoke('lock-app'),
  verifyLockPassword: plain => invoke('verify-lock-password', plain),
  unlockApp: () => invoke('unlock-app'),

  // ---- Auto update ----
  checkForUpdates: () => invoke('updater:check'),
  downloadUpdate: () => invoke('updater:download'),
  quitAndInstall: () => invoke('updater:quit-and-install'),
  updaterStatus: () => invoke('updater:status'),
  onUpdaterEvent: cb => {
    const h = (_e, d) => cb(d)
    ipcRenderer.on('updater:event', h)
    return () => ipcRenderer.removeListener('updater:event', h)
  },

  // ---- Window ----
  minimize: () => invoke('minimize-main-window'),
  maximize: () => invoke('maximize-main-window'),
  isMaximized: () => invoke('is-maximized'),
  hideWindow: () => invoke('hide-main-window'),
  closeRequest: () => invoke('close-main-window-request'),

  // ---- Attachments ----
  uploadAttachment: payload => invoke('upload-attachment', payload), // {taskId,name,dataBase64}
  openFile: url => invoke('open-file', url),
  downloadAndOpen: url => invoke('download-file-and-open', url),
  saveToDownloads: (url, name) => invoke('save-upload-file-to-download', url, name),
  deleteFile: url => invoke('delete-file', url),
  deleteTodoFilesRelevant: id => invoke('delete-todo-files', id), // clean up attachments when a task is permanently deleted

  // ---- Export ----
  exportXlsx: payload => invoke('export-todos-to-xlsx', payload),

  // ---- Reminders/notifications ----
  notification: opt => invoke('notification', opt),

  // ---- Widgets ----

  // ---- Pomodoro float window ----
  showTomatoFloat: () => invoke('show-tomato-float'),
  hideTomatoFloat: () => invoke('hide-tomato-float'),
  tomatoFloatShown: () => invoke('tomato-float-shown'),
  // Erase DWM ghost residue after content transitions (called on expand/collapse of the abandon popover)
  flushTomatoFloat: () => invoke('flush-tomato-float'),
  setTomatoFloatBounds: () => invoke('set-tomato-float-bounds'),
  startTomatoFloatDrag: () => invoke('start-tomato-float-drag'),
  stopTomatoFloatDrag: () => invoke('stop-tomato-float-drag'),
  ensureWindowWidth: w => invoke('ensure-window-width', w),
  // Expanded-layer state report (⋮ menu/♪ noise/abandon confirm): the main process expands the hit area from the card strip to the whole window accordingly
  tomatoFloatPanel: open => invoke('set-tomato-float-panel', open),
  // Double-click the float card to summon the main window (the main process validates that the sender is the float window itself)
  showMainFromFloat: () => invoke('show-main-from-float'),
  // Taskbar trio state push (progress bar/title countdown/thumbnail toolbar) + taskbar button callback
  pushTomatoTaskbar: payload => invoke('update-tomato-taskbar', payload),
  onTomatoTaskbarCmd: fn => {
    const h = (_e, p) => fn(p)
    ipcRenderer.on('tomato-taskbar-cmd', h)
    return () => ipcRenderer.removeListener('tomato-taskbar-cmd', h)
  },

  // ---- Project baseline data migration ----

  // ---- Cloud sync (reserved for the offline edition) ----
  syncNow: () => invoke('sync-todos-to-server'),

  // ---- Misc ----
  openExternal: url => invoke('open-external-url', url),
  pickAudioFile: () => invoke('select-user-white-noise-audio-file'),
  // Main process broadcasts this after a custom white-noise file is (re)saved, so the renderer
  // can drop its decoded-audio cache (otherwise the old file keeps playing until restart)
  onWhiteNoiseUpdated: cb => {
    const h = () => cb()
    ipcRenderer.on('white-noise-updated', h)
    return () => ipcRenderer.removeListener('white-noise-updated', h)
  },
  mimeByType: n => invoke('mime-get-type', n),

  onShortcutConflict: fn => {
    const h = (_e, p) => fn(p)
    ipcRenderer.on('shortcut-conflict', h)
    return () => ipcRenderer.removeListener('shortcut-conflict', h)
  },
  onShortcutAction: fn => {
    const h = (_e, action) => fn(action)
    ipcRenderer.on('shortcut-action', h)
    return () => ipcRenderer.removeListener('shortcut-action', h)
  },
  // Reminder sound: the main process sends the audio file path, the renderer plays it with Audio (see notify-sound.js)
  onPlaySound: fn => {
    const h = (_e, file) => fn(file)
    ipcRenderer.on('play-sound', h)
    return () => ipcRenderer.removeListener('play-sound', h)
  },
  onSecurityLock: fn => {
    const h = () => fn()
    ipcRenderer.on('security-lock-on', h)
    return () => ipcRenderer.removeListener('security-lock-on', h)
  },
  onSecurityUnlock: fn => {
    const h = () => fn()
    ipcRenderer.on('security-lock-off', h)
    return () => ipcRenderer.removeListener('security-lock-off', h)
  },
  onTodosChanged: fn => {
    const h = (_e, p) => fn(p)
    ipcRenderer.on('todos-changed', h)
    return () => ipcRenderer.removeListener('todos-changed', h)
  },
  // 番茄账本行存储:任一窗/CLI 落账后主进程广播,各窗重载记录(账本唯一源=DB)
  onTomatoRecordsChanged: fn => {
    const h = (_e, p) => fn(p)
    ipcRenderer.on('tomato-records-changed', h)
    return () => ipcRenderer.removeListener('tomato-records-changed', h)
  },
  // CLI settings set hot-sync: the main process watcher pushes this event after diffing changed keys, and the renderer dispatches settings/update
  onExternalSettingsChanged: fn => {
    const h = (_e, patch) => fn(patch)
    ipcRenderer.on('external-settings-changed', h)
    return () => ipcRenderer.removeListener('external-settings-changed', h)
  },
  // Pre-quit flush signal: broadcast by the main process on before-quit; the renderer's debounced mirror flushes to disk immediately
  onAppQuittingFlush: fn => {
    const h = (_e, p) => fn(p)
    ipcRenderer.on('app-quitting-flush', h)
    return () => ipcRenderer.removeListener('app-quitting-flush', h)
  },
  // Flush-ack handshake: the renderer calls this after dispatching its flush writes so the main process
  // can wait for them (bounded) instead of a blind fixed delay before closing the DB
  notifyQuitFlushDone: payload => ipcRenderer.send('app-quitting-flush-ack', payload),
  // CLI tomato command channel: forwarded by the main process after detecting meta cliTomatoCmd changes (pickdone tomato start/stop/attach)
  onCliTomatoCmd: fn => {
    const h = (_e, p) => fn(p)
    ipcRenderer.on('cli-tomato-cmd', h)
    return () => ipcRenderer.removeListener('cli-tomato-cmd', h)
  }
})
