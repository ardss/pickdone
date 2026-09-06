/** Simple KV config store (config.json) inside userData — moved verbatim from index.js (content unchanged) */
const path = require('path')
const fs = require('fs')
const { app } = require('electron')

const DEFAULT_SHORTCUTS = {
  // quickAddGlobal 旧默认 ctrl+shift+a 与微信/QQ 截图热键冲突(国内环境注册必败),2026-09-05 改 alt+shift+t(T=Todo 好记)
  sync: 'ctrl+s', toggleMainWindow: '', quickAddGlobal: 'alt+shift+t', addEvent: 'ctrl+n', deleteEvent: 'ctrl+d',
  pinEvent: '', unpinEvent: '', toggleAllSubtasks: '', startPomodoro: '',
  switchToDaytodo: 'ctrl+1', switchToRecentTodos: 'ctrl+2', switchToSchedule: 'ctrl+3', switchToInbox: 'ctrl+4'
}
function configFile () { return path.join(app.getPath('userData'), 'config.json') }
function readConfig () {
  try {
    const c = JSON.parse(fs.readFileSync(configFile(), 'utf8'))
    // Fill in defaults key by key: replacing only when the whole object is missing would make old configs miss later-added keys (settings page shows "not set")
    c.shortcutKeySettings = { ...DEFAULT_SHORTCUTS, ...(c.shortcutKeySettings || {}) }
    // 旧默认值一次性迁移:存量化配置里还钉着冲突键 ctrl+shift+a 的搬到新默认
    if (c.shortcutKeySettings.quickAddGlobal === 'ctrl+shift+a') c.shortcutKeySettings.quickAddGlobal = DEFAULT_SHORTCUTS.quickAddGlobal
    return c
  } catch { return { shortcutKeySettings: { ...DEFAULT_SHORTCUTS } } }
}
function writeConfig (patch) {
  const c = Object.assign(readConfig(), patch)
  fs.mkdirSync(path.dirname(configFile()), { recursive: true })
  // Atomic write (tmp+rename): a truncated config.json makes readConfig silently fall back to defaults, losing winBounds/locale/security-lock password
  const tmp = configFile() + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(c, null, '\t'))
  fs.renameSync(tmp, configFile())
  return c
}

module.exports = { readConfig, writeConfig, DEFAULT_SHORTCUTS }
