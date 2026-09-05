// Lightweight main-process i18n: tray menu / system dialogs / notification fallback / About page
// Locale source: appLocale in config.json (written by the renderer's setLocale via 'set-app-locale');
// when unset, preselect based on the system language. Message keys are decoupled from the renderer's stats*. chunks and maintained independently.
// electron only exists inside the packaged App; the standalone CLI bundle has no electron module —
// fall back to a stub so locale resolution just uses zh-CN defaults instead of crashing at require time
let app
try { app = require('electron').app } catch { app = { getPath () { throw new Error('no electron') }, getLocale () { return 'zh-CN' } } }

let cachedLocale = null
function currentLocale () {
  if (cachedLocale) return cachedLocale
  try {
    const fs = require('fs')
    const path = require('path')
    const c = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8'))
    if (c.appLocale === 'en-US') { cachedLocale = 'en-US'; return cachedLocale }
  } catch (e) { /* no config file (first launch) — fall back to system language */ }
  try {
    cachedLocale = (app.getLocale() || '').toLowerCase().startsWith('en') ? 'en-US' : 'zh-CN'
  } catch (e) { cachedLocale = 'zh-CN' }
  return cachedLocale
}
function setLocale (locale) { cachedLocale = locale === 'en-US' ? 'en-US' : 'zh-CN' }

const MESSAGES = {
  'zh-CN': {
    appName: '拾事',
    startupFailed: '启动失败',
    trayShowFloat: '显示番茄悬浮窗',
    trayDockFloat: '收起番茄悬浮窗到托盘',
    trayOpen: '打开拾事',
    trayQuit: '退出',
    notifyDefault: '提醒',
    todoRemindTitle: '待办提醒',
    todoRemindBody: '时间到了！',
    remindOffsetEarly: '提前 {t} {u}',
    remindOffsetLate: '延后 {t} {u}',
    remindUnitDay: '天',
    remindUnitHour: '小时',
    remindUnitMin: '分钟',
    shortcutConflict: '全局快捷键 {key} 注册失败，可能已被其他程序占用',
    dbFailTitle: '拾事',
    dbFailMessage: '数据库初始化失败',
    dbFailRecovered: '检测到本地备份数据（已回灌 {n} 条），可选择「尝试恢复数据并重启」。',
    dbFailRecoveredNone: '未找到可自动恢复的备份，如需保留现场请先「打开数据文件夹」备份文件。',
    dbFailReinit: ' 重新初始化出错：{msg}',
    btnRecoverRelaunch: '尝试恢复数据并重启',
    btnOpenDataDir: '打开数据文件夹',
    btnOpenDataDirBackup: '打开数据文件夹（先备份文件）',
    btnResetRelaunch: '重置数据并重启',
    btnQuit: '退出',
    exportTitle: '导出到本地',
    pickBackupDir: '选择备份存储位置',
    importPickCsv: '选择要导入的备份 CSV 文件',
    pickAudio: '音频',
    aboutSlogan: '把散落的事拾起来，挑一件、做完它',
    aboutVersion: '版本 {v} · 本地离线优先',
    exportSheetTitle: '拾事：事件内容',
    exportCols: 'taskId,日期,分类,标题,描述,子任务,是否完成,工作量,提醒时间,提醒偏移(分),重复规则,截止日期,重要,紧急,难度',
    dbEncNoKey: 'todos.db 已加密但找不到 db.key（建议从备份恢复或重置数据）',
    dbEncMismatch: 'todos.db 与 db.key 不匹配（建议从备份恢复或重置数据）: {msg}',
    lockTitle: '应用已锁定',
    lockPlaceholder: '输入密码解锁',
    lockUnlock: '解锁',
    lockWrongPassword: '密码错误'
  },
  'en-US': {
    appName: 'PickDone',
    startupFailed: 'Startup failed',
    trayShowFloat: 'Show pomodoro floater',
    trayDockFloat: 'Dock pomodoro floater to tray',
    trayOpen: 'Open PickDone',
    trayQuit: 'Quit',
    notifyDefault: 'Reminder',
    todoRemindTitle: 'Todo reminder',
    todoRemindBody: 'Time is up!',
    remindOffsetEarly: '{t} {u} early',
    remindOffsetLate: '{t} {u} later',
    remindUnitDay: 'day',
    remindUnitHour: 'hour',
    remindUnitMin: 'min',
    shortcutConflict: 'Global shortcut {key} failed to register, it may already be in use',
    dbFailTitle: 'PickDone',
    dbFailMessage: 'Database failed to initialize',
    dbFailRecovered: 'Local backup detected ({n} tasks restored). You can "Recover data and restart".',
    dbFailRecoveredNone: 'No auto-recoverable backup found. Back up files via "Open data folder" first if needed.',
    dbFailReinit: ' Re-initialization failed: {msg}',
    btnRecoverRelaunch: 'Recover data and restart',
    btnOpenDataDir: 'Open data folder',
    btnOpenDataDirBackup: 'Open data folder (back up first)',
    btnResetRelaunch: 'Reset data and restart',
    btnQuit: 'Quit',
    exportTitle: 'Export to local',
    pickBackupDir: 'Choose backup storage location',
    importPickCsv: 'Choose a backup CSV file to import',
    pickAudio: 'Audio',
    aboutSlogan: 'Pick up scattered things, pick one and finish it',
    aboutVersion: 'Version {v} · Local offline first',
    exportSheetTitle: 'PickDone: Todo content',
    exportCols: 'taskId,Date,Category,Title,Description,Subtasks,Done,Workload,Reminder,Reminder offset (min),Repeat rule,Deadline,Important,Urgent,Difficulty',
    dbEncNoKey: 'todos.db is encrypted but db.key is missing (restore from backup or reset data)',
    dbEncMismatch: 'todos.db does not match db.key (restore from backup or reset data): {msg}',
    lockTitle: 'App locked',
    lockPlaceholder: 'Enter password to unlock',
    lockUnlock: 'Unlock',
    lockWrongPassword: 'Wrong password'
  }
}

function mt (key, params) {
  const dict = MESSAGES[currentLocale()] || MESSAGES['zh-CN']
  let v = dict[key] !== undefined ? dict[key] : (MESSAGES['zh-CN'][key] !== undefined ? MESSAGES['zh-CN'][key] : key)
  if (params) v = String(v).replace(/\{(\w+)\}/g, (m, p) => params[p] !== undefined ? params[p] : m)
  return v
}

module.exports = { mt, setLocale, currentLocale }
