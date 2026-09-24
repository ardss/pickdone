/**
 * Release version gate tests (originating from fix wave E / review R5; renamed 2026-09-24 from
 * wave-e-fixes.test.mjs to a domain name — the release-scripts domain, kept at the tests/unit root
 * alongside the other cross-cutting gates):
 *  P1-1 — release version gate accepts prerelease (0.4.0-beta.15) in BOTH release scripts:
 *     shared pure validator (scripts/release-version.mjs) unit-covered, plus a source anchor
 *     asserting release.mjs / release-finalize.mjs actually route their argv gate through it
 *     (the scripts execute top-level side effects, so we do not import them here).
 *  (The wave-e CLI half, deleteCategory cascading saved filters, lives in
 *   tests/unit/cli/deletecategory-filter-cascade.test.mjs.)
 * Run: node --test tests/unit/release-version-gate.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')

// ---------- P1-1: prerelease version acceptance ----------
test('release version gate: isReleaseVersion accepts X.Y.Z and X.Y.Z-prerelease', async () => {
  const { isReleaseVersion, RELEASE_VERSION_RE } = await import('../../scripts/release-version.mjs')
  for (const good of ['0.4.0', '0.4.0-beta.15', '1.2.3-rc.1', '10.20.30-alpha-beta.0']) {
    assert.ok(isReleaseVersion(good), `should accept ${good}`)
    assert.match(good, RELEASE_VERSION_RE)
  }
  for (const bad of ['', '0.4', '0.4.0-', 'v0.4.0', '0.4.0-beta.15+build.7', '0.4.0-beta.15 ', null, undefined, 0.4]) {
    assert.ok(!isReleaseVersion(bad), `should reject ${String(bad)}`)
  }
})

test('release version gate: both release scripts route argv through the shared validator', async () => {
  for (const f of ['scripts/release.mjs', 'scripts/release-finalize.mjs']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
    assert.match(src, /release-version\.mjs/, `${f} imports the shared validator`)
    assert.doesNotMatch(src, /\^\\d\+\\\./, `${f} no longer inlines the strict X.Y.Z-only regex`)
    assert.match(src, /isReleaseVersion\(version\)/, `${f} validates argv with isReleaseVersion`)
  }
})
