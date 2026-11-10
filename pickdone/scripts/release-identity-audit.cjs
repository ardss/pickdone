#!/usr/bin/env node
'use strict'

/**
 * Release identity audit CLI (S7 #224) — scripted cross-surface version
 * consistency check. READ-ONLY: queries package.json, latest.yml, exe version
 * resources, and the Windows uninstall registry; never writes anything.
 *
 * Surfaces (all must agree on ONE version):
 *   1 package.json        2 NSIS uninstall registry (DisplayName/DisplayVersion)
 *   3 exe FileVersion     4 UA / build-info self-report (optional --ua)
 *   5 latest.yml updater feed (optional --dist)
 *
 * Usage:
 *   node scripts/release-identity-audit.cjs [--root <repo>] [--dist <dir>]
 *        [--exe <path>]... [--ua <ua-string>]... [--expect-registry]
 *        [--expect-installer] [--install-location <path>]
 * Exit 0 = all surfaces agree; exit 1 = drift (print each red).
 */

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { auditIdentity, parseLatestYml, versionFromUa } = require('./release-identity-audit-lib.cjs')

function parseArgs (argv) {
  const o = { root: process.cwd(), exes: [], uas: [], dist: null, expectRegistry: false, expectInstaller: false, installLocation: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root') o.root = argv[++i]
    else if (a === '--dist') o.dist = argv[++i]
    else if (a === '--exe') o.exes.push(argv[++i])
    else if (a === '--ua') o.uas.push(argv[++i])
    else if (a === '--install-location') o.installLocation = argv[++i]
    else if (a === '--expect-registry') o.expectRegistry = true
    else if (a === '--expect-installer') { o.expectInstaller = true; if (!o.dist) o.dist = path.join(o.root, 'dist') }
    else { console.error('unknown arg ' + a); process.exit(2) }
  }
  return o
}

/** Read uninstall entries whose DisplayName/InstallLocation mention PickDone (read-only).
 *  NSIS uninstall keys are GUIDs — a reg /k key-name search misses them — so enumerate
 *  every Uninstall child and read DisplayName/DisplayVersion/InstallLocation via PowerShell. */
function queryRegistryEntries () {
  if (process.platform !== 'win32') return []
  const ps = `
$r = @()
foreach ($root in 'HKCU:Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall') {
  Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath
    if (($p.DisplayName -match 'PickDone') -or ($p.InstallLocation -match 'PickDone')) {
      $r += [pscustomobject]@{ hive = ($root -replace ':.*',''); key = $_.PSChildName; displayName = $p.DisplayName; displayVersion = $p.DisplayVersion; installLocation = $p.InstallLocation }
    }
  }
}
$r | ConvertTo-Json -Compress`
  let txt = ''
  try {
    txt = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] }) || ''
  } catch (e) {
    console.error('WARN: registry enumeration failed: ' + e.message.split('\n')[0])
    return []
  }
  if (!txt.trim()) return []
  const arr = txt.trim().startsWith('[') ? JSON.parse(txt) : [JSON.parse(txt)]
  return arr.map((r) => ({ source: r.hive, key: r.key, displayName: r.displayName || null, displayVersion: r.displayVersion || null, installLocation: r.installLocation || null }))
}

/** exe FileVersion via PowerShell VersionInfo (read-only). */
function queryExeVersion (exePath) {
  if (process.platform !== 'win32') return { fileVersion: null, productVersion: null }
  const ps = `(Get-Item -LiteralPath '${exePath.replace(/'/g, "''")}').VersionInfo | Select-Object -Property FileVersion,ProductVersion | ConvertTo-Json -Compress`
  const txt = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] })
  const j = JSON.parse(txt)
  return { fileVersion: j.FileVersion || null, productVersion: j.ProductVersion || null }
}

function main () {
  const o = parseArgs(process.argv.slice(2))
  const pkg = JSON.parse(fs.readFileSync(path.join(o.root, 'package.json'), 'utf8'))
  const exeVersions = []
  for (const exe of o.exes) {
    if (!fs.existsSync(exe)) { console.error('FAIL: exe not found: ' + exe); process.exit(2) }
    exeVersions.push({ source: exe, ...queryExeVersion(exe) })
  }
  let latestYml = null
  if (o.dist) {
    const ymlPath = path.join(o.dist, 'latest.yml')
    if (!fs.existsSync(ymlPath)) {
      if (o.expectInstaller) { console.error('FAIL: latest.yml missing under ' + o.dist); process.exit(1) }
    } else {
      latestYml = parseLatestYml(fs.readFileSync(ymlPath, 'utf8'))
    }
  }
  const uaReports = []
  for (const ua of o.uas) {
    const v = versionFromUa(ua) || ua.trim()
    uaReports.push({ source: 'cli-arg', version: v })
  }
  const registryEntries = queryRegistryEntries().filter((r) => {
    if (/pickdone/i.test(r.displayName || '')) return true
    if (/pickdone/i.test(r.installLocation || '')) return true
    return false
  })
  const res = auditIdentity({
    packageVersion: pkg.version,
    exeVersions,
    registryEntries,
    uaReports,
    latestYml,
    registriesRequired: o.expectRegistry,
    latestYmlRequired: o.expectInstaller,
    expectedInstallLocation: o.installLocation
  })
  console.log(`release-identity audit: expected=${res.expectedVersion}`)
  for (const c of res.checks) console.log(`  [${c.ok ? 'OK ' : 'RED'}] ${c.surface}: ${c.detail}`)
  if (!res.ok) { console.error('FAIL: release identity drift detected'); process.exit(1) }
  console.log('PASS: all release-identity surfaces agree')
}

main()
