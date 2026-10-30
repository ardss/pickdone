/* W19 (2026-10-30) — check-licenses banned-identifier coverage, fixture-tree unit tests.
 *
 * The old BANNED pattern missed npm-standard spellings: `UNLICENSED` (what npm itself writes
 * for private/do-not-publish packages) and `SEE LICENSE IN <file>` (no SPDX id, legally
 * un-auditable). GPL as a substring already covered LGPL-x.y ("LGPL" contains "GPL").
 * Run: node --test tests/unit/cli/w19-licenses.test.mjs
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const CLI = path.join(import.meta.dirname, '../../../cli')
const FIX_ROOT = path.join(import.meta.dirname, '../../../.tmp-w19-licenses')
const madeDirs = []

const GIT_SAFE_ENV = (() => {
  const e = { ...process.env }
  for (const k of Object.keys(e)) { if (/^GIT_/i.test(k)) delete e[k] }
  return e
})()

function runGate (root) {
  const env = { ...GIT_SAFE_ENV, GATE_ROOT: root }
  const r = spawnSync(process.execPath, [path.join(CLI, 'check-licenses.js')], { timeout: 60000, env, encoding: 'utf8' })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

afterEach(() => {
  for (const d of madeDirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* next run cleans via .tmp-* */ }
  }
})

// one fixture tree per license spelling: node_modules/<pkg>/package.json is the whole scan surface
function mkPkg (name, license) {
  const root = fs.mkdtempSync(FIX_ROOT + '-' + name + '-')
  madeDirs.push(root)
  fs.mkdirSync(path.join(root, 'node_modules', name), { recursive: true })
  fs.writeFileSync(path.join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0', license }))
  return { root, license }
}

const RED_CASES = [
  ['UNLICENSED', 'UNLICENSED'], // npm-private marker — the headline miss
  ['see-license-in', 'SEE LICENSE IN ./LICENSE.txt'], // no SPDX id
  ['lgpl-2.1-pkg', 'LGPL-2.1'], // substring-GPL coverage (pre-existing, pinned here)
  ['gpl3-pkg', 'GPL-3.0-only'],
  ['agpl-pkg', 'AGPL-3.0']
]
for (const [dir, license] of RED_CASES) {
  test(`W19 licenses: ${license} is RED`, () => {
    const { root } = mkPkg(dir, license)
    const r = runGate(root)
    assert.equal(r.code, 1, `${license} must be banned: ` + r.out)
    assert.match(r.out, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the offending package must be named: ' + r.out)
  })
}

const GREEN_CASES = [
  ['mit-pkg', 'MIT'],
  ['unlicense-pkg', 'Unlicense'], // public-domain SPDX id — distinct from npm's UNLICENSED marker
  ['dual-mit-or-gpl', '(MIT OR GPL-3.0-or-later)'] // consumer picks the permissive side
]
for (const [dir, license] of GREEN_CASES) {
  test(`W19 licenses: ${license} is GREEN`, () => {
    const { root } = mkPkg(dir, license)
    const r = runGate(root)
    assert.equal(r.code, 0, `${license} must pass: ` + r.out)
  })
}
