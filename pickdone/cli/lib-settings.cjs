/* Settings sub-module extracted from cli/lib.js (2026-09-25 size-ratchet split).
 * Factory-injected deps keep it decoupled from lib.js (no circular require), same pattern as lib-attachments.cjs.
 * Settings (meta db.settingsState mirror; hot-synced to a running App via the main-process watcher). */
module.exports = ({ open, commit, audit, CliError }) => {
  // F-B9 manifest single source: SETTINGS_MANIFEST lives verbatim in shared/settings-manifest.mjs
  // (dw wave 3) so the renderer's sanitize path can consume the same surface; re-exported below.
  const { SETTINGS_MANIFEST } = require('../shared/settings-manifest.mjs') // require(esm)
  const { stripHabitsFamily } = require('../shared/settings-families.mjs') // require(esm)
  const SETTINGS_DENIED = new Set(['securityLockPassword', 'securityLockQuestion', 'schemaV', '_savedAt'])

  function settingsDoc () {
    let doc = {}
    try { const d = JSON.parse(open().call('getMeta', 'db.settingsState') || 'null'); if (d && typeof d === 'object') doc = d } catch { /* corrupt blob → rows overlay still readable */ }
    // F3 P2 (2026-09-21): settings_rows is the field-granular sync truth (db-sync-schema.js P2 blob
    // split) while the blob is only the renderer's debounced mirror. A sync-applied row newer than the
    // blob (or a blob the mirror never refreshed) used to be invisible here, and settingsSet then
    // re-merged from that stale whole-blob read and re-stamped it over the newer peer row. Overlay the
    // non-deleted rows over the blob (rows win) so every CLI read starts from the converged doc.
    try {
      for (const r of open().call('settingsRowsAll') || []) {
        if (!r || r.deleted || r.key == null) continue
        doc[r.key] = r.value
      }
    } catch { /* pre-v6 DB without the rows table → blob-only read (previous behavior) */ }
    return doc
  }
  /** Test-only seam: invoked inside settingsSet between the first settingsDoc() read and the fresh re-read (simulates a concurrent App-side write). */
  let settingsRaceHook = null
  function setSettingsRaceHookForTests (fn) { settingsRaceHook = typeof fn === 'function' ? fn : null }
  function settingsKnown (key) {
    if (SETTINGS_MANIFEST.boolean.includes(key)) return { type: 'boolean' }
    if (SETTINGS_MANIFEST.number.includes(key)) return { type: 'number' }
    if (SETTINGS_MANIFEST.enum[key]) return { type: 'enum', options: SETTINGS_MANIFEST.enum[key] }
    if (SETTINGS_MANIFEST.string.includes(key)) return { type: 'string' }
    return null
  }
  function settingsList () {
    const doc = settingsDoc()
    const rows = []
    const all = [
      ...SETTINGS_MANIFEST.boolean.map(k => [k, { type: 'boolean' }]),
      ...SETTINGS_MANIFEST.number.map(k => [k, { type: 'number' }]),
      ...Object.entries(SETTINGS_MANIFEST.enum).map(([k, o]) => [k, { type: 'enum', options: o }]),
      ...SETTINGS_MANIFEST.string.map(k => [k, { type: 'string' }])
    ]
    for (const [key, info] of all) rows.push({ key, type: info.type, options: info.options || null, value: key in doc ? doc[key] : null })
    return rows
  }
  function settingsSet (key, value, { force = false } = {}) {
    if (SETTINGS_DENIED.has(key)) throw new CliError('"' + key + '" is a protected key and cannot be set via CLI', 'DENIED_KEY')
    const info = settingsKnown(key)
    if (!info) throw new CliError('unknown setting "' + key + '" — settings list to browse keys', 'UNKNOWN_KEY')
    let v = value
    if (info.type === 'boolean') {
      if (/^(true|1|yes|on)$/i.test(String(value))) v = true
      else if (/^(false|0|no|off)$/i.test(String(value))) v = false
      else throw new CliError('"' + key + '" expects true|false', 'USAGE')
    } else if (info.type === 'number') {
      v = Number(value)
      // Fix (2026-09-16): the old isNaN check caught NaN but let Infinity through — JSON.stringify then stored
      // null in the settings blob. Negative values are meaningless for every numeric setting (targets,
      // thresholds, intervals, volumes, counts), so both are rejected now.
      if (!Number.isFinite(v)) throw new CliError('"' + key + '" expects a finite number (got "' + value + '")', 'USAGE')
      if (v < 0) throw new CliError('"' + key + '" must be >= 0 (got "' + value + '")', 'USAGE')
      // P3-6 (dw wave): per-key bounds mirroring the UI's input controls (SETTINGS_MANIFEST.ranges) —
      // the CLI used to accept any non-negative number where the App's slider/input clamps
      // (e.g. tomatoTime 5-180), so a CLI-written value silently displayed out of bounds in the App.
      const range = SETTINGS_MANIFEST.ranges[key]
      if (range && (v < range.min || v > range.max)) {
        throw new CliError(`"${key}" must be between ${range.min} and ${range.max} (got "${value}")`, 'USAGE')
      }
    } else if (info.type === 'enum') {
      if (!info.options.includes(String(value))) throw new CliError(`"${key}" expects one of: ${info.options.join(' | ')} (got "${value}")`, 'USAGE')
      v = String(value)
    }
    // Concurrency guard (2026-09-16, reworked 2026-09-19, F3 root fix 2026-09-21): the write goes to the
    // ROW path first (setting.put → settings_rows, the field-granular sync truth with per-field LWW),
    // THEN the blob is refreshed from a fresh settingsDoc() read (which now overlays rows over the blob).
    // The old whole-blob re-merge stamped a fresh _savedAt onto a doc read from the possibly-stale
    // blob, so it passed the mirror gate (db-sync-schema putRow gateTs) and clobbered newer peer rows
    // wholesale. The refreshed blob is built from the converged doc, so its bridge mirror is a
    // value-identical no-op — while the _savedAt bump keeps the two local blob consumers working (the
    // main-process hot-sync watcher diffs _savedAt; renderer initFromDb restores from the blob).
    // F-B1 (dw wave 3): settings_rows carries BOTH blob families (db.settingsState AND db.habitsState
    // — SYNC_BLOB_KEYS share the table), so the whole-doc read above can carry habits-family fields
    // (habits/moments/savedAt). Writing them back inside db.settingsState let the settings blob
    // swallow the habits state (renderer initFromDb then read a blob whose keys mixed families).
    // The write-back strips the habits-exclusive family (shared/settings-families.mjs — the same
    // contract lan-sync-bootstrap's foldSettingsIntoBlob routes by).
    const doc = settingsDoc()
    const before = key in doc ? doc[key] : null
    // F-B1 secondary fix: the blob's _savedAt doubles as the bridge's LWW gateTs (db-sync-schema
    // putRow). Stamping it at WRITE time made the gate a tautology — a stale echo read BEFORE a
    // sync-apply landed was re-stamped to now and re-won the row. Stamp the PRE-WRITE read moment
    // instead (captured right after the first read, BEFORE the race hook can inject a concurrent
    // apply): rows applied between the two reads are newer than the blob snapshot and keep winning.
    const readAt = Date.now()
    // Test seam: inject a concurrent mutation into the race window (first read → row write) so unit
    // tests can deterministically exercise the merge-on-fresh behavior. Null outside tests.
    if (typeof settingsRaceHook === 'function') settingsRaceHook()
    commit('setting', 'put', { key, value: v })
    // B15 (2026-09-24): the blob write-back is a WHITELIST rebuild, not a passthrough — DEFAULT_SETTINGS
    // keys (the manifest families + blob-only maps + the two local-only keys) plus the blob's own
    // meta fields. Otherwise dirty keys (renamed-away settings, foreign blobs) rode every write-back
    // forever: the blob could never slim down and renderer initFromDb kept resurrecting them.
    const blobAllow = new Set([
      ...SETTINGS_MANIFEST.boolean, ...SETTINGS_MANIFEST.number,
      ...Object.keys(SETTINGS_MANIFEST.enum), ...SETTINGS_MANIFEST.string,
      ...(SETTINGS_MANIFEST.blobOnly || []),
      'shortcutKeySettings', 'foldedTodoList', // intentionally local-only (manifest header) but still DEFAULT_SETTINGS blob keys
      '_savedAt', 'schemaV', '_lsAt'
    ])
    const fresh = stripHabitsFamily(settingsDoc())
    for (const k of Object.keys(fresh)) { if (!blobAllow.has(k)) delete fresh[k] }
    fresh._savedAt = readAt
    fresh.schemaV = fresh.schemaV || 1
    commit('meta', 'put', ['db.settingsState', JSON.stringify(fresh)])
    audit.record({ action: 'settings.set', targets: [], changes: [{ before: { [key]: before }, after: { [key]: v } }], note: 'setting "' + key + '" changed (hot-synced to running App, applied on launch otherwise)' })
    return { key, value: v, previous: before }
  }

  return { settingsDoc, setSettingsRaceHookForTests, settingsKnown, settingsList, settingsSet, SETTINGS_MANIFEST }
}
