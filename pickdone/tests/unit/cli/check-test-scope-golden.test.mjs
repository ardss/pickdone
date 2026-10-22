/**
 * Golden self-tests for the affected-scope gate machinery (2026-10-23 perf wave).
 *
 * The pre-commit unit stage now routes through cli/check-test-scope.cjs (verdict selection)
 * and tests/run-all.mjs --dirs (pool restriction). Both are fail-safe CRITICAL path: a silent
 * wrong verdict means either a skipped suite that pinned the change (undershoot — unforgivable)
 * or a mystery full run. These goldens pin the fail-safe CONTRACT so future edits to the map
 * or the guards cannot silently flip the safe direction:
 *   - every mapped surface → scoped verdict naming its dirs (incl. the 2026-10-23 audit holes:
 *     server/billing, shared/sync-core, server/sync-relay)
 *   - every unmapped/config surface → full verdict (fail wide)
 *   - docs-only staged set → skip verdict
 *   - run-all --dirs with a dir matching zero discovered files → exit 1 (never a silent empty run)
 *   - check-test-summary offline arg-mode: green TAP passes; red TAP fails AND leaves the
 *     full failing TAP at tests/.artifacts/last-failed-unit.tap (the feature, asserted as such)
 *
 * Run: node --test tests/unit/cli/check-test-scope-golden.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { scopeFor } from '../../../cli/check-test-scope.cjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const CLI = filename => path.join(ROOT, 'cli', filename)

test('scope: mapped surfaces resolve to their pinned dirs (audit holes included)', () => {
  const cases = [
    // expected dirs in SORTED order (scopeFor returns sorted, deterministic)
    ['renderer/js/store/todo.js', ['tests/unit/components', 'tests/unit/renderer', 'tests/unit/store']],
    ['src/main/scheduler.js', ['tests/unit/main']],
    ['server/billing/ledger.mjs', ['tests/unit/billing']],
    ['server/billing-service.mjs', ['tests/unit/billing', 'tests/unit/cli', 'tests/unit/lan-sync']],
    ['shared/sync-core/clock/hlc.mjs', ['tests/unit/lan-sync', 'tests/unit/main', 'tests/unit/sync']],
    ['src/main/lan-sync/transport.js', ['tests/unit/lan-sync', 'tests/unit/main']],
    ['cli/check-cache-stamps.js', ['tests/unit/cli']],
    ['tests/unit/store/x.test.mjs', ['tests/unit/store']],
    ['tests/lib/tmp-dir.mjs', ['tests/unit']],
    // traversal segments must normalize BEFORE prefix matching (a dot-segment path must
    // resolve into the real tree, not prefix-match past it)
    ['renderer/js/store/../utils/date.js', ['tests/unit/components', 'tests/unit/renderer', 'tests/unit/utils']]
  ]
  for (const [file, dirs] of cases) {
    const v = scopeFor([file])
    assert.equal(v.verdict, 'scoped', `${file} must be scoped, got ${JSON.stringify(v)}`)
    assert.deepEqual(v.dirs, dirs, `${file} must map to ${dirs}, got ${v.dirs}`)
  }
})

test('scope: unmapped or non-code surfaces fail WIDE (full core tier)', () => {
  for (const file of ['some/unknown/path.js', 'package.json', 'tests/run-all.mjs', 'renderer/js/../../escape.js']) {
    const v = scopeFor([file])
    assert.equal(v.verdict, 'full', `${file} must fail wide, got ${JSON.stringify(v)}`)
  }
})
test('scope: docs-only staged set skips loudly; mixed set never skips', () => {
  const skip = scopeFor(['README.md', 'docs/开发规范.md'])
  assert.equal(skip.verdict, 'skip')
  const mixed = scopeFor(['README.md', 'renderer/js/utils/date.js'])
  assert.equal(mixed.verdict, 'scoped', 'one code file makes the whole run scoped, never skipped')
})

test('run-all: --dirs matching zero discovered files exits 1 (fail-closed, never silent-empty)', () => {
  const r = spawnSync(process.execPath, ['tests/run-all.mjs', '--tier=core', '--dirs=tests/unit/does-not-exist'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60000
  })
  assert.notEqual(r.status, 0, 'a bogus --dirs entry must exit non-zero')
  assert.match((r.stderr || '') + (r.stdout || ''), /matching no discovered test file/, 'the red must NAME the offending dirs')
})

test('summary offline: green TAP passes', () => {
  const tap = path.join(os.tmpdir(), `scope-golden-green-${process.pid}.tap`)
  fs.writeFileSync(tap, '1..2\nok 1 - a\nok 2 - b\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n')
  try {
    const r = spawnSync(process.execPath, [CLI('check-test-summary.cjs'), tap], { cwd: ROOT, encoding: 'utf8', timeout: 60000 })
    assert.equal(r.status, 0, `green TAP must pass, got: ${(r.stderr || '') + (r.stdout || '')}`)
  } finally { try { fs.unlinkSync(tap) } catch { /* tmp */ } }
})

test('summary offline: red TAP fails AND lands the full failing TAP in-tree', () => {
  const repoTap = path.join(ROOT, 'tests', '.artifacts', 'last-failed-unit.tap')
  const before = fs.existsSync(repoTap) ? fs.readFileSync(repoTap, 'utf8') : null
  const tap = path.join(os.tmpdir(), `scope-golden-red-${process.pid}.tap`)
  fs.writeFileSync(tap, '1..2\nok 1 - a\nnot ok 2 - boom\n# pass 1\n# fail 1\n# cancelled 0\n# skipped 0\n')
  try {
    const r = spawnSync(process.execPath, [CLI('check-test-summary.cjs'), tap], { cwd: ROOT, encoding: 'utf8', timeout: 60000 })
    assert.notEqual(r.status, 0, 'red TAP must exit non-zero')
    assert.ok(fs.existsSync(repoTap), 'the in-tree failing-TAP pointer must exist after a red')
    const landed = fs.readFileSync(repoTap, 'utf8')
    assert.match(landed, /not ok 2 - boom/, 'the pointer must carry the failing TAP content')
    assert.match((r.stderr || '') + (r.stdout || ''), /fail = 1/, 'the red must state the count')
  } finally {
    try { fs.unlinkSync(tap) } catch { /* tmp */ }
    // restore whatever pointer a REAL gate failure had written — this test must not erase evidence
    if (before === null) { try { fs.unlinkSync(repoTap) } catch { /* was absent */ } } else { fs.writeFileSync(repoTap, before) }
  }
})
