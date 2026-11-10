'use strict'

/**
 * Release identity audit — pure consistency core (S7 #224).
 *
 * Five release-identity surfaces must agree on ONE version string:
 *   1. package.json `version` (source of truth)
 *   2. NSIS installer/uninstaller registry entry (DisplayName / DisplayVersion)
 *   3. packaged exe FileVersion (PickDone.exe VersionInfo)
 *   4. UA / build-info self-report (app.getVersion() reported over the wire,
 *      e.g. capture-door build-info or a UA string like `pickdone/0.4.0-beta.24`)
 *   5. latest.yml updater feed (`version`, `path`, per-file `url` names)
 *
 * History: fix/ops-displayname shipped a build where the Windows Apps list kept
 * showing the OLD version after an in-place update — the uninstall registry entry
 * lagged the package version. This module exists so that class of drift is a
 * scripted, testable red, not a human eyeball check.
 *
 * Everything here is a pure function of plain JS inputs (no fs, no registry, no
 * process) so unit tests can feed deliberately inconsistent fixtures. The CLI
 * wrapper (release-identity-audit.cjs) collects real inputs and calls these.
 */

const SETUP_ARTIFACT = (v) => `PickDone-Setup-${v}.exe`
const PORTABLE_ARTIFACT = (v) => `PickDone-Portable-${v}.exe`

function check (ok, surface, detail) {
  return { surface, ok, detail }
}

/** Normalize a version-ish string: trim, strip a leading 'v', strip display prefixes. */
function normVersion (s) {
  if (s == null) return null
  let t = String(s).trim()
  t = t.replace(/^v(?=[0-9])/i, '')
  // Registry DisplayName style "PickDone 0.4.0-beta.25" -> keep the trailing token
  const m = t.match(/([0-9]+\.[0-9]+\.[0-9]+[-+._0-9A-Za-z]*)$/)
  return m ? m[1] : t
}

/**
 * Core check. `inputs`:
 *   packageVersion  : string (required)
 *   latestYml       : { version, path, files: [{url, size, sha512}] } | null
 *   exeVersions     : [{ source, fileVersion, productVersion }]  (one per exe checked)
 *   registryEntries : [{ source, key, displayName, displayVersion, installLocation }] (PickDone-related)
 *   uaReports       : [{ source, version }]  (self-reported versions; UA or build-info)
 *   registriesRequired : boolean — a machine with no PickDone install entry at all is
 *                     only an error when the audit expects one (installed-check mode).
 * Returns { ok, checks: [...], expectedVersion }.
 */
