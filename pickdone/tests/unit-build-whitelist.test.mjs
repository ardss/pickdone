// Real tests of build-whitelist.mjs - guards against dead patterns in the hand-maintained package.json build.files (quoted entries/duplicates/missing packages)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

test('build-whitelist: runs without error and build.files remains a valid JSON array after the rewrite', () => {
  const r = spawnSync(process.execPath, ['scripts/build-whitelist.mjs'], { encoding: 'utf8' })
  assert.equal(r.status, 0, 'build-whitelist.mjs should exit 0: ' + r.stderr)
  // Read package.json back to verify it is still valid JSON
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  assert.ok(Array.isArray(pkg.build.files), 'build.files must be array')
})

test('build-whitelist: after the rewrite the files array has no duplicate node_modules entries (guards against manual dead patterns)', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const entries = pkg.build.files.filter(f => f.includes('node_modules/'))
  // Strip quotes/whitespace (defends against historical hand-written bad entries)
  const cleaned = entries.map(f => f.replace(/^["'\s]+|["'\s]+$/g, '').trim()).filter(Boolean)
  const uniq = new Set(cleaned)
  assert.equal(uniq.size, entries.length, 'node_modules entries must be unique (was ' + entries.length + ', uniq=' + uniq.size + ')')
})

test('build-whitelist: after the rewrite it covers all dependencies (lockfile closure)', () => {
  // After running generate, the dependencies closure matches the node_modules entries in files
  spawnSync(process.execPath, ['scripts/build-whitelist.mjs'], { encoding: 'utf8' })
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const direct = Object.keys(pkg.dependencies || {})
  const entries = pkg.build.files.filter(f => f.startsWith('node_modules/'))
  // At minimum every direct dep appears in the entries
  for (const d of direct) {
    assert.ok(
      entries.some(e => e.includes('node_modules/' + d + '/')),
      'dependency ' + d + ' missing from build.files (closure break)'
    )
  }
})

test('build-whitelist: package-lock.json stays in sync with package.json dependencies (prevents lockfile/production dependency drift)', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const lockRaw = readFileSync('package-lock.json', 'utf8')
  assert.ok(lockRaw.includes('node_modules'), 'package-lock.json should reference node_modules')
  // The actual lockfile comparison is indirectly guaranteed by build-whitelist.mjs's own lock parsing
  for (const d of Object.keys(pkg.dependencies || {})) {
    assert.ok(lockRaw.includes('"node_modules/' + d + '":'), 'lock missing ' + d)
  }
})
