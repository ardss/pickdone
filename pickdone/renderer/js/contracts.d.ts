/**
 * 渲染端全局契约(window 注入面 + 关键数据形状)——SSOT 是 src/main:
 *  - DbCallOp 联合类型来自 src/main/index.js ALLOWED_RENDERER_OPS(31 op,与 cli/check-ipc-op-coverage 同源;
 *    新增 op 时同步更新本文件,否则渲染端调用处 vue-tsc 报错=白名单变更被类型层强制可见)
 *  - TodoAPI 通道面为 preload 实际暴露的事件/方法(显式枚举,禁止再加索引签名逃生口)
 *  - TomatoRecord: 番茄账本行表(src/main/db.js tomato_records)唯一事实源形状
 */

interface TodoRow {
  taskId: string
  taskContent: string
  taskDescribe?: string
  dayStart?: number
  todoTime?: number
  remindTs?: number | null
  complete?: number | boolean
  completedAt?: number | null
  delete?: number | boolean
  categoryId?: number | null
  repeatId?: string | null
  important?: number
  urgent?: number
  sublist?: string
  todoImageList?: string
  fileList?: string
  cliTomatoState?: string | null
  [key: string]: unknown
}

/** 番茄账本行(tomato_records 行表):dateKey 由 DB 层按 endTime 强制重推导,调用方传值不可信 */
interface TomatoRecord {
  tomatoId: string
  taskId: string | null
  dateKey: string
  endTime: number
  focusDuration: number
  restDuration: number
  succeed: number
  manual?: number
  [key: string]: unknown
}

type DbCallOp = 'getById' | 'getAll' | 'queryTodos' | 'getMeta' | 'deleteMeta' | 'upsert' | 'upsertMany' | 'hardDelete' | 'hardDeleteMany' | 'setMeta' | 'getAllCategories' | 'upsertCategory' | 'filterList' | 'filterUpsert' | 'filterDelete' | 'countAll' | 'countSeedTodos' | 'bumpSnow' | 'planAll' | 'planAddMany' | 'planUpdateChip' | 'planRemoveIds' | 'planMoveTask' | 'planDeleteTask' | 'planDeleteTaskDay' | 'planPrune' | 'tomatoAll' | 'tomatoAppendMany' | 'tomatoUpdateById' | 'tomatoRemoveByIds' | 'tomatoMigrateFromMeta' | 'syncGetSettings' | 'syncSetEnabled' | 'syncGetStatus' | 'syncGetPairingCode' | 'syncSetName' | 'syncPairWithCode' | 'getMetaMany' | 'commitSyncBatch' | 'tomatoGetById' | 'settingsRowsAll' | 'settingsRowPut' | 'settingsRowPutMany' | 'settingsRowDelete' | 'syncUnpairPeer' | 'syncPairRespond' | 'syncPairRequest' | 'syncConflictBackupsList' | 'syncConflictBackupRestore' | 'syncSetPeerAlias'

/** T7 win-bind: the ONLY cross-layer window identity shape (six fields, frozen contract).
 *  processName is normalized (lowercase, trailing .exe stripped); hwnd/pidHint are same-session
 *  hints only (handle reuse across restarts means they are never trusted alone — see the pure
 *  matcher's relocation ladder in src/main/win-bind/pure/match.js). */
