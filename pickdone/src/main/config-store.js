/** Simple KV config store (config.json) inside userData — moved verbatim from index.js (content unchanged) */
const path = require('path')
const fs = require('fs')
// Resolved at module load (test harnesses stub electron via require interception at load time);
// try/catch keeps the module requireable from plain Node unit tests (they point configFile at a
// temp dir via __setConfigDir and never touch userData).
let _app = null
try { _app = require('electron').app } catch { /* plain node */ }

// P2-3 (maint/dw 2026-09-23): the factory shortcut table moved to shared/shortcut-defaults.mjs —
// single source with the renderer's restore-defaults button (which used to carry a drifted
// hand-copied literal that re-enabled 1 global hotkey + 4 in-app shortcuts on reset+save).
const { DEFAULT_SHORTCUTS } = require('../../shared/shortcut-defaults.mjs')
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
// Round-3 stability (2026-09-26): a successful quarantine (rename to .bad) used to be fully
// silent — the security lock stayed off and user settings reset for the session with no
// user-visible notice anywhere. Record the event and let the app consume it (read-and-clear)
// at startup to surface one notice. Notice-only: the fail-open semantics are unchanged.
let _quarantineNotice = false
function consumeQuarantineNotice () {
  const had = _quarantineNotice
  _quarantineNotice = false
  return had
}
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
      // Round-3 stability (2026-09-26): a SUCCESSFUL quarantine was the one fully silent path —
      // only the failed rename logged. Warn here too and raise the user-visible notice flag.
      _quarantineNotice = true
      console.warn('[config-store] unreadable config.json quarantined as config.json.bad — previous settings preserved there; security lock disabled until re-enabled')
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
// D6 P2 (2026-09-21): prototype-pollution-safe merge. Object.assign SETS properties — an own
// '__proto__' key on the patch (arriving via JSON.parse from a hostile config/renderer channel)
// rewrites the target's prototype instead of landing as data. Spread + hasOwn copy loop DEFINE
// properties instead: '__proto__' stays an inert own key (and is dropped outright below).
function mergeConfig (base, patch) {
  // Spread = DefineOwnProperty: even if base somehow carries an own '__proto__' key it lands as
  // inert data, never as a prototype write.
  const c = { ...base }
  if (patch && typeof patch === 'object') {
    for (const k of Object.keys(patch)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue // own-key filter
      c[k] = patch[k]
    }
  }
  return c
}
function writeConfig (patch) {
  // P2 2026-09-20: read-failure gate — the unreadable config is still on disk (quarantine rename
  // failed); merging defaults into a write would destroy the last readable state. Skip the write;
  // the next successful readConfig() clears the gate and normal writes resume.
  if (_readFailed) {
    console.warn('[config-store] writeConfig skipped: config.json is unreadable and could not be quarantined (preserving on-disk state)')
    return null
  }
  const exec = () => {
    // D6 P2 (2026-09-21): mergeConfig replaces Object.assign — prototype-pollution-safe (see above).
    const c = mergeConfig(readConfig(), patch)
    fs.mkdirSync(path.dirname(configFile()), { recursive: true })
    // Atomic write (tmp+rename) — main-ipc-2 fsync fix (2026-09-22): writeFileDurable adds an
    // fsync of the file data before the rename (and a best-effort dir fsync), so a power cut can
    // no longer persist the rename while the new content is still OS-cached-only (a truncated/
    // stale config.json = lost winBounds/locale/security-lock state). The helper owns the tmp
    // lifecycle and guarantees no residue on failure.
    require('./durable-fs').writeFileDurable(configFile(), JSON.stringify(c, null, '\t'))
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

module.exports = { readConfig, writeConfig, isReadFailed, consumeQuarantineNotice, DEFAULT_SHORTCUTS, __setConfigDir }
