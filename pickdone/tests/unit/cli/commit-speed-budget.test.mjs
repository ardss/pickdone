/**
 * Commit-speed wave (2026-11-20): the two mechanisms that stop a routine commit from paying for
 * the whole 983-file core tier.
 *
 *  1. version-only manifest bumps — `npm run pack`/`npm run dist` bump package.json +
 *     package-lock.json; before this, every such commit hit "unmapped surface → full core tier"
 *     (measured: 90 minutes at concurrency 2 on the network worktree). ONLY the version fields may
 *     differ; any dependency/script/build edit still fails wide.
 *  2. the pool budget — run-all --max-files prints a machine-readable DEFERRED marker and exits 0
 *     instead of running a pool the commit gate cannot afford; check-test-summary turns that marker
 *     into a loud note (never a green "0 tests passed").
 *
 * Run: node --test tests/unit/cli/commit-speed-budget.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { versionOnlyChange } from '../../../cli/check-test-scope.cjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const pkg = version => JSON.stringify({ name: 'pickdone', version, scripts: { test: 'node tests/run-all.mjs' }, dependencies: { vue: '3.5.44' } })
const lock = version => JSON.stringify({ name: 'pickdone', version, lockfileVersion: 3, packages: { '': { name: 'pickdone', version } } })

test('versionOnlyChange: version-only bump is neutral for both manifests', () => {
  assert.equal(versionOnlyChange(pkg('0.4.0-beta.39'), pkg('0.4.0-beta.40')), true)
  assert.equal(versionOnlyChange(lock('0.4.0-beta.39'), lock('0.4.0-beta.40'), true), true)
})

test('versionOnlyChange: identical content is NOT a neutral change (clean tree must fail wide)', () => {
  assert.equal(versionOnlyChange(pkg('0.4.0-beta.39'), pkg('0.4.0-beta.39')), false)
  assert.equal(versionOnlyChange(lock('0.4.0-beta.39'), lock('0.4.0-beta.39'), true), false)
})

test('versionOnlyChange: any dependency / script / integrity edit fails wide', () => {
  const depBump = JSON.parse(pkg('0.4.0-beta.40'))
  depBump.dependencies.vue = '3.5.45'
  assert.equal(versionOnlyChange(JSON.stringify(depBump), pkg('0.4.0-beta.39')), false)

  const scriptEdit = JSON.parse(pkg('0.4.0-beta.40'))
  scriptEdit.scripts.test = 'node tests/run-all.mjs --tier=core'
  assert.equal(versionOnlyChange(JSON.stringify(scriptEdit), pkg('0.4.0-beta.39')), false)

  const resolved = JSON.parse(lock('0.4.0-beta.40'))
  resolved.packages['node_modules/vue'] = { version: '3.5.44', resolved: 'https://example.invalid/vue.tgz' }
  assert.equal(versionOnlyChange(JSON.stringify(resolved), lock('0.4.0-beta.39'), true), false)
})

test('versionOnlyChange: unparseable / missing blobs fail wide', () => {
  assert.equal(versionOnlyChange(null, pkg('1.0.0')), false)
  assert.equal(versionOnlyChange('{not json', pkg('1.0.0')), false)
})

test('run-all --max-files: over-budget pool prints the DEFERRED marker and exits 0', () => {
  const r = spawnSync(process.execPath, ['tests/run-all.mjs', '--tier=core', '--dirs=tests/unit/meta', '--max-files=1'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' }
  })
  assert.equal(r.status, 0, 'deferral must not look like a red: ' + (r.stderr || '').slice(-400))
  assert.match(r.stdout, /^# DEFERRED \d+ files \(max 1\)/m, 'check-test-summary keys off this exact marker')
  assert.match(r.stderr, /npm run check:core/, 'the deferred pool must tell the user how to run it')
})

test('run-all --max-files=0 means "no budget", not "defer everything"', () => {
  const r = spawnSync(process.execPath, ['tests/run-all.mjs', '--tier=core', '--dirs=tests/unit/meta', '--max-files=0'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' }
  })
  assert.doesNotMatch(r.stdout, /# DEFERRED/, '0 must not be read as an empty budget')
})
