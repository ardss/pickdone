/* W29 (2026-11-01) — anchor tests for the 7-item gate-maintenance lane.
 *
 * Covers:
 *   #1 cli/check-file-size.cjs — exempt dirs use SEGMENT-boundary matching: a root file like
 *      `tests-utils.js` / `scripts-v2/` must no longer escape the whole gate via the old bare
 *      `rel.startsWith('tests')` prefix match.
 *   #2/#3 cli/env-clean.js — TEST_TMP_FAMILY gains the real in-use prefixes (cov-ratchet-test- /
 *      ratchet-test- / vp-linux-sha-) and the bare `d\d{1,3}-` / `r\d+-` alternations are narrowed
 *      to enumerated real prefixes (os.tmpdir() is a shared surface: `d1-tools` must never be rm'd).
 *      tests/lib/tmp-dir.mjs FAMILY_FALLBACK is the hand-synced twin (CJS/ESM boundary).
 *   #4 cli/env-clean.js — EPERM from process.kill(pid, 0) means ALIVE (Windows); only ESRCH
 *      proves the owning suite is dead. collectTargets() must never list an EPERM dir.
 *   #5 cli/check-i18n.js — T_HELPER's `\bt\(` whitelisted a whole CN line on ANY bare `t(`;
 *      arrow-param calls like `forEach(t => t(中文))` laundered hardcoded CN. Tightened to the
 *      string-literal i18n call shape.
 *   #6 cli/check-tokens.js — whitelist exemptions are SAME-LINE anchored (the 8-line look-back
 *      let one fragment silence a whole drifting window).
 *   #7 .githooks/pre-commit — `--retry-once` removed (retired policy; run-all retries per FILE).
 * Run: node --test tests/unit/cli/w29-maintenance-fixes.test.mjs
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
  const root = fs.mkdtempSync(path.join(ROOT, '.tmp-w29-' + tag + '-'))
  madeDirs.push(root)
  return root
}

afterEach(() => {
  for (const d of madeDirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* next run cleans via .tmp-* */ } }
})

