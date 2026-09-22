/**
 * Shared version-format gate for the release tooling (release.mjs / release-finalize.mjs).
 * Historically both scripts inlined a strict /^\d+\.\d+\.\d+$/ check, which blocked the
 * prerelease channel entirely: with package.json at 0.4.0-beta.15 there was no version
 * string the scripts would accept, so every release step had to be run by hand.
 * Accepts X.Y.Z and X.Y.Z-<prerelease> (dot/hyphen separated identifiers, matching the
 * tag shape the GitHub workflow compares against package.json).
 */
export const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/
export const VERSION_USAGE = 'X.Y.Z or X.Y.Z-<prerelease>  e.g. 0.4.0 / 0.4.0-beta.16'