interface WinBindWindowRef {
  /** normalized process name (matching key #1) */
  processName: string
  /** best-effort full executable path ('' when inaccessible — secondary signal only) */
  execPath: string
  /** root-window title at bind time (narrowing signal, not equality) */
  title: string
  /** OS pid at bind time (strong same-session signal, reused across restarts) */
  pidHint: number
  /** root HWND (GetAncestor GA_ROOT product), decimal — transient hint */
  hwnd: number
  /** Date.now() ms stamped by the main process at bind() (0 in identify results) */
  boundAt: number
}
interface TodoAPI {
  /** DB 白名单调用面:渲染端所有持久化读写必须经此(db.call);op 联合与主进程白名单同源 */
  dbCall (op: DbCallOp, params?: any): Promise<any>
  /** CONTRACT (2026-09-20, F-UI): batch meta read — getMetaMany(['a','b']) → [{key,value|null}] aligned to input order */
  getMetaMany: (keys: string[]) => Promise<Array<{ key: string, value: string | null }>>
  version?: string
  /** 数据隔离标记(TODO_USER_DATA_DIR 存在=false 并列调试实例共用真库) */
  isDataIsolated: boolean
  verifyLockPassword: (...args: any[]) => any
  unlockApp: (...args: any[]) => any
  checkForUpdates: (...args: any[]) => any
  closeRequest: (...args: any[]) => any
  deleteFile: (...args: any[]) => any
  deleteTodoFilesRelevant: (...args: any[]) => any
  deleteTodoFilesMany: (...args: any[]) => any
  downloadUpdate: (...args: any[]) => any
  encryptSecret: (...args: any[]) => any
  ensureWindowWidth: (...args: any[]) => any
  restoreWindowWidth: (...args: any[]) => any
  exportXlsx: (...args: any[]) => any
  flushTomatoFloat: (...args: any[]) => any
  getDefaultBackupDir: (...args: any[]) => any
  /** F-RELOC: data storage location info + safe migration (see src/main/data-location.cjs) */
  getDataLocationInfo: (...args: any[]) => any
  /** F-RELOC: relocate userData; targetDir omitted = main process pops the directory picker */
  relocateDataDir: (...args: any[]) => any
  /** F-RELOC: migration progress push {phase:'copy'|'verify'|'boot', done?, total?}; returns disposer */
  onMigrateProgress: (...args: any[]) => any
  getSettings: (...args: any[]) => any
  /** Batch meta read (CONTRACT 2026-09-20, F-UI): replaces per-key getMeta loops */
  getMetaMany: (...args: any[]) => any
  hideTomatoFloat: (...args: any[]) => any
  importCsvPickPreview: (...args: any[]) => any
  importCsvRun: (...args: any[]) => any
  isMaximized: (...args: any[]) => any
  listAutoBackups: (...args: any[]) => any
  lockApp: (...args: any[]) => any
  logWrite: (...args: any[]) => any
  maximize: (...args: any[]) => any
  minimize: (...args: any[]) => any
  notification: (...args: any[]) => any
  onAppQuittingFlush: (...args: any[]) => any
  onCliTomatoCmd: (...args: any[]) => any
  onExternalHabitsChanged: (...args: any[]) => any
  onExternalSettingsChanged: (...args: any[]) => any
  onPlaySound: (...args: any[]) => any
  onQuickAddFocus: (...args: any[]) => any
  onReminderOpenTask: (...args: any[]) => any
  onSecurityLock: (...args: any[]) => any
  onSecurityUnlock: (...args: any[]) => any
  onShortcutAction: (...args: any[]) => any
  onShortcutConflict: (...args: any[]) => any
  setShortcutCapturing: (flag: boolean) => void
  onSyncEvent: (...args: any[]) => any
  onTodosChanged: (...args: any[]) => any
  onTomatoRecordsChanged: (...args: any[]) => any
  onTomatoTaskbarCmd: (...args: any[]) => any
  onUpdaterEvent: (...args: any[]) => any
  onWhiteNoiseUpdated: (...args: any[]) => any
  openExternal: (...args: any[]) => any
  openFile: (...args: any[]) => any
  openLogsDir: (...args: any[]) => any
  pickAudioFile: (...args: any[]) => any
  pickBackupDir: (...args: any[]) => any
  purgeRecycleBin: (...args: any[]) => any
  purgeSeedTodos: (...args: any[]) => any
  pushTomatoTaskbar: (...args: any[]) => any
  tomatoRunningSession: (...args: any[]) => any
  tomatoClaimPhase: (...args: any[]) => any
  tomatoReleasePhase: (...args: any[]) => any
  quickAddHide: (...args: any[]) => any
  quitAndInstall: (...args: any[]) => any
  readAutoBackup: (...args: any[]) => any
  readCriticalStateBackup: (...args: any[]) => any
  runAutoBackup: (...args: any[]) => any
  setAppLocale: (...args: any[]) => any
  setTomatoFloatBounds: (...args: any[]) => any
  tomatoFloatDiagnose: (...args: any[]) => any
  showMainFromFloat: (...args: any[]) => any
  showTomatoFloat: (...args: any[]) => any
  startTomatoFloatDrag: (...args: any[]) => any
  stopTomatoFloatDrag: (...args: any[]) => any
  /** Pomodoro run announce channel(s): float-window run lifecycle posted to main */
  tomatoRunAnnounce: (...args: any[]) => any
  tomatoRunAnnounces: (...args: any[]) => any
  tomatoFloatPanel: (...args: any[]) => any
  tomatoFloatShown: (...args: any[]) => any
  updateSettings: (...args: any[]) => any
  updaterStatus: (...args: any[]) => any
  uploadAttachment: (...args: any[]) => any
  writeCriticalStateBackup: (...args: any[]) => any
  /** LAN sync (Device Center): two-way confirmed pairing + conflict backup recovery + unpair/alias.
   *  These dispatch through the todo-db:call whitelist (see DbCallOp). */
  syncPairRespond: (...args: any[]) => any
  syncPairRequest: (...args: any[]) => any
  syncConflictBackupsList: (...args: any[]) => any
  syncConflictBackupRestore: (...args: any[]) => any
  notifyQuitFlushDone: (...args: any[]) => any
  /** T7 win-bind (dedicated channels, NOT dbCall): zero-arg identify — PS owns the cursor;
   *  { window: WinBindWindowRef|null, reason } with window non-null ⟹ reason null */
  winBindIdentify: () => Promise<{ window: WinBindWindowRef | null, reason: 'NO_WINDOW' | 'OWN_WINDOW' | 'DESKTOP' | 'BUTTON_DOWN' | 'ADAPTER_ERROR' | 'TIMEOUT' | null }>
  /** ref must be this process's identify result verbatim; re-binding a taskId overwrites */
  winBindBind: (taskId: string, ref: WinBindWindowRef) => Promise<{ ok: true, binding: { taskId: string, ref: WinBindWindowRef } } | { ok: false, reason: 'BAD_ARGS' | 'STALE_REF' | 'OWN_WINDOW' | 'STORE_ERROR' }>
  /** bring the bound window to the foreground; flashed=true means degraded to a taskbar flash;
   *  candidates (current same-name windows) only present on AMBIGUOUS */
  winBindActivate: (taskId: string) => Promise<{ ok: true } | { ok: false, reason: 'NO_BINDING' | 'NOT_FOUND' | 'AMBIGUOUS' | 'ACTIVATE_FAILED' | 'ADAPTER_ERROR', flashed?: boolean, candidates?: Array<{ hwnd: number, pid: number, processName: string, execPath: string, title: string }> }>
  /** idempotent removal: { ok:true, removed } never rejects */
  winBindUnbind: (taskId: string) => Promise<{ ok: boolean, removed: boolean }>
  /** hydration pull; the renderer filters orphan bindings by its known taskIds */
  winBindList: () => Promise<{ bindings: Array<{ taskId: string, ref: WinBindWindowRef }> }>
  /** multi-window badge sync subscription; payload { reason:'bind'|'unbind', taskId }; returns disposer */
  onWinBindChanged: (fn: (payload: { reason: 'bind' | 'unbind', taskId: string }) => void) => () => void
}

interface Window {
  todoAPI: TodoAPI
  /** Command bus (renderer/js/utils/commandBus.js): validated/stamped mutation writes via commands:commit */
  commands: {
    commit: (entity: string, verb: string, payload?: any, opts?: any) => Promise<any>
    commitBatch: (list: Array<{ entity: string, verb: string, payload?: any, opts?: any }>) => Promise<any>
  }
  Vue: any
  dayjs: any
  Vuex: any
  VueRouter: any
  ElementPlus: any
  VueI18n: any
  pinyinPro?: { pinyin: (...args: unknown[]) => unknown[] }
  Sortable?: any
  driver?: any
  solarLunar?: any
  appUI?: any
  AppIcon?: any
  html2canvas?: any
  FullCalendar?: any
  Chart?: any
  ElementPlusLocaleZhCn?: any
  ElementPlusLocaleEn?: any
  __lastVueErr?: any
  __tomatoFloatTick?: unknown
  /** EditPanel save-queue flush hook (review P2 2026-09-22): awaited by ui/closeEditCleanup's
   *  inline-create orphan cleanup so a pending debounced title lands before the emptiness check */
  __editPanelFlushSave?: () => unknown
}