// ---- #1 file-size: exempt-dir segment boundary ----
function bigFile (dir, rel) {
  const p = path.join(dir, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  // 1201 lines > the 1200-line fallback error cap (a bare-prefix-exempted file never reached it)
  fs.writeFileSync(p, 'const filler = 1\n'.repeat(1201))
}
test('W29 #1: tests-utils.js (bare "tests" prefix) is SCANNED — over-cap must be RED', () => {
  const root = mkFixture('fsize-tests-utils')
  bigFile(root, 'tests-utils.js')
  const r = spawnSync(process.execPath, [path.join(CLI, 'check-file-size.cjs')], {
    cwd: root, encoding: 'utf8',
    env: { ...GIT_SAFE_ENV, GATE_ROOT: root, GATE_BASELINE: path.join(root, 'no-baseline.json') },
    timeout: 120000 })
  assert.equal(r.status, 1, 'tests-utils.js must not escape via the bare tests/ prefix: ' + (r.stdout + r.stderr))
  assert.match(r.stdout + r.stderr, /tests-utils\.js/)
})
test('W29 #1: scripts-v2/ (bare "scripts" prefix) is SCANNED — over-cap must be RED', () => {
  const root = mkFixture('fsize-scripts-v2')
  bigFile(root, 'scripts-v2/big.js')
  const r = spawnSync(process.execPath, [path.join(CLI, 'check-file-size.cjs')], {
    cwd: root, encoding: 'utf8',
    env: { ...GIT_SAFE_ENV, GATE_ROOT: root, GATE_BASELINE: path.join(root, 'no-baseline.json') },
    timeout: 120000 })
  assert.equal(r.status, 1, 'scripts-v2/big.js must not escape via the bare scripts/ prefix: ' + (r.stdout + r.stderr))
})
test('W29 #1: tests/ and scripts/ dirs THEMSELVES stay exempt (over-cap must be GREEN)', () => {
  const root = mkFixture('fsize-exempt-intact')
  bigFile(root, 'tests/big.js')
  bigFile(root, 'scripts/big.js')
  bigFile(root, 'browser-dev/big.js')
  const r = spawnSync(process.execPath, [path.join(CLI, 'check-file-size.cjs')], {
    cwd: root, encoding: 'utf8',
    env: { ...GIT_SAFE_ENV, GATE_ROOT: root, GATE_BASELINE: path.join(root, 'no-baseline.json') },
    timeout: 120000 })
  assert.equal(r.status, 0, 'the real exempt dirs must keep their exemption: ' + (r.stdout + r.stderr))
})

// ---- #2/#3 env-clean prefix family (manifest + narrowing) ----
const { TEST_TMP_FAMILY, collectTargets } = require_(path.join(CLI, 'env-clean.js'))
const POSITIVE = [
  'todo-cli-smoke-x', 'pd-upd-pid1-a', 'jrelay-boot-pid2', 'lan-sync-loopback-x', 'journey-x', 'relay-x',
  // w29 #2: the three real in-use prefixes the manifest had drifted past
  'cov-ratchet-test-Ab12cd', 'ratchet-test-Xy34zw', 'vp-linux-sha-Qq77aa',
  // w29 #3: enumerated real d*/r* prefixes (grep-verified at mkdtemp call sites)
  'd3-a', 'd4-quotaZz9', 'd6-sec-x', 'd9-b15-y', 'd10-cfg-z', 'd12-bridge-x', 'd13-c3-x',
  'd14-c7-x', 'd15-x', 'd17-att-x', 'd18-bkp-x', 'd19-rec-x', 'd20-plan-x', 'd21-rec-x',
  'd22-att-x', 'd25-x', 'd26-proc-x', 'r1-fa-x', 'r4-filescan-x', 'r4c-att-x', 'r6-8-a', 'r17-att-x'
]
for (const n of POSITIVE) {
  test(`W29 #2/3: env-clean recognizes ${n}`, () => assert.ok(TEST_TMP_FAMILY.test(n), `${n} must be cleanable residue`))
}
test('W29 #3: env-clean does NOT eat unrelated %TEMP% entries (narrowed bare prefixes)', () => {
  // the shared-surface hazard cases from the finding: user dirs that the old bare
  // `d\d{1,3}-` / `r\d+-` families used to rmSync recursively
  for (const n of ['d1-tools', 'd1-tools-x', 'r42-notes', 'r5-my-notes', 'd2-photos', 'd16-vendor-x',
    'd23-cache-x', 'r2-misc-x', 'r12-snap-x', 'webpack-cache', 'att-micro-x', 'b5-att-y']) {
    assert.ok(!TEST_TMP_FAMILY.test(n), `${n} must NOT match the cleanable family`)
  }
})
test('W29 #2: tmp-dir.mjs FAMILY_FALLBACK stays in sync with env-clean TEST_TMP_FAMILY', () => {
  // CJS/ESM boundary forbids sharing the regex object directly — assert behavioral equality
  // over the union of both manifests' positives and negatives instead.
  const { execFileSync } = require_('node:child_process')
  const modUrl = 'file:///' + path.join(ROOT, 'tests/lib/tmp-dir.mjs').split(path.sep).join('/')
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { FAMILY_FALLBACK } from '${modUrl}'
    const names = ${JSON.stringify(POSITIVE.concat(['d1-tools', 'r42-notes', 'r12-snap-x', 'd16-vendor-x', 'webpack-cache']))}
    for (const n of names) console.log(n + '|' + FAMILY_FALLBACK.test(n))
  `], { encoding: 'utf8', timeout: 60000 })
  for (const line of out.trim().split('\n')) {
    const [n, m] = line.split('|')
    assert.equal(m === 'true', TEST_TMP_FAMILY.test(n), `tmp-dir/env-clean divergence at ${n}`)
  }
})

// ---- #4 env-clean: EPERM = alive ----
test('W29 #4: a dir whose pid owner answers EPERM is NEVER collected (alive on Windows)', () => {
  // pid 4: Windows "System" / Linux kernel thread — kill(pid, 0) throws EPERM for non-admin.
  // Guard: if this platform lets us signal it, the fixture premise is void → skip.
  try { process.kill(4, 0); return } catch (e) { if (!e || e.code === 'ESRCH') return }
  const fakeTmp = mkFixture('tmp-eperm')
  const dead = mkFixture('tmp-esrch')
  fs.mkdirSync(path.join(fakeTmp, 'pd-it-pid4-alive-x'))
  fs.utimesSync(path.join(fakeTmp, 'pd-it-pid4-alive-x'), new Date(Date.now() - 13 * 3600e3), new Date(Date.now() - 13 * 3600e3))
  const os = require_('node:os')
  const orig = os.tmpdir
  os.tmpdir = () => fakeTmp
  try {
    // EPERM pid → treated as ALIVE → absent from targets even though 13h stale
    assert.ok(!collectTargets({ appRoot: dead }).some(t => t.p.includes('pid4-alive')),
      'EPERM must count as alive — collecting the dir would rm a running suite')
    // ESRCH pid → provably dead → collected (the deletion path still works)
    fs.mkdirSync(path.join(fakeTmp, 'pd-it-pid99999999-dead-x'))
    fs.utimesSync(path.join(fakeTmp, 'pd-it-pid99999999-dead-x'), new Date(Date.now() - 13 * 3600e3), new Date(Date.now() - 13 * 3600e3))
    assert.ok(collectTargets({ appRoot: dead }).some(t => t.p.includes('pid99999999-dead')),
      'ESRCH must still count as dead — orphan sweep must keep working')
  } finally { os.tmpdir = orig }
})

// ---- #5 check-i18n: T_HELPER no longer launders via bare t( ----
function i18nRun (root, body) {
  fs.mkdirSync(path.join(root, 'renderer/js'), { recursive: true })
  fs.mkdirSync(path.join(root, 'shared'), { recursive: true }) // --all walks both; must exist
  fs.writeFileSync(path.join(root, 'renderer/js/fix.js'), body + '\n')
  return spawnSync(process.execPath, [path.join(CLI, 'check-i18n.js'), '--all'], {
    cwd: root, encoding: 'utf8', env: { ...GIT_SAFE_ENV, GATE_ROOT: root }, timeout: 120000 })
}
test('W29 #5: arrow-param t(中文) can no longer launder a CN line (was: whole-line escape)', () => {
  const root = mkFixture('i18n-escape')
  const r = i18nRun(root, "list.forEach(t => t(中文参数))\nElMessage.error('真实泄漏中文')")
  assert.equal(r.status, 1, 'bare t( without a string literal must not whitelist the line: ' + (r.stdout + r.stderr))
  assert.match(r.stdout + r.stderr, /真实泄漏中文/)
})
test('W29 #5: a line whose t() call takes a STRING literal stays whitelisted (no false red)', () => {
  const root = mkFixture('i18n-legit')
  const r = i18nRun(root, "ElMessage.error(t('键名.保存'))")
  assert.equal(r.status, 0, 'legit string-literal i18n calls must stay green: ' + (r.stdout + r.stderr))
})

// ---- #6 check-tokens: whitelist same-line anchor ----
function tokenRun (root, baseCss) {
  fs.mkdirSync(path.join(root, 'assets/css'), { recursive: true })
  fs.writeFileSync(path.join(root, 'assets/css/base.css'), baseCss)
  fs.writeFileSync(path.join(root, 'assets/css/theme-dark.css'), '')
  return spawnSync(process.execPath, [path.join(CLI, 'check-tokens.js')], {
    cwd: root, encoding: 'utf8', env: { ...GIT_SAFE_ENV, GATE_ROOT: root }, timeout: 120000 })
}
test('W29 #6: whitelist fragment 9 lines above the violation no longer exempts it (drift hole)', () => {
  const root = mkFixture('tokens-drift')
  const pad = Array.from({ length: 9 }, (_, i) => `.pad-${i} { color: #222; }`).join('\n')
  const r = tokenRun(root, '/* 纯白定稿 */\n' + pad + '\n.card { background: #fff; }\n')
  assert.equal(r.status, 1, 'a violation 9 lines below the whitelist fragment must be RED: ' + (r.stdout + r.stderr))
  assert.match(r.stdout + r.stderr, /background: #fff/)
})
test('W29 #6: same-line whitelist fragment keeps exempting (no false red on existing usage)', () => {
  const root = mkFixture('tokens-inline')
  const r = tokenRun(root, '.knob { border-radius: 50%; background: #fff; } /* 纯白定稿 */\n')
  assert.equal(r.status, 0, 'same-line exemption must survive: ' + (r.stdout + r.stderr))
})

// ---- #7 pre-commit: --retry-once removed (retired policy; run-all retries per FILE) ----
test('W29 #7: pre-commit unit-test stage no longer passes --retry-once', () => {
  const src = fs.readFileSync(path.join(ROOT, '.githooks/pre-commit'), 'utf8')
  const invocations = src.split('\n').filter(l => l.includes('check-test-summary.cjs'))
  assert.ok(invocations.length >= 1, 'the core-layer invocation itself must stay')
  for (const l of invocations) assert.ok(!/--retry-once\b/.test(l), 'invocation still passes the retired --retry-once: ' + l.trim())
})
