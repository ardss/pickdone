'use strict'

/**
 * S7 #224 — release identity audit core tests.
 * RED-FIRST doctrine: every surface drift that historically shipped
 * (fix/ops-displayname Apps-list-stale-version; latest.yml lagging package.json;
 * UA self-reporting an old build) is encoded here as a deliberately
 * inconsistent fixture that the audit MUST flag as a red.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { auditIdentity, parseLatestYml, versionFromUa, normVersion } = createRequire(import.meta.url)('../../scripts/release-identity-audit-lib.cjs')

const GREEN = {
  packageVersion: '0.4.0-beta.29-ui2',
  exeVersions: [{ source: 'win-unpacked/PickDone.exe', fileVersion: '0.4.0-beta.29-ui2', productVersion: '0.4.0.0' }],
  registryEntries: [{ source: 'HKCU', key: 'Uninstall/{guid}', displayName: 'PickDone 0.4.0-beta.29-ui2', displayVersion: '0.4.0-beta.29-ui2', installLocation: 'F:\\PickDone' }],
  expectedInstallLocation: 'F:\\PickDone',
  uaReports: [{ source: 'capture-door:build-info', version: '0.4.0-beta.29-ui2' }],
  latestYml: {
    version: '0.4.0-beta.29-ui2',
    path: 'PickDone-Setup-0.4.0-beta.29-ui2.exe',
    files: [
      { url: 'PickDone-Setup-0.4.0-beta.29-ui2.exe' },
      { url: 'PickDone-Portable-0.4.0-beta.29-ui2.exe' }
    ]
  }
}

function fails (inputs, surfaceNeedle, needle) {
  const res = auditIdentity(inputs)
  const hit = res.checks.find((c) => !c.ok && c.surface.includes(surfaceNeedle) && (!needle || c.detail.includes(needle)))
  assert.ok(hit, `expected a red on surface '${surfaceNeedle}' ${needle || ''}, got: ${JSON.stringify(res.checks)}`)
  assert.equal(res.ok, false)
  return res
}

test('all-consistent fixture is green across all five surfaces', () => {
  const res = auditIdentity(GREEN)
  assert.equal(res.ok, true, JSON.stringify(res.checks))
  assert.equal(res.expectedVersion, '0.4.0-beta.29-ui2')
  assert.equal(res.checks.filter((c) => !c.ok).length, 0)
})

test('RED: registry DisplayVersion lags package version (ops-displayname incident class)', () => {
  fails({ ...GREEN, registryEntries: [{ ...GREEN.registryEntries[0], displayName: 'PickDone 0.4.0-beta.24', displayVersion: '0.4.0-beta.24' }] }, 'registry:')
})

test('RED: registry entry with no version anywhere', () => {
  fails({ ...GREEN, registryEntries: [{ key: 'Uninstall/{guid}', displayName: 'PickDone', displayVersion: null }] }, 'registry:')
})

test('registry DisplayName carrying the correct version compensates a stale-winf32 DisplayVersion', () => {
  // DisplayVersion normalized differently but DisplayName shows right version -> ok
  const res = auditIdentity({ ...GREEN, registryEntries: [{ key: 'k', displayName: 'PickDone 0.4.0-beta.29-ui2', displayVersion: '0.4.0-beta.24' }] })
  assert.equal(res.ok, true, JSON.stringify(res.checks))
})

test('RED: registry InstallLocation points elsewhere (two-roots ambiguity)', () => {
  fails({ ...GREEN, registryEntries: [{ ...GREEN.registryEntries[0], installLocation: 'D:\\pickdone' }] }, 'installLocation')
})

test('RED: exe FileVersion stale', () => {
  fails({ ...GREEN, exeVersions: [{ source: 'installed/PickDone.exe', fileVersion: '0.4.0-beta.27', productVersion: '0.4.0.0' }] }, 'exe:')
})

test('RED: UA self-reports an old build', () => {
  fails({ ...GREEN, uaReports: [{ source: 'ua', version: '0.4.0-beta.24' }] }, 'ua:')
})

test('RED: latest.yml version lags package.json', () => {
  fails({ ...GREEN, latestYml: { ...GREEN.latestYml, version: '0.4.0-beta.27' } }, 'latest.yml:version')
})

test('RED: latest.yml artifact names do not match version', () => {
  fails({ ...GREEN, latestYml: { ...GREEN.latestYml, path: 'PickDone-Setup-0.4.0-beta.27.exe' } }, 'latest.yml:path')
  fails({ ...GREEN, latestYml: { ...GREEN.latestYml, files: [{ url: 'PickDone-Setup-0.4.0-beta.27.exe' }] } }, 'latest.yml:files')
})

test('RED: unrecognized artifact in latest.yml files[]', () => {
  fails({ ...GREEN, latestYml: { ...GREEN.latestYml, files: [{ url: 'SomethingElse-1.0.0.exe' }] } }, 'latest.yml:files')
})

test('missing latest.yml is only red when required (release-candidate mode)', () => {
  assert.equal(auditIdentity({ ...GREEN, latestYml: null }).ok, true)
  const res = auditIdentity({ ...GREEN, latestYml: null, latestYmlRequired: true })
  assert.equal(res.ok, false)
  assert.ok(res.checks.some((c) => !c.ok && c.surface === 'latest.yml'))
})

test('missing registry entry is only red when required (installed mode)', () => {
  assert.equal(auditIdentity({ ...GREEN, registryEntries: [] }).ok, true)
  assert.equal(auditIdentity({ ...GREEN, registryEntries: [], registriesRequired: true }).ok, false)
})

test('normVersion handles v-prefix and display prefixes', () => {
  assert.equal(normVersion(' v1.2.3 '), '1.2.3')
  assert.equal(normVersion('PickDone 0.4.0-beta.25'), '0.4.0-beta.25')
  assert.equal(normVersion('0.4.0-beta.29-ui2'), '0.4.0-beta.29-ui2')
})

test('parseLatestYml reads the electron-builder flat subset (real-feed shape)', () => {
  const yml = parseLatestYml([
    'version: 0.4.0-beta.27',
    'files:',
    '  - url: PickDone-Setup-0.4.0-beta.27.exe',
    '    sha512: abc==',
    '    size: 104768366',
    'path: PickDone-Setup-0.4.0-beta.27.exe',
    "releaseDate: '2026-11-04T12:27:06.936Z'"
  ].join('\n'))
  assert.equal(yml.version, '0.4.0-beta.27')
  assert.equal(yml.path, 'PickDone-Setup-0.4.0-beta.27.exe')
  assert.deepEqual(yml.files, [{ url: 'PickDone-Setup-0.4.0-beta.27.exe' }])
})

test('versionFromUa extracts pickdone/<v> token', () => {
  assert.equal(versionFromUa('pickdone/0.4.0-beta.24 Electron/39.8.10'), '0.4.0-beta.24')
  assert.equal(versionFromUa('Mozilla/5.0'), null)
})
