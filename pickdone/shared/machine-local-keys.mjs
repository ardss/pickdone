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
