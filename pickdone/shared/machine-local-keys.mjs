/**
 * Machine-local settings-row keys — SINGLE SOURCE shared by both sync ends:
 *   - src/main/sync-apply.js (egress hydration filter + ingress apply gate)
 *   - src/main/command-manifest.js (the localKeys classifier the ls-mirror hook reads)
 * (the manifest copy used to be a hand-maintained mirror; cli/check-command-bus.cjs asserts
 * the two ends agree — importing one module makes that hold by construction).
 *
 * ESM (.mjs) consumed from CJS via require(esm) — same precedent as shared/limits.mjs
 * (Node >= 22.12; Electron 39 embeds node 22.x).
 *
 * Domain-1 fix 2026-09-23 (F-A1): the predicate used to catch only sync.* / ^securityLock /
 * _-stamped keys. These MACHINE-level config keys slipped through (e.g.
 * /^securityLock/.test('enableSecurityLock') === false), so a peer holding the pairing
 * secret could push {enableSecurityLock:false} (or a shortcutKeySettings patch) through
 * ingress → foldSettingsIntoBlob → external-settings-changed → writeConfig, silently
 * disabling the security lock or re-registering hotkeys on THIS device — defeating the D7
 * main-ipc-1 decision that a trapped float must not turn the lock off. All four are
 * per-machine preferences (autostart, hotkeys, lock, start behavior), never user data:
 * they must neither egress nor be overwritten by a peer. SECURITY PREDICATE: only ever
 * tightened, never loosened.
 */
export const MACHINE_LOCAL_SETTING_KEYS = [
  'enableSecurityLock',
  'shortcutKeySettings',
  'runWhenComputerStart',
  'hideMainWindowOnStartup',
]

export function isMachineLocalSettingKey (id) {
  const k = String(id)
  // 'sync.' namespace = identity/pairing state (strictly local); 'securityLock*' = password
  // ciphertext (round-3 review: never egresses); leading underscore = CLI bookkeeping stamps;
  // the list above = machine-level config keys (see the F-A1 note).
  return k.startsWith('sync.') || /^securityLock/.test(k) || k.startsWith('_') ||
    MACHINE_LOCAL_SETTING_KEYS.includes(k)
}

// P1-5 (2026-09-19): prefix for dated meta conflict-backup keys (see the meta branch in
// src/main/sync-apply.js applyRowInner). Exported so sync-apply-hydrate.js's re-export keeps
// its existing require surface and the backup writer/list ops derive from one literal.
export const META_CONFLICT_BACKUP_PREFIX = 'metaConflictBackup.'

/**
 * Machine-local META keys — SINGLE SOURCE shared by both sync ends (domain-3 fix 2026-09-28;
 * the same single-sourcing the settings predicate got in F-A1):
 *   - src/main/sync-apply-hydrate.js (egress hydration filter + ingress apply gate)
 *   - src/main/command-manifest.js (the meta.put/meta.delete localKeys classifier)
 * The manifest used to carry a hand-copied 9-family mirror that had already drifted once
 * (META_CONFLICT_BACKUP_PREFIX was inlined as a literal); cli/check-command-bus.cjs asserts
 * the two ends classify an enumerated key corpus identically — importing one module makes
 * that hold by construction.
 *
 * SECURITY-PARITY PREDICATE: only ever tightened, never loosened. Every key excluded here is
 * deliberate machine-local state; any NEW user-data meta key must NOT match this filter or it
 * silently stops syncing.
 */
export function isMachineLocalMetaKey (id) {
  const k = String(id)
  return k.startsWith('sync.') || k.startsWith('_') || /^securityLock/.test(k) ||
    // 'cliTomato*' = CLI tomato runtime TRANSIENT state (per-device command/status slots);
    // 'cliSync*' = CLI sync command channel slots (cmd/receipt/seq per-machine transport state,
    // never data — syncing them would replay stale commands on the peer).
    k.startsWith('cliTomato') || k.startsWith('cliSync') ||
    k === 'todosVersion' || // per-device dirty-row cursor
    k.startsWith('firedReminders:') || k === 'reminderLastSeenAt' || // scheduler dedup watermarks
    k.startsWith('settingsRows.src.') || // v6 migration snapshot markers
    k === 'db.tomatoState' || k === 'habitsState' || // retired ledger+habits blobs (migration bookkeeping)
    k.startsWith('snowDedup:') || // M4: per-device bumpSnow dedup watermarks, not data
    // P1-5: meta LWW conflict backups are per-device recovery copies of a LOSING local edit —
    // syncing them would make the peer apply the loser as a live value and mint its own backup
    // of the backup, forever.
    k.startsWith(META_CONFLICT_BACKUP_PREFIX) ||
    // Round-3 P1: migration/bookkeeping keys — a peer's 'schemaVersion' row could REGRESS (or
    // over-advance) the local schema migrator, and legacy 'dayPlanState'/'dayPlanState.*'
    // whole-package chip JSON would re-poison a device already migrated to plan_chips.
    k === 'schemaVersion' || k === 'dayPlanState' || k.startsWith('dayPlanState.')
}
