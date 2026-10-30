/* W21 (2026-10-30) — unit pins for gate fixes outside the golden runGate family:
 *   - check-dualwrite: widened call-head regex (optional chaining / wrapped member expression /
 *     bare aliased setItem) detects without false-arresting comment prose.
 *   - check-css-freeze: --off is the ONLY exemption channel; the CSS_FREEZE_OFF env form is
 *     rejected fail-closed (fail-open env-leak hole, check-test-summary.cjs precedent).
 *   - check-commit-identity: %x1f field separator survives a `|` in user.name; last-10-commit
 *     sweep names a dirty non-HEAD commit. The gate derives ROOT from __dirname, so the script
 *     is COPIED into each fixture repo (its ROOT then resolves to the fixture).
 * Run: node --test tests/unit/cli/w21-gate-fixes.test.mjs
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const CLI = path.join(import.meta.dirname, '../../../cli')
const FIX_ROOT = path.join(import.meta.dirname, '../../../.tmp-w21-gate-fixes')
const madeDirs = []

// scrub every GIT_* pointer (see gate-must-fail-golden.test.mjs for the tree-wipe incident)
const GIT_SAFE_ENV = (() => {
  const e = { ...process.env }
  for (const k of Object.keys(e)) { if (/^GIT_/i.test(k)) delete e[k] }
  return e
})()

function mkTree (name) {
  const root = fs.mkdtempSync(FIX_ROOT + '-' + name + '-')
  madeDirs.push(root)
  const write = (rel, content) => {
    const p = path.join(root, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
    return p
  }
  return { root, write }
}

function spawnGate (script, cwd, args = [], env = {}) {
  const r = spawnSync(process.execPath, [path.join(CLI, script), ...args], { cwd, env: { ...GIT_SAFE_ENV, ...env }, encoding: 'utf8' })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

afterEach(() => {
  for (const d of madeDirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* next run cleans via .tmp-* */ }
  }
})

// ---- check-dualwrite: widened call-head detection ----

function dualwriteFixture () {
  const { root, write } = mkTree('dw')
  write('tests/dualwrite-ledger.json', JSON.stringify({
    'renderer/js/registered.js::registeredKey': { authority: 'local-only', note: 'runtime pref, no sync obligation' }
  }))
  return { root, write }
}

test('W21 dualwrite: optional-chaining write point is detected (was invisible to the old head regex)', () => {
  const { root, write } = dualwriteFixture()
  write('renderer/js/new.js', "export function f () { localStorage?.setItem('unregOptChain', '1') }\n")
  const rb = spawnGate('check-dualwrite.cjs', root, [], { GATE_ROOT: root })
  assert.equal(rb.code, 1, 'localStorage?.setItem must be detected as an unregistered write point: ' + rb.out)
  assert.match(rb.out, /unregOptChain/, 'the optional-chained key itself must be named: ' + rb.out)
})

test('W21 dualwrite: a wrapped member expression (localStorage newline . setItem) is detected', () => {
  const { root, write } = dualwriteFixture()
  write('renderer/js/new.js', "export function f () {\n  localStorage\n    .setItem('unregWrapped', '1')\n}\n")
  const rb = spawnGate('check-dualwrite.cjs', root, [], { GATE_ROOT: root })
  assert.equal(rb.code, 1, 'wrapped localStorage.setItem must be detected: ' + rb.out)
  assert.match(rb.out, /unregWrapped/, 'the wrapped call key must be named: ' + rb.out)
})

