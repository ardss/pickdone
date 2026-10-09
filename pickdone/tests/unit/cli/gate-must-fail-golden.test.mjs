/* R3 (2026-10-10 nightly) — gate must-fail golden fixtures ("who checks the checks").
 *
 * A gate that can no longer detect what it was built to detect exits green forever and
 * nobody notices (the check-file-size --staged zero-file no-op lived for its whole life
 * exactly this way — fixed 2026-10-10 in #176). These tests pin the DETECTION side of the
 * gate family: each gate is spawned twice against a temp tree via the GATE_ROOT override —
 * once with a deliberately-broken fixture (MUST exit nonzero) and once with an equivalent
 * clean fixture (MUST exit 0, proving the red was detection, not ambient breakage).
 * Run: node --test tests/unit/cli/gate-must-fail-golden.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CLI = path.join(import.meta.dirname, '../../../cli')

function mkTree (name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-golden-' + name + '-'))
  const write = (rel, content) => {
    const p = path.join(root, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
    return p
  }
  return { root, write }
}

function runGate (script, root, args = [], extraEnv = {}) {
  const env = { ...process.env, GATE_ROOT: root, ...extraEnv }
  delete env.CSS_FREEZE_OFF // freeze-gate self-test needs the gate live
  const r = spawnSync(process.execPath, [path.join(CLI, script), ...args], { env, encoding: 'utf8' })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

test('GOLDEN file-size: a file past its per-dir error cap is red; within it is green', () => {
  // NOTE: baseline entries RAISE the cap (grandfather clause), they do not lower it — so the
  // red fixture targets the plain renderer/js error limit (800) instead.
  const bad = mkTree('fs-bad')
  bad.write('renderer/js/big.js', Array.from({ length: 801 }, (_, i) => 'line ' + i).join('\n') + '\n')
  const rb = runGate('check-file-size.cjs', bad.root)
  assert.equal(rb.code, 1, 'must fail on error-cap overrun: ' + rb.out)

  const good = mkTree('fs-good')
  good.write('renderer/js/big.js', 'const ok = 1\n')
  const rg = runGate('check-file-size.cjs', good.root)
  assert.equal(rg.code, 0, 'clean tree must pass: ' + rg.out)
})

test('GOLDEN tokens: hardcoded white panel bg is red; token usage is green (and built-in TOKEN_SELFTEST wakes)', () => {
  const bad = mkTree('tok-bad')
  bad.write('assets/css/base.css', '.panel-x { background: #fff; }\n')
  bad.write('assets/css/theme-dark.css', '') // gate scans both registered files; missing target = red for the WRONG reason
  const rb = runGate('check-tokens.js', bad.root)
  assert.equal(rb.code, 1, 'must fail on hardcoded white bg: ' + rb.out)
  assert.match(rb.out, /R1/, 'failure must name the violated rule')

  const good = mkTree('tok-good')
  good.write('assets/css/base.css', '.panel-x { background: var(--panel, #fff); }\n')
  good.write('assets/css/theme-dark.css', '')
  const rg = runGate('check-tokens.js', good.root)
  assert.equal(rg.code, 0, 'token usage must pass: ' + rg.out)

  // dormant built-in negative self-test (existed since 2026-09, never invoked by anything):
  const rt = runGate('check-tokens.js', good.root, [], { TOKEN_SELFTEST: '1' })
  assert.equal(rt.code, 0, 'TOKEN_SELFTEST must pass: ' + rt.out)
  assert.match(rt.out, /token 门禁自检/, 'TOKEN_SELFTEST marker missing')
})

test('GOLDEN boot-order: top-level use-before-let is red; clean boot graph is green', () => {
  const bad = mkTree('bo-bad')
  bad.write('src/main/bad.js', 'init()\nlet init = () => {}\n')
  const rb = runGate('check-boot-order.cjs', bad.root)
  assert.equal(rb.code, 1, 'must fail on TDZ use-before-let: ' + rb.out)

  const good = mkTree('bo-good')
  good.write('src/main/ok.js', 'let init = () => {}\ninit()\n')
  const rg = runGate('check-boot-order.cjs', good.root)
  assert.equal(rg.code, 0, 'clean boot order must pass: ' + rg.out)
})

test('GOLDEN esm-graph: import of a missing module is red; a resolvable graph is green', () => {
  const bad = mkTree('esm-bad')
  bad.write('renderer/js/main.js', "import './missing.js'\n")
  const rb = runGate('check-esm-graph.cjs', bad.root)
  assert.equal(rb.code, 1, 'must fail on unresolvable import: ' + rb.out)

  const good = mkTree('esm-good')
  good.write('renderer/js/main.js', "import './dep.js'\n")
  good.write('renderer/js/dep.js', 'export const dep = 1\n')
  const rg = runGate('check-esm-graph.cjs', good.root)
  assert.equal(rg.code, 0, 'resolvable graph must pass: ' + rg.out)
})

test('GOLDEN i18n --all: hardcoded Chinese in a user-visible API is red; translated copy is green', () => {
  const bad = mkTree('i18n-bad')
  bad.write('shared/.gitkeep', '') // --all also walks shared/; missing dir crashes the walk (red for the WRONG reason)
  bad.write('renderer/js/bad.vue', '<template><div/></template>\n<script>export default { mounted () { this.$message("操作成功了hardcoded") } }</script>\n')
  const rb = runGate('check-i18n.js', bad.root, ['--all'])
  assert.equal(rb.code, 1, '--all must fail on hardcoded Chinese in $message: ' + rb.out)

  const good = mkTree('i18n-good')
  good.write('shared/.gitkeep', '')
  good.write('renderer/js/good.vue', '<template><div/></template>\n<script>export default { mounted () { this.$message(this.$t("common.ok")) } }</script>\n')
  const rg = runGate('check-i18n.js', good.root, ['--all'])
  assert.equal(rg.code, 0, 'translated copy must pass: ' + rg.out)
})

test('GOLDEN css-freeze: a grown frozen global css is red; a shrunk/equal one is green', () => {
  const mk = (name) => {
    const { root, write } = mkTree(name)
    write('pickdone/assets/css/theme-dark.css', '.a { color: red; }\n')
    execSync('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init', { cwd: root, stdio: 'ignore' })
    return root
  }
  const bad = mk('cf-bad')
  fs.appendFileSync(path.join(bad, 'pickdone/assets/css/theme-dark.css'), '.b { color: red; }\n')
  execSync('git add -A', { cwd: bad, stdio: 'ignore' }) // gate compares the STAGED version first — growth must be staged to be seen
  const rb = runGate('check-css-freeze.mjs', bad)
  assert.equal(rb.code, 1, 'must fail on frozen-file growth: ' + rb.out)

  const good = mk('cf-good')
  fs.writeFileSync(path.join(good, 'pickdone/assets/css/theme-dark.css'), '.a { color: red; }\n.c { color: red; }\n')
  fs.rmSync(path.join(good, 'pickdone/assets/css/theme-dark.css')) // migration path: delete from global, file stays in HEAD → green (decrease)
  fs.writeFileSync(path.join(good, 'pickdone/assets/css/theme-dark.css'), '.a { color: red; }\n')
  const rg = runGate('check-css-freeze.mjs', good)
  assert.equal(rg.code, 0, 'equal/shrunk frozen file must pass: ' + rg.out)
})