function auditIdentity (inputs) {
  const expected = normVersion(inputs.packageVersion)
  const checks = []
  if (!expected) {
    checks.push(check(false, 'package.json', 'package version missing/unparseable'))
    return { ok: false, checks, expectedVersion: null }
  }
  checks.push(check(true, 'package.json', expected))

  for (const exe of inputs.exeVersions || []) {
    const fv = normVersion(exe.fileVersion)
    const pv = normVersion(exe.productVersion)
    if (fv !== expected) {
      checks.push(check(false, `exe:${exe.source}`, `FileVersion ${exe.fileVersion} != ${expected}`))
    } else if (pv != null && pv !== expected && !isWin32ProductVersionOf(pv, expected)) {
      checks.push(check(false, `exe:${exe.source}`, `ProductVersion ${exe.productVersion} != ${expected}`))
    } else {
      checks.push(check(true, `exe:${exe.source}`, exe.fileVersion))
    }
  }

  for (const ua of inputs.uaReports || []) {
    const v = normVersion(ua.version)
    if (v !== expected) {
      checks.push(check(false, `ua:${ua.source}`, `self-report ${ua.version} != ${expected}`))
    } else {
      checks.push(check(true, `ua:${ua.source}`, ua.version))
    }
  }

  for (const reg of inputs.registryEntries || []) {
    const dv = normVersion(reg.displayVersion)
    const dn = reg.displayName || ''
    const dnHasVersion = dn.includes(expected)
    if (dv != null && dv !== expected && !dnHasVersion) {
      checks.push(check(false, `registry:${reg.key}`, `DisplayVersion ${reg.displayVersion} / DisplayName "${dn}" != ${expected}`))
    } else if (dv == null && !dnHasVersion) {
      checks.push(check(false, `registry:${reg.key}`, `no DisplayVersion and DisplayName "${dn}" carries no version`))
    } else {
      checks.push(check(true, `registry:${reg.key}`, dv != null ? String(reg.displayVersion) : dn))
    }
    // InstallLocation drift: an entry pointing at a path that is not the audited
    // install root is how "two versions coexist, old one launched" happens.
    if (reg.installLocation && inputs.expectedInstallLocation) {
      const a = String(reg.installLocation).replace(/[\\/]+$/, '').toLowerCase()
      const b = String(inputs.expectedInstallLocation).replace(/[\\/]+$/, '').toLowerCase()
      if (a && b && a !== b) {
        checks.push(check(false, `registry:${reg.key}:installLocation`, `${reg.installLocation} != ${inputs.expectedInstallLocation}`))
      }
    }
  }
  if ((inputs.registryEntries || []).length === 0 && inputs.registriesRequired) {
    checks.push(check(false, 'registry', 'no PickDone uninstall entry found (expected one)'))
  }

  const yml = inputs.latestYml
  if (yml == null) {
    if (inputs.latestYmlRequired) {
      checks.push(check(false, 'latest.yml', 'missing (required for a release candidate)'))
    } else {
      checks.push(check(true, 'latest.yml', 'absent (not a fatal finding outside a release build)'))
    }
  } else {
    const yv = normVersion(yml.version)
    if (yv !== expected) {
      checks.push(check(false, 'latest.yml:version', `${yml.version} != ${expected}`))
    } else {
      checks.push(check(true, 'latest.yml:version', yml.version))
    }
    if (yml.path && yml.path !== SETUP_ARTIFACT(expected)) {
      checks.push(check(false, 'latest.yml:path', `${yml.path} != ${SETUP_ARTIFACT(expected)}`))
    } else {
      checks.push(check(true, 'latest.yml:path', yml.path || '(none)'))
    }
    for (const f of yml.files || []) {
      const isSetup = /^PickDone-Setup-/.test(f.url || '')
      const isPortable = /^PickDone-Portable-/.test(f.url || '')
      if (isSetup && f.url !== SETUP_ARTIFACT(expected)) {
        checks.push(check(false, 'latest.yml:files', `${f.url} != ${SETUP_ARTIFACT(expected)}`))
      } else if (isPortable && f.url !== PORTABLE_ARTIFACT(expected)) {
        checks.push(check(false, 'latest.yml:files', `${f.url} != ${PORTABLE_ARTIFACT(expected)}`))
      } else if (!isSetup && !isPortable) {
        checks.push(check(false, 'latest.yml:files', `unrecognized artifact ${f.url}`))
      } else {
        checks.push(check(true, 'latest.yml:files', f.url))
      }
    }
  }

  return { ok: checks.every((c) => c.ok), checks, expectedVersion: expected }
}

/**
 * NSIS ProductVersion is often coerced to a 4-field Win32 form
 * (0.4.0-beta.27 -> 0.4.0.0). Accept that as a non-fatal representation of the
 * same build ONLY when the first three numeric fields match the expected version.
 */
function isWin32ProductVersionOf (productVersion, expected) {
  const p = String(productVersion).split('.').map((n) => parseInt(n, 10))
  const e = String(expected).split('.').map((n) => parseInt(n, 10))
  if (p.length !== 4 || e.length < 3) return false
  return p[0] === e[0] && p[1] === e[1] && p[2] === e[2]
}

/**
 * Parse `version:` / `path:` / files[] out of a latest.yml WITHOUT a YAML dep.
 * Only the flat subset electron-builder emits (validated against real dist feeds).
 */
function parseLatestYml (text) {
  const out = { version: null, path: null, files: [] }
  let inFiles = false
  for (const rawLine of String(text).split(/\r?\n/)) {
    if (/^files:\s*$/.test(rawLine)) { inFiles = true; continue }
    if (inFiles) {
      const m = rawLine.match(/^\s*-\s+url:\s*(\S+)\s*$/)
      if (m) { out.files.push({ url: m[1] }); continue }
      if (/^\s*-/.test(rawLine)) { out.files.push({ url: rawLine.replace(/^\s*-\s*/, '').trim() }); continue }
      if (/^\S/.test(rawLine)) inFiles = false
    }
    let m
    if ((m = rawLine.match(/^version:\s*'?([^'\s]+)'?\s*$/))) out.version = m[1]
    else if ((m = rawLine.match(/^path:\s*'?([^'\s]+)'?\s*$/))) out.path = m[1]
  }
  return out
}

/** Extract the version token from a UA string like `pickdone/0.4.0-beta.24 Electron/39.8.10`. */
function versionFromUa (ua) {
  const m = String(ua || '').match(/pickdone\/([^\s]+)/i)
  return m ? m[1] : null
}

module.exports = { auditIdentity, parseLatestYml, versionFromUa, normVersion, isWin32ProductVersionOf, SETUP_ARTIFACT, PORTABLE_ARTIFACT }