test('W21 dualwrite: bare aliased setItem is caught by the fallback scan; comment prose is not false-arrested', () => {
  const { root, write } = dualwriteFixture()
  // prose mentions "raw setItem (TQ-x)" inside comments — must NOT register; the bare call must
  write('renderer/js/new.js', "/** recovery writes go through raw setItem (TQ-6: loud) — see docs */\n// old `removeItem(KEY)` form was removed\nexport function f () { setItem('unregBare', '1') }\n")
  const rb = spawnGate('check-dualwrite.cjs', root, [], { GATE_ROOT: root })
  assert.equal(rb.code, 1, 'a bare aliased setItem call must be detected: ' + rb.out)
  assert.match(rb.out, /unregBare/, 'the bare call key must be named: ' + rb.out)
  assert.doesNotMatch(rb.out, /TQ-6/, 'comment prose must not become a write point: ' + rb.out)

  // registered counterpart: same shapes, ledger entry present → green
  const g = dualwriteFixture()
  g.write('renderer/js/registered.js', "export function f () { localStorage?.setItem('registeredKey', '1') }\n")
  const rg = spawnGate('check-dualwrite.cjs', g.root, [], { GATE_ROOT: g.root })
  assert.equal(rg.code, 0, 'a registered optional-chained write point must pass: ' + rg.out)
})

// ---- check-css-freeze: --off is the only exemption channel ----

test('W21 css-freeze: --off explicitly skips; CSS_FREEZE_OFF env is rejected fail-closed', () => {
  const { root } = mkTree('cf')
  const rg = spawnGate('check-css-freeze.mjs', root, ['--off'])
  assert.equal(rg.code, 0, '--off must skip the gate cleanly: ' + rg.out)
  assert.match(rg.out, /--off/, 'the skip must be loud about its channel: ' + rg.out)

  const rb = spawnGate('check-css-freeze.mjs', root, [], { CSS_FREEZE_OFF: '1' })
  assert.equal(rb.code, 1, 'the env form must no longer bypass the gate (fail-open hole removed): ' + rb.out)
  assert.match(rb.out, /CSS_FREEZE_OFF/, 'the rejection must name the leaked env var: ' + rb.out)
})

// ---- check-commit-identity: %x1f fields + last-10 sweep (script copied so ROOT = fixture) ----

function commitIdentityFixture (name) {
  const { root } = mkTree(name)
  // the gate derives ROOT as __dirname/.. — mirror the real layout (cli/ one level under root)
  fs.mkdirSync(path.join(root, 'cli'))
  fs.copyFileSync(path.join(CLI, 'check-commit-identity.js'), path.join(root, 'cli', 'check-commit-identity.js'))
  execSync('git init -q && git add -A', { cwd: root, env: GIT_SAFE_ENV, stdio: 'ignore' })
  return root
}

const commit = (root, env, msg) => {
  execSync('git commit --allow-empty -qm ' + JSON.stringify(msg), { cwd: root, env: { ...GIT_SAFE_ENV, ...env }, stdio: 'pipe' })
}

// spawn the COPIED gate (ROOT resolves to the fixture), never the checkout original
const runCopiedIdentity = (root) => {
  const r = spawnSync(process.execPath, [path.join(root, 'cli', 'check-commit-identity.js')], { cwd: root, env: GIT_SAFE_ENV, encoding: 'utf8' })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

test('W21 commit-identity: a personal email in a NON-HEAD commit (within last 10) is red', () => {
  const root = commitIdentityFixture('ci-deep')
  commit(root, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 'leak@qq.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }, 'dirty middle commit')
  commit(root, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }, 'clean HEAD on top')
  const r = runCopiedIdentity(root)
  assert.equal(r.code, 1, 'a dirty commit buried under a clean HEAD must still be red: ' + r.out)
  assert.match(r.out, /leak@qq\.com/, 'the offending email must be named: ' + r.out)
})

test('W21 commit-identity: a `|` in user.name must not corrupt field parsing (old separator pin)', () => {
  const root = commitIdentityFixture('ci-pipe')
  commit(root, { GIT_AUTHOR_NAME: 'ardss|extra|segments', GIT_AUTHOR_EMAIL: '92158419+ardss@users.noreply.github.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }, 'pipe in author name')
  const r = runCopiedIdentity(root)
  assert.equal(r.code, 0, 'noreply emails with a pipe-bearing user.name must stay green: ' + r.out)
})
