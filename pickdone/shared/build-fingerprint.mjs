/**
 * Build fingerprint primitives (W31 P1): the ONE shared builder behind both the
 * About section in the settings modal and the main-process diagnostic payload
 * ('app:build-info'). Same function on both sides so the strings can never drift.
 * Pure module — no electron/node builtins — importable by renderer, main, and tests.
 */

/** Update channel from the version's prerelease suffix (electron-builder convention:
 * x.y.z-beta.n → beta feed; plain x.y.z → stable). Same derivation the updater relies on. */
export function channelFromVersion (v) {
  const s = String(v || '')
  if (/-alpha/i.test(s)) return 'alpha'
  if (/-beta/i.test(s)) return 'beta'
  return 'stable'
}

/** Human-readable build fingerprint: version + git SHA + channel in one string.
 * All three inputs come from build-time injection or git description — never hardcoded. */
export function buildFingerprint ({ version, gitSha, channel }) {
  return `v${version}+${gitSha} (${channel})`
}
