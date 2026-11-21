/**
 * Build info resolver (W31 P1) — main-process build constants for the diagnostic
 * payload ('app:build-info' handler) and the About fingerprint.
 * Resolution order for each field:
 *  - version: APP_VERSION env (injected at startup in src/main/index.js from app.getVersion())
 *  - gitSha:  APP_GIT_SHA env (build-time injection) → live `git rev-parse --short HEAD`
 *             → 'unknown' (packaged builds without git/env carry no SHA and say so honestly)
 *  - channel: APP_CHANNEL env (build-time injection) → derived from the version prerelease
 *             suffix via shared/build-fingerprint.mjs (same derivation the updater uses)
 * No literal SHA is ever hardcoded in this file.
 */
const { execSync } = require('child_process')
const { channelFromVersion, buildFingerprint } = require('../../shared/build-fingerprint.mjs')

function gitShaFromGit () {
  try {
    const out = execSync('git rev-parse --short HEAD', { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
    const sha = String(out || '').trim()
    return sha || 'unknown'
  } catch { return 'unknown' }
}

/** Resolve (and cache) the build info. Pure given the env — tests override via env vars. */
function getBuildInfo () {
  const version = process.env.APP_VERSION || '0.0.0'
  const gitSha = process.env.APP_GIT_SHA || gitShaFromGit()
  const channel = process.env.APP_CHANNEL || channelFromVersion(version)
  return { version, gitSha, channel, fingerprint: buildFingerprint({ version, gitSha, channel }) }
}

module.exports = { getBuildInfo }
