/**
 * 渲染端全局契约(window 注入面 + 关键数据形状)——SSOT 是 src/main:
 *  - DbCallOp 联合类型来自 src/main/index.js ALLOWED_RENDERER_OPS(30 op,与 cli/check-ipc-op-coverage 同源;
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

type DbCallOp = 'getById' | 'getAll' | 'queryTodos' | 'getMeta' | 'upsert' | 'upsertMany' | 'hardDelete' | 'hardDeleteMany' | 'setMeta' | 'getAllCategories' | 'upsertCategory' | 'filterList' | 'filterUpsert' | 'filterDelete' | 'countAll' | 'countSeedTodos' | 'bumpSnow' | 'planAll' | 'planAddMany' | 'planUpdateChip' | 'planRemoveIds' | 'planMoveTask' | 'planDeleteTask' | 'planDeleteTaskDay' | 'planPrune' | 'tomatoAll' | 'tomatoAppendMany' | 'tomatoUpdateById' | 'tomatoRemoveByIds' | 'tomatoMigrateFromMeta'

interface TodoAPI {
  /** DB 白名单调用面:渲染端所有持久化读写必须经此(db.call);op 联合与主进程白名单同源 */
  dbCall (op: DbCallOp, params?: any): Promise<any>
  version?: string
  /** 数据隔离标记(TODO_USER_DATA_DIR 存在=false 并列调试实例共用真库) */
  isDataIsolated: boolean
  decryptSecret: (...args: any[]) => any
  verifyLockPassword: (...args: any[]) => any
  unlockApp: (...args: any[]) => any
  hideWindow: (...args: any[]) => any
  downloadAndOpen: (...args: any[]) => any
  saveToDownloads: (...args: any[]) => any
  syncNow: (...args: any[]) => any
  mimeByType: (...args: any[]) => any
  onSelectTodo: (...args: any[]) => any
  checkForUpdates: (...args: any[]) => any
  closeRequest: (...args: any[]) => any
  deleteFile: (...args: any[]) => any
  deleteTodoFilesRelevant: (...args: any[]) => any
  downloadUpdate: (...args: any[]) => any
  encryptSecret: (...args: any[]) => any
  ensureWindowWidth: (...args: any[]) => any
  exportXlsx: (...args: any[]) => any
  flushTomatoFloat: (...args: any[]) => any
  getDefaultBackupDir: (...args: any[]) => any
  getSettings: (...args: any[]) => any
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
  onExternalSettingsChanged: (...args: any[]) => any
  onOpenSettings: (...args: any[]) => any
  onPlaySound: (...args: any[]) => any
  onQuickAddFocus: (...args: any[]) => any
  onSecurityLock: (...args: any[]) => any
  onSecurityUnlock: (...args: any[]) => any
  onShortcutAction: (...args: any[]) => any
  onShortcutConflict: (...args: any[]) => any
  onTodosChanged: (...args: any[]) => any
  onTomatoRecordsChanged: (...args: any[]) => any
  onTomatoTaskbarCmd: (...args: any[]) => any
  onUpdaterEvent: (...args: any[]) => any
  openExternal: (...args: any[]) => any
  openFile: (...args: any[]) => any
  openLogsDir: (...args: any[]) => any
  pickAudioFile: (...args: any[]) => any
  pickBackupDir: (...args: any[]) => any
  purgeRecycleBin: (...args: any[]) => any
  purgeSeedTodos: (...args: any[]) => any
  pushTomatoTaskbar: (...args: any[]) => any
  quickAddHide: (...args: any[]) => any
  quitAndInstall: (...args: any[]) => any
  readAutoBackup: (...args: any[]) => any
  readCriticalStateBackup: (...args: any[]) => any
  runAutoBackup: (...args: any[]) => any
  setAppLocale: (...args: any[]) => any
  setTomatoFloatBounds: (...args: any[]) => any
  showMainFromFloat: (...args: any[]) => any
  showTomatoFloat: (...args: any[]) => any
  startTomatoFloatDrag: (...args: any[]) => any
  stopTomatoFloatDrag: (...args: any[]) => any
  tomatoFloatPanel: (...args: any[]) => any
  tomatoFloatShown: (...args: any[]) => any
  updateSettings: (...args: any[]) => any
  updaterStatus: (...args: any[]) => any
  uploadAttachment: (...args: any[]) => any
  writeCriticalStateBackup: (...args: any[]) => any
}

interface Window {
  todoAPI: TodoAPI
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
}
