/* W28 (2026-11-01) — anchor tests for the 8-item gate-maintenance lane.
 *
 * Covers the fixes that are unit-testable without a full hook run:
 *   #1 check-commit-identity.js  — personal-email regex must match subdomain forms
 *      (user@vip.qq.com / user@mail.163.com used to escape the bare-TLD-only pattern).
 *   #3 cli/env-clean.js          — TEST_TMP_FAMILY manifest stays in sync with the real
 *      mkdtemp prefix families (the old todo-test-/pd-it- pair matched none of them).
 *   #4 cli/check-esm-graph.cjs   — a RELATIVE dynamic import whose path contains
 *      "node_modules" must NOT escape the existence check (old substring whitelist).
 *   #7 cli/check-licenses.js     — a corrupt package.json must turn the gate RED with the
 *      package named (it used to be silently dropped from the audit face).
 * Run: node --test tests/unit/cli/w28-gate-fixes.test.mjs
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require_ = createRequire(import.meta.url)
const CLI = path.join(import.meta.dirname, '../../../cli')
const ROOT = path.join(import.meta.dirname, '../../..')
const madeDirs = []

const GIT_SAFE_ENV = (() => {
  const e = { ...process.env }
  for (const k of Object.keys(e)) { if (/^GIT_/i.test(k)) delete e[k] }
  return e
})()

function mkFixture (tag) {
  const root = fs.mkdtempSync(path.join(ROOT, '.tmp-w28-' + tag + '-'))
  madeDirs.push(root)
  return root
}

afterEach(() => {
  for (const d of madeDirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* next run cleans via .tmp-* */ } }
})

// ---- #1 personal-email subdomain coverage ----
const { PERSONAL } = require_(path.join(CLI, 'check-commit-identity.js'))
const RED_EMAILS = ['user@vip.qq.com', 'user@mail.163.com', 'dev@smtp.gmail.com', 'a@b.qq.com', 'x@foxmail.com', 'u@126.net']
const GREEN_EMAILS = ['92158419+ardss@users.noreply.github.com', 'dev@corp.example.com', 'a@mycompany.cn', 'user@notqq.com']
for (const e of RED_EMAILS) test(`W28 #1: ${e} is personal (subdomain forms must not escape)`, () => assert.ok(PERSONAL.test(e)))
for (const e of GREEN_EMAILS) test(`W28 #1: ${e} is not personal`, () => assert.ok(!PERSONAL.test(e)))

// ---- #3 env-clean prefix family sync ----
const { TEST_TMP_FAMILY } = require_(path.join(CLI, 'env-clean.js'))
const FAMILIES = ['todo-cli-smoke-x', 'todo-shared-y', 'todo-smoke-z', 'pd-upd-pid1-a', 'pd-it-b', 'todo-test-c',
  'journey-relay-d', 'pickdone-e2e-x', 'jrelay-a-pid2', 'lan-sync-pid3', 'd10-cfg-z', 'r12-snap-w',
  'relay-boot-pid4', 'todo-cov-pid5']
for (const n of FAMILIES) {
  test(`W28 #3: env-clean recognizes ${n}`, () => assert.ok(TEST_TMP_FAMILY.test(n), `${n} must be cleanable residue`))
}
test('W28 #3: env-clean does not eat unrelated tmp entries', () => {
  // att-*/b5-* are extraction-discovered families — the tmp-dir.mjs sweeper's face, not this
  // synced manifest (env-clean stays exactly on tests/lib/tmp-dir.mjs FAMILY_FALLBACK)
  assert.ok(!TEST_TMP_FAMILY.test('att-micro-x'))
  assert.ok(!TEST_TMP_FAMILY.test('b5-att-y'))
  assert.ok(!TEST_TMP_FAMILY.test('webpack-cache'))
  assert.ok(!TEST_TMP_FAMILY.test('electron-packager-x'))
})

// ---- #4 esm-graph: relative dynamic import containing "node_modules" must stay checked ----
test('W28 #4: relative dynamic import with node_modules in path is RED (existence checked)', () => {
  const root = mkFixture('esm')
  fs.mkdirSync(path.join(root, 'renderer/js'), { recursive: true })
  fs.writeFileSync(path.join(root, 'renderer/js', 'main.js'),
    "import('./node_modules-shim/missing.js').then(m => m.run())\n")
  const r = spawnSync(process.execPath, [path.join(CLI, 'check-esm-graph.cjs')], {
    cwd: root, encoding: 'utf8', env: { ...GIT_SAFE_ENV, GATE_ROOT: root }, timeout: 120000 })
  assert.equal(r.status, 1, 'relative dynamic spec containing "node_modules" must not escape: ' + (r.stdout + r.stderr))
  assert.match(r.stdout + r.stderr, /node_modules-shim\/missing\.js/)
})
test('W28 #4: bare dynamic import stays allowed (escape hatch intact)', () => {
  const root = mkFixture('esm-bare')
  fs.mkdirSync(path.join(root, 'renderer/js'), { recursive: true })
  fs.writeFileSync(path.join(root, 'renderer/js', 'main.js'),
    "import('dayjs').then(m => m())\nimport { createApp } from 'vue'\ncreateApp({})\n")
  const r = spawnSync(process.execPath, [path.join(CLI, 'check-esm-graph.cjs')], {
    cwd: root, encoding: 'utf8', env: { ...GIT_SAFE_ENV, GATE_ROOT: root }, timeout: 120000 })
  assert.equal(r.status, 0, 'bare dynamic import must stay allowed: ' + (r.stdout + r.stderr))
})

// ---- #7 licenses: corrupt package.json = red, named ----
test('W28 #7: corrupt package.json turns license audit RED with the package named', () => {
  const root = mkFixture('lic')
  fs.mkdirSync(path.join(root, 'node_modules/corrupt-pkg'), { recursive: true })
  fs.writeFileSync(path.join(root, 'node_modules/corrupt-pkg', 'package.json'), '{ not json !!')
  const r = spawnSync(process.execPath, [path.join(CLI, 'check-licenses.js')], {
    cwd: root, encoding: 'utf8', env: { ...GIT_SAFE_ENV, GATE_ROOT: root }, timeout: 60000 })
  assert.equal(r.status, 1, 'corrupt manifest must be red, not silently skipped: ' + (r.stdout + r.stderr))
  assert.match(r.stdout + r.stderr, /corrupt-pkg/)
})
test('W28 #7: clean fixture tree stays green (no-manifest tooling dirs only named, not red)', () => {
  const root = mkFixture('lic-green')
  fs.mkdirSync(path.join(root, 'node_modules/mit-pkg'), { recursive: true })
  fs.writeFileSync(path.join(root, 'node_modules/mit-pkg', 'package.json'), JSON.stringify({ name: 'mit-pkg', version: '1.0.0', license: 'MIT' }))
  fs.mkdirSync(path.join(root, 'node_modules/.bin'), { recursive: true })
  const r = spawnSync(process.execPath, [path.join(CLI, 'check-licenses.js')], {
    cwd: root, encoding: 'utf8', env: { ...GIT_SAFE_ENV, GATE_ROOT: root }, timeout: 60000 })
  assert.equal(r.status, 0, 'missing-manifest tooling dirs must not red: ' + (r.stdout + r.stderr))
})
