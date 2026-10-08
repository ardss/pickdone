// Lightweight main-process i18n: tray menu / system dialogs / notification fallback / About page
// Locale source: appLocale in config.json (written by the renderer's setLocale via 'set-app-locale');
// when unset, preselect based on the system language. Message keys are decoupled from the renderer's stats*. chunks and maintained independently.
// electron only exists inside the packaged App; the standalone CLI bundle has no electron module —
// fall back to a stub so locale resolution just uses zh-CN defaults instead of crashing at require time
let app
try { app = require('electron').app } catch { app = { getPath () { throw new Error('no electron') }, getLocale () { return 'zh-CN' } } }

let cachedLocale = null
// D13 C3 (2026-10-01): single source of truth for "is this a locale the app ships". The read
// side (currentLocale) only ever recognized exact 'en-US', and the write side (set-app-locale)
// persisted whatever string arrived — so appLocale 'zh-CN' in config.json silently fell through
// to system detection, and any junk value ('fr-FR' from a hostile/buggy renderer) flipped the
// app to the system default on the next launch. Both sides now go through this normalizer.
function normalizeLocale (v) { return (v === 'en-US' || v === 'zh-CN') ? v : null }
function systemLocale () {
  try { return (app.getLocale() || '').toLowerCase().startsWith('en') ? 'en-US' : 'zh-CN' } catch { return 'zh-CN' }
}
function currentLocale () {
  if (cachedLocale) return cachedLocale
  try {
    const fs = require('fs')
    const path = require('path')
    let raw = null
    try {
      raw = fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8')
    } catch (readErr) {
      // Fix (2026-10-06): a TRANSIENT config read failure (Windows AV/indexer EPERM/EBUSY)
      // used to fall into the same branch as "no config yet" and cache the system default
      // for the whole session — the user's stored locale never applied until restart.
      // Genuinely absent (ENOENT, first launch) is a stable state: cache the system default.
      // Anything else is transient: return the fallback WITHOUT caching so the next call retries.
      if (readErr && readErr.code === 'ENOENT') { cachedLocale = systemLocale(); return cachedLocale }
      return systemLocale()
    }
    const stored = normalizeLocale(JSON.parse(raw).appLocale)
    if (stored) { cachedLocale = stored; return cachedLocale }
    // Config read fine but no/invalid appLocale: the system default is deterministic here — cache it.
    cachedLocale = systemLocale()
    return cachedLocale
  } catch (e) {
    // unreadable/corrupt config: retry on the next call instead of locking the locale in
    return systemLocale()
  }
}
function setLocale (locale) { cachedLocale = normalizeLocale(locale) || 'zh-CN' }

const MESSAGES = {
  'zh-CN': {
    appName: '拾事',
    startupFailed: '启动失败',
    trayShowFloat: '显示番茄悬浮窗',
    trayDockFloat: '收起番茄悬浮窗到托盘',
    trayOpen: '打开拾事',
    trayQuit: '退出',
    quitFocusActiveTitle: '专注进行中',
    quitFocusActiveMsg: '退出将放弃当前进行中的番茄，且不会记入专注账本。确定要退出吗？',
    quitFocusQuit: '放弃专注并退出',
    quitFocusCancel: '取消退出',
    closeTrayNotice: '已最小化到托盘，提醒照常运行。点托盘图标可重新打开；想直接退出可在「设置 → 通用」中修改。',
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
    pairNotifyTitle: 'PickDone — 新设备配对请求',
    pairNotifyBody: '{who} 请求同步配对，请在设置中确认',
    pairNotifyBodyUnknown: '有设备请求同步配对，请在设置中确认',
    aboutSlogan: '把散落的事拾起来，挑一件、做完它',
    aboutVersion: '版本 {v} · 本地离线优先',
    exportSheetTitle: '拾事：事件内容',
    exportCols: 'taskId,日期,分类,标题,描述,子任务,是否完成,工作量,提醒时间,提醒偏移(分),重复规则,截止日期,重要,紧急,难度,优先级,完成时间',
    dbEncNoKey: 'todos.db 已加密但找不到 db.key（建议从备份恢复或重置数据）',
    dbEncMismatch: 'todos.db 与 db.key 不匹配（建议从备份恢复或重置数据）: {msg}',
    lockTitle: '应用已锁定',
    lockPlaceholder: '输入密码解锁',
    lockUnlock: '解锁',
    lockWrongPassword: '密码错误',
    quarantineBody: '配置文件（config.json）已损坏且无法读取，原文件已保留为 config.json.bad。本次会话的设置已重置，应用锁也已停用，如需要请重新开启。'
  },
  'en-US': {
    appName: 'PickDone',
    startupFailed: 'Startup failed',
    trayShowFloat: 'Show pomodoro floater',
    trayDockFloat: 'Dock pomodoro floater to tray',
    trayOpen: 'Open PickDone',
    closeTrayNotice: 'Minimized to tray — reminders keep running. Click the tray icon to reopen; switch to direct quit in Settings → General.',
    trayQuit: 'Quit',
    quitFocusActiveTitle: 'Focus session in progress',
    quitFocusActiveMsg: 'Quitting now abandons the running pomodoro and it will NOT be recorded in the focus ledger. Quit anyway?',
    quitFocusQuit: 'Abandon focus and quit',
    quitFocusCancel: 'Cancel quit',
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
    pairNotifyTitle: 'PickDone — New device pairing request',
    pairNotifyBody: '{who} requests sync pairing, confirm it in Settings',
    pairNotifyBodyUnknown: 'A device requests sync pairing, confirm it in Settings',
    aboutSlogan: 'Pick up scattered things, pick one and finish it',
    aboutVersion: 'Version {v} · Local offline first',
    exportSheetTitle: 'PickDone: Todo content',
    exportCols: 'taskId,Date,Category,Title,Description,Subtasks,Done,Workload,Reminder,Reminder offset (min),Repeat rule,Deadline,Important,Urgent,Difficulty,Priority,Completed at',
    dbEncNoKey: 'todos.db is encrypted but db.key is missing (restore from backup or reset data)',
    dbEncMismatch: 'todos.db does not match db.key (restore from backup or reset data): {msg}',
    lockTitle: 'App locked',
    lockPlaceholder: 'Enter password to unlock',
    lockUnlock: 'Unlock',
    lockWrongPassword: 'Wrong password',
    quarantineBody: 'Your config file (config.json) was corrupted and could not be read. The previous file was preserved as config.json.bad. Settings are reset for this session and the security lock is disabled until you re-enable it.'
  }
}

// Resolve a message for an explicit locale (falling back to zh-CN), so callers that already
// know the target locale (e.g. notice builders passed a locale) skip currentLocale resolution.
function mtIn (locale, key, params) {
  const dict = MESSAGES[normalizeLocale(locale)] || MESSAGES['zh-CN']
  let v = dict[key] !== undefined ? dict[key] : (MESSAGES['zh-CN'][key] !== undefined ? MESSAGES['zh-CN'][key] : key)
  if (params) v = String(v).replace(/\{(\w+)\}/g, (m, p) => params[p] !== undefined ? params[p] : m)
  return v
}

function mt (key, params) { return mtIn(currentLocale(), key, params) }

module.exports = { mt, mtIn, setLocale, currentLocale, normalizeLocale }
