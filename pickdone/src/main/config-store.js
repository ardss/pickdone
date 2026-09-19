/** Simple KV config store (config.json) inside userData — moved verbatim from index.js (content unchanged) */
const path = require('path')
const fs = require('fs')
// Resolved at module load (test harnesses stub electron via require interception at load time);
// try/catch keeps the module requireable from plain Node unit tests (they point configFile at a
// temp dir via __setConfigDir and never touch userData).
let _app = null
try { _app = require('electron').app } catch { /* plain node */ }

const DEFAULT_SHORTCUTS = {
  // quickAddGlobal 旧默认 ctrl+shift+a 与微信/QQ 截图热键冲突(国内环境注册必败),2026-09-05 改 alt+shift+t(T=Todo 好记)
  sync: 'ctrl+s', toggleMainWindow: '', quickAddGlobal: 'alt+shift+t', addEvent: 'ctrl+n', deleteEvent: 'ctrl+d',
  pinEvent: '', unpinEvent: '', toggleAllSubtasks: '', startPomodoro: '',
  switchToDaytodo: 'ctrl+1', switchToRecentTodos: 'ctrl+2', switchToSchedule: 'ctrl+3', switchToInbox: 'ctrl+4'
}
// electron is resolved at module load (see top); __setConfigDir lets plain-Node unit tests point
// configFile at a temp dir without any electron dependency.
let _configDirOverride = null
function __setConfigDir (dir) { _configDirOverride = dir } // test-only
function configFile () { return path.join(_configDirOverride || _app.getPath('userData'), 'config.json') }
// P2 2026-09-20: when the unreadable config could NOT be quarantined (rename to .bad failed —
// AV/lock/permission), a subsequent writeConfig() would merge defaults over the still-in-place
// file and clobber whatever readable state it held. `_readFailed` gates writes off until the next
// SUCCESSFUL read path clears it (the file became readable/quarantined again).
let _readFailed = false
function isReadFailed () { return _readFailed }
function readConfig () {
  try {
    const c = JSON.parse(fs.readFileSync(configFile(), 'utf8'))
    // Fill in defaults key by key: replacing only when the whole object is missing would make old configs miss later-added keys (settings page shows "not set")
    c.shortcutKeySettings = { ...DEFAULT_SHORTCUTS, ...(c.shortcutKeySettings || {}) }
    // 旧默认值一次性迁移:存量化配置里还钉着冲突键 ctrl+shift+a 的搬到新默认
    if (c.shortcutKeySettings.quickAddGlobal === 'ctrl+shift+a') c.shortcutKeySettings.quickAddGlobal = DEFAULT_SHORTCUTS.quickAddGlobal
    _readFailed = false
    return c
  } catch (e) {
    // Only a genuinely missing file is a first install — return defaults silently.
    if (e && e.code === 'ENOENT') { _readFailed = false; return { shortcutKeySettings: { ...DEFAULT_SHORTCUTS } } }
    // 2026-09-10 P2: any OTHER failure (JSON parse error from a truncated write, EACCES/EBUSY IO) used to
    // fall through to the same fresh-install default — and the next writeConfig() persisted that amputated
    // object, permanently resetting winBounds/locale/lockPassword. Keep the evidence instead: rename the
    // bad file to config.json.bad (best-effort) so it can be inspected or recovered by hand; those keys
    // are lost from the live config but NOT destroyed.
    // P2 2026-09-20: the rename itself used to be swallowed silently; when it FAILS the unreadable
    // file is still in place, so writes must be gated off (no clobber) instead of proceeding.
    try {
      fs.renameSync(configFile(), configFile() + '.bad')
      _readFailed = false
    } catch (renameErr) {
      console.warn('[config-store] quarantine of unreadable config.json failed:', renameErr && renameErr.message, '- writes are gated off until a read succeeds')
      _readFailed = true
    }
    return { shortcutKeySettings: { ...DEFAULT_SHORTCUTS } }
  }
}
// P2 2026-09-19 single-flight write queue: writes go through one serialization gate so read-modify-
// write cycles can never interleave or reorder. Today the write body is fully synchronous, which
// already serializes on Node's single thread — the inline fast path preserves that (the file is on
// disk before writeConfig returns, and sync try/catch callers keep working) while the `_pending`
// guard + promise chain make the single-flight guarantee explicit and hold if the write ever gains
// an await. Additionally, a failed write no longer leaves config.json.tmp residue.
let _pending = 0
let _writeChain = Promise.resolve()
function writeConfig (patch) {
  // P2 2026-09-20: read-failure gate — the unreadable config is still on disk (quarantine rename
  // failed); merging defaults into a write would destroy the last readable state. Skip the write;
  // the next successful readConfig() clears the gate and normal writes resume.
  if (_readFailed) {
    console.warn('[config-store] writeConfig skipped: config.json is unreadable and could not be quarantined (preserving on-disk state)')
    return null
  }
  const exec = () => {
    const c = Object.assign(readConfig(), patch)
    fs.mkdirSync(path.dirname(configFile()), { recursive: true })
    // Atomic write (tmp+rename): a truncated config.json used to make readConfig silently fall back to
    // defaults (readConfig now quarantines it as config.json.bad instead), losing winBounds/locale/security-lock password
    const tmp = configFile() + '.tmp'
    try {
      fs.writeFileSync(tmp, JSON.stringify(c, null, '\t'))
      fs.renameSync(tmp, configFile())
    } catch (e) {
      // Never leave config.json.tmp residue behind: a stale tmp invites tools/AV to resurrect or diff
      // it, and it masks whether the last write landed. Clean up, then rethrow the original error.
      try { fs.rmSync(tmp, { force: true }) } catch { /* best-effort */ }
      throw e
    }
    return c
  }
  if (_pending === 0) {
    _pending++
    try { return exec() } finally { _pending-- }
  }
  // Only reachable if exec ever becomes async: serialize behind the chain (single-flight).
  const result = _writeChain.then(exec, exec)
  _writeChain = result.then(() => {}, () => {})
  return result
}

module.exports = { readConfig, writeConfig, isReadFailed, DEFAULT_SHORTCUTS, __setConfigDir }
