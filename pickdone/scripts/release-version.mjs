/**
 * Shared release-version validation for scripts/release.mjs + scripts/release-finalize.mjs.
 * P1-1 (review R5): the scripts used to hard-require /^\d+\.\d+\.\d+$/, which blocked shipping
 * the current package.json version (0.4.0-beta.15). Accept X.Y.Z with an optional -prerelease
 * suffix (semver build metadata after '+' is NOT accepted — release tags are vX.Y.Z[-pre]).
 * Pure functions so tests/unit can cover both scripts' gates without spawning them.
 */
export const RELEASE_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/

/** True when `v` is a releasable version string (X.Y.Z or X.Y.Z-prerelease). */
export function isReleaseVersion (v) {
  return typeof v === 'string' && RELEASE_VERSION_RE.test(v)
}
