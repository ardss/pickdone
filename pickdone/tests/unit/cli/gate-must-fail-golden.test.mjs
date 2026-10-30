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
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const CLI = path.join(import.meta.dirname, '../../../cli')
// Fixture anchor: inside the checkout, NOT os.tmpdir(). The esm-graph gate's caseMatches()
// verifies every path segment against real directory entries, and Node's realpathSync does
// NOT expand Windows 8.3 short names (it only resolves symlinks) — CI's TEMP is
// C:\Users\RUNNER~1\..., so fixtures there fail the case check. Checkout paths are long and
// clean on every platform (GitHub runners: D:\a\pickdone\pickdone\...). .tmp-* is gitignored.
const FIX_ROOT = path.join(import.meta.dirname, '../../../.tmp-gate-golden')
const madeDirs = []

// Git never leaks between the real checkout and a fixture (2026-10-11 incident): git runs
// pre-commit HOOKS with GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE pointing at the REAL repo.
// A fixture `git init` under that inherited env re-initializes the REAL gitdir regardless of
// cwd, and its `git add -A && git commit -qm init` then lands a tree-wiping "init" commit on
// the real branch — this shipped two of them today. Scrub EVERY git pointer for all child
// processes (fixture commits AND spawned gates) so fixtures are always their own repo.
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

function runGate (script, root, args = [], extraEnv = {}) {
  const env = { ...GIT_SAFE_ENV, GATE_ROOT: root, ...extraEnv }
  delete env.CSS_FREEZE_OFF // freeze-gate self-test needs the gate live
  const r = spawnSync(process.execPath, [path.join(CLI, script), ...args], { timeout: 180000, env, encoding: 'utf8' })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

afterEach(() => {
  for (const d of madeDirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* next run cleans via .tmp-* */ }
  }
})

test('GOLDEN harness hygiene: the fixture env carries NO git pointers (hook GIT_DIR leak pin)', () => {
  // Pin for the 2026-10-11 double "init" tree-wipe: under a pre-commit hook the
  // inherited env points GIT_* at the REAL repo; one leaked key turned a fixture
  // `git init` into a re-init of the real gitdir. If this ever goes red, a new
  // GIT_* leak slipped back into the child-process env.
  const poisoned = { ...process.env, GIT_DIR: 'D:/definitely/not/a/repo/.git', GIT_WORK_TREE: 'D:/definitely/not/a/repo', GIT_INDEX_FILE: 'D:/definitely/not/a/repo/index' }
  const keys = Object.keys(poisoned).filter(k => /^GIT_/i.test(k))
  assert.ok(keys.length >= 3, 'sanity: the poisoned env actually carries GIT_* keys')
  const scrubbed = (() => {
    const e = { ...poisoned }
    for (const k of Object.keys(e)) { if (/^GIT_/i.test(k)) delete e[k] }
    return e
  })()
  assert.deepEqual(Object.keys(scrubbed).filter(k => /^GIT_/i.test(k)), [], 'scrubbed env must carry zero GIT_* keys')
  // PATH lookup is case-insensitive on Windows: process.env spreads preserve the original key
  // casing (`Path` under a native shell, `PATH` under CI/posix-style parents), and a plain-object
  // spread loses the case-insensitive getter. Resolve the key instead of hardcoding either casing.
  const pathVal = e => e[Object.keys(e).find(k => k.toLowerCase() === 'path')]
  assert.equal(pathVal(scrubbed), pathVal(poisoned), 'scrubbing only removes git pointers, not the rest of the env')
})

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
    execSync('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init', { cwd: root, env: GIT_SAFE_ENV, stdio: 'ignore' })
    return root
  }
  const bad = mk('cf-bad')
  fs.appendFileSync(path.join(bad, 'pickdone/assets/css/theme-dark.css'), '.b { color: red; }\n')
  execSync('git add -A', { cwd: bad, env: GIT_SAFE_ENV, stdio: 'ignore' }) // gate compares the STAGED version first — growth must be staged to be seen
  const rb = runGate('check-css-freeze.mjs', bad)
  assert.equal(rb.code, 1, 'must fail on frozen-file growth: ' + rb.out)

  const good = mk('cf-good')
  fs.writeFileSync(path.join(good, 'pickdone/assets/css/theme-dark.css'), '.a { color: red; }\n.c { color: red; }\n')
  fs.rmSync(path.join(good, 'pickdone/assets/css/theme-dark.css')) // migration path: delete from global, file stays in HEAD → green (decrease)
  fs.writeFileSync(path.join(good, 'pickdone/assets/css/theme-dark.css'), '.a { color: red; }\n')
  const rg = runGate('check-css-freeze.mjs', good)
  assert.equal(rg.code, 0, 'equal/shrunk frozen file must pass: ' + rg.out)
})

test('GOLDEN boot-order --staged: pickdone/-prefixed staged paths resolve (toplevel-prefix pin); empty scan list fail-closes', () => {
  // 2026-10-26 pin: git emits REPO-ROOT-relative paths (pickdone/src/main/...) while --staged
  // matched /^src[\/]/ against them raw — the staged tier scanned ZERO files and exited green
  // for its whole life (same shape as the 2026-10-10 check-file-size bug). Fixtures mirror the
  // real nested layout: repo toplevel with a pickdone/ dir, gate pointed at pickdone.
  const mk = (name) => {
    const { root, write } = mkTree(name)
    write('pickdone/src/main/ok.js', 'let init = () => {}\ninit()\n')
    execSync('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init', { cwd: root, env: GIT_SAFE_ENV, stdio: 'ignore' })
    return root
  }
  const good = mk('bo-staged-good')
  fs.writeFileSync(path.join(good, 'pickdone/src/main/ok2.js'), 'let i2 = () => {}\ni2()\n')
  execSync('git add pickdone/src/main/ok2.js', { cwd: good, env: GIT_SAFE_ENV, stdio: 'ignore' })
  const rg = runGate('check-boot-order.cjs', path.join(good, 'pickdone'), ['--staged'])
  assert.equal(rg.code, 0, 'staged pickdone/src/main file must be scanned and pass: ' + rg.out)
  assert.match(rg.out, /1 个文件/, 'must scan exactly 1 staged file (0 = the zero-scan fake-green): ' + rg.out)

  // Fail-closed: src/main js staged at toplevel but NONE of it resolves under pickdone —
  // the scan list would be empty while real staged work exists; refuse to fake-green.
  const bad = mk('bo-staged-fc')
  fs.mkdirSync(path.join(bad, 'other/src/main'), { recursive: true })
  fs.writeFileSync(path.join(bad, 'other/src/main/outside.js'), 'x = 1\n')
  execSync('git add other/src/main/outside.js', { cwd: bad, env: GIT_SAFE_ENV, stdio: 'ignore' })
  const rb = runGate('check-boot-order.cjs', path.join(bad, 'pickdone'), ['--staged'])
  assert.equal(rb.code, 1, 'staged src/main js resolving to an empty scan list must fail closed: ' + rb.out)
})

test('GOLDEN i18n incremental: a committed-file deletion is green (diff-filter=d pin); dirty hardcoded CN stays red', () => {
  // 2026-10-26 pin: `git diff --name-only HEAD` DOES list deleted paths (the old comment claimed
  // otherwise); deletions hit statSync and tripped the scan-surface guard — a false red on any
  // file deletion. With --diff-filter=d a deletion-only worktree must pass; detection stays red.
  const { root, write } = mkTree('i18n-del')
  const vue = cn => `<template><div/></template>\n<script>export default { mounted () { this.$message(${cn}) } }</script>\n`
  write('pickdone/renderer/js/deleteme.vue', vue('this.$t("common.ok")'))
  write('pickdone/renderer/js/kept.vue', vue('this.$t("common.ok")'))
  execSync('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init', { cwd: root, env: GIT_SAFE_ENV, stdio: 'ignore' })
  fs.rmSync(path.join(root, 'pickdone/renderer/js/deleteme.vue')) // uncommitted deletion
  const rg = runGate('check-i18n.js', path.join(root, 'pickdone'))
  assert.equal(rg.code, 0, 'deletion-only worktree must be green (was false-red via statSync): ' + rg.out)

  fs.writeFileSync(path.join(root, 'pickdone/renderer/js/kept.vue'), vue('"硬编码中文bad"'))
  const rb = runGate('check-i18n.js', path.join(root, 'pickdone'))
  assert.equal(rb.code, 1, 'dirty hardcoded CN must stay red after the deletion fix: ' + rb.out)
})

test('W17 GOLDEN i18n incremental: a dirty NON-ASCII filename enters the scan (quotePath pin)', () => {
  // W17 quotePath hole: git quotes non-ASCII paths as octal escapes by default; the SCAN_EXT
  // regex (no trailing quote match) silently dropped renderer/js/界面.vue from BOTH the diff
  // list and the dirtyJs self-check (same broken filter) → scan collapsed to 0 files, green.
  const { root, write } = mkTree('i18n-nonascii')
  const vue = cn => `<template><div/></template>\n<script>export default { mounted () { this.$message(${cn}) } }</script>\n`
  write('pickdone/renderer/js/ok.vue', vue('this.$t("common.ok")'))
  execSync('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init', { cwd: root, env: GIT_SAFE_ENV, stdio: 'ignore' })
  // Dirty a tracked file with a non-ASCII name (tracked → git diff HEAD lists it)
  fs.writeFileSync(path.join(root, 'pickdone/renderer/js/界面文件.vue'), vue('"硬编码中文bad"'))
  const rb = runGate('check-i18n.js', path.join(root, 'pickdone'))
  assert.equal(rb.code, 1, 'dirty non-ASCII-named file must be scanned and red (silent drop = quotePath hole): ' + rb.out)
  assert.match(rb.out, /界面文件\.vue/, 'the non-ASCII file itself must appear in the hit list')

  // Clean counterpart: same name, translated copy → green with the file actually scanned
  fs.writeFileSync(path.join(root, 'pickdone/renderer/js/界面文件.vue'), vue('this.$t("common.ok")'))
  const rg = runGate('check-i18n.js', path.join(root, 'pickdone'))
  assert.equal(rg.code, 0, 'clean non-ASCII-named file must pass: ' + rg.out)
  assert.match(rg.out, /扫了 1 个文件/, 'the non-ASCII file must have entered the scan surface (0 = collapse): ' + rg.out)
})

test('W17 GOLDEN boot-order --staged: a staged NON-ASCII filename is scanned (quotePath pin)', () => {
  const mk = (name, rel, body) => {
    const { root, write } = mkTree(name)
    write(rel, body)
    execSync('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init', { cwd: root, env: GIT_SAFE_ENV, stdio: 'ignore' })
    return root
  }
  const good = mk('bo-nonascii', 'pickdone/src/main/ok.js', 'let init = () => {}\ninit()\n')
  fs.writeFileSync(path.join(good, 'pickdone/src/main/启动.js'), 'let qd = () => {}\nqd()\n')
  execSync('git add pickdone/src/main/启动.js', { cwd: good, env: GIT_SAFE_ENV, stdio: 'ignore' })
  const rg = runGate('check-boot-order.cjs', path.join(good, 'pickdone'), ['--staged'])
  assert.equal(rg.code, 0, 'staged non-ASCII-named src/main file must be scanned and pass: ' + rg.out)
  assert.match(rg.out, /1 个文件/, 'must scan exactly 1 staged file (0 = the quotePath silent drop): ' + rg.out)
})

test('W17 GOLDEN file-size --staged: a staged NON-ASCII filename is scanned (quotePath pin)', () => {
  const { root, write } = mkTree('fs-nonascii')
  write('pickdone/renderer/js/ok.js', 'let i = () => {}\n'.repeat(10))
  execSync('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init', { cwd: root, env: GIT_SAFE_ENV, stdio: 'ignore' })
  fs.writeFileSync(path.join(root, 'pickdone/renderer/js/界面.js'), 'let q = () => {}\nq()\n')
  execSync('git add pickdone/renderer/js/界面.js', { cwd: root, env: GIT_SAFE_ENV, stdio: 'ignore' })
  const rg = runGate('check-file-size.cjs', path.join(root, 'pickdone'), ['--staged'])
  assert.equal(rg.code, 0, 'staged non-ASCII-named file must be scanned and pass: ' + rg.out)
  assert.match(rg.out, /扫描 1 个文件/, 'must scan exactly 1 staged file (0 = the quotePath silent drop): ' + rg.out)
})

test('W17 GOLDEN esm-graph: legal re-export forms are green (export * as + export { x as default })', () => {
  // W17 false-red fix: hasDefault used to recognize only ExportDefaultDeclaration, so
  // `export { x as default }` was flagged white-screen-class; `export * from` targets had an
  // unknown-but-checkable surface and named imports through them false-red.
  const good = mkTree('esm-reexport')
  good.write('renderer/js/main.js', "import Def from './reexport.js'\nimport { helper } from './star.js'\nDef()\nhelper()\n")
  good.write('renderer/js/impl.js', 'const helper = () => {}\nexport { helper as default }\n')
  good.write('renderer/js/reexport.js', "export { default } from './impl.js'\n")
  good.write('renderer/js/star-impl.js', 'export const helper = () => {}\n')
  good.write('renderer/js/star.js', "export * from './star-impl.js'\n")
  const rg = runGate('check-esm-graph.cjs', good.root)
  assert.equal(rg.code, 0, 'legal re-export forms must pass (was white-screen-class false-red): ' + rg.out)

  // Detection intact: a genuinely missing named export (no star) still reds.
  const bad = mkTree('esm-reexport-bad')
  bad.write('renderer/js/main.js', "import { nope } from './dep.js'\nnope()\n")
  bad.write('renderer/js/dep.js', 'export const real = 1\n')
  const rb = runGate('check-esm-graph.cjs', bad.root)
  assert.equal(rb.code, 1, 'genuinely missing named export must stay red: ' + rb.out)
})

// —— W19 (2026-10-30) additions: detection branches fixed this round ——

test('W19 GOLDEN i18n --all: a MULTI-LINE user-visible call with Chinese on a continuation line is red', () => {
  // W19 hole: `ElMessage.error(\n '中文'\n)` put the Chinese on a line that never matched
  // VISIBLE_RE, so both lines individually escaped and the hardcoded copy was invisible forever.
  const bad = mkTree('i18n-ml-bad')
  bad.write('shared/.gitkeep', '') // --all walks shared/ and now src/; missing dir = red for the WRONG reason
  bad.write('renderer/js/bad.vue', '<template><div/></template>\n<script>import { ElMessage } from \'element-plus\'\nexport default { methods: { fail () { ElMessage.error(\n  \'多行调用里的硬编码中文\'\n) } } }</script>\n')
  const rb = runGate('check-i18n.js', bad.root, ['--all'])
  assert.equal(rb.code, 1, 'multi-line hardcoded CN call must be red: ' + rb.out)
  assert.match(rb.out, /多行调用里的硬编码中文/, 'the continuation-line copy itself must appear in the hit')

  const good = mkTree('i18n-ml-good')
  good.write('shared/.gitkeep', '')
  good.write('renderer/js/good.vue', '<template><div/></template>\n<script>import { ElMessage } from \'element-plus\'\nexport default { methods: { ok () { ElMessage.error(\n  this.$t(\'common.fail\')\n) } } }</script>\n')
  const rg = runGate('check-i18n.js', good.root, ['--all'])
  assert.equal(rg.code, 0, 'multi-line translated call must pass: ' + rg.out)
})

test('W19 GOLDEN tokens: a component <style> violation in the GATE_ROOT fixture tree is red', () => {
  // W19 hole: cssSources() always used the real checkout root, so a component-level violation
  // injected into the FIXTURE tree never entered the scan — the component half of the token gate
  // was structurally untestable (always green under GATE_ROOT regardless of fixture content).
  const bad = mkTree('tok-comp-bad')
  bad.write('assets/css/base.css', '')
  bad.write('assets/css/theme-dark.css', '')
  bad.write('renderer/js/Comp.vue', '<template><div/></template>\n<style>\n.bad-card { background: #fff; }\n</style>\n')
  const rb = runGate('check-tokens.js', bad.root)
  assert.equal(rb.code, 1, 'component <style> R1 violation in the fixture tree must be red: ' + rb.out)
  assert.match(rb.out, /Comp\.vue/, 'the component file itself must be named in the hit')

  const good = mkTree('tok-comp-good')
  good.write('assets/css/base.css', '')
  good.write('assets/css/theme-dark.css', '')
  good.write('renderer/js/Comp.vue', '<template><div/></template>\n<style>\n.ok-card { background: var(--panel, #fff); }\n</style>\n')
  const rg = runGate('check-tokens.js', good.root)
  assert.equal(rg.code, 0, 'token-using component style must pass: ' + rg.out)
})

test('W20 GOLDEN lint-staged: a staged NON-ASCII source file reaches the eslint runner (quotePath pin)', () => {
  // W20 hole: `git diff --cached` ran WITHOUT -c core.quotePath=false, so non-ASCII paths came
  // back as quoted octal escapes; startsWith('pickdone/') and the scope regex matched nothing
  // and the gate fell into the fail-closed tripwire for every CJK-named staged source file.
  // Fixtures mirror the real nested layout (repo toplevel + pickdone/, GATE_ROOT=pickdone).
  // The eslint runner is a fixture shim that records its invocation into a marker file, so the
  // assertions pin BOTH legs: detection (the shim actually linted the non-ASCII file) and
  // enforcement (a lint error in it must red the gate).
  const mk = (name, body, shimExit) => {
    const { root, write } = mkTree(name)
    write('pickdone/renderer/js/ok.js', 'let ok = () => {}\n')
    write('pickdone/node_modules/eslint/bin/eslint.js',
      "require('fs').appendFileSync(__dirname + '/../../lint-marker.txt', process.argv.slice(2).join(' ') + String.fromCharCode(10))\nprocess.exit(" + shimExit + ")\n")
    execSync('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init', { cwd: root, env: GIT_SAFE_ENV, stdio: 'ignore' })
    fs.writeFileSync(path.join(root, 'pickdone/renderer/js/启动.js'), body)
    execSync('git add pickdone/renderer/js/启动.js', { cwd: root, env: GIT_SAFE_ENV, stdio: 'ignore' })
    return root
  }
  const pd = path.join('pickdone') // GATE_ROOT anchor

  const good = mk('ls-nonascii-good', 'let qd = () => {}\nqd()\n', 0)
  const rg = runGate('lint-staged.mjs', path.join(good, pd))
  assert.equal(rg.code, 0, 'staged non-ASCII in-scope source must be linted and pass: ' + rg.out)
  const markerGood = fs.readFileSync(path.join(good, 'pickdone/node_modules/lint-marker.txt'), 'utf8')
  assert.match(markerGood, /启动\.js/, 'the non-ASCII staged file must have reached the eslint runner (quotePath silent drop = 0 selected): ' + markerGood)

  const bad = mk('ls-nonascii-bad', 'let qd = () => {}\nqd()\n', 1)
  const rb = runGate('lint-staged.mjs', path.join(bad, pd))
  assert.equal(rb.code, 1, 'a lint error in the staged non-ASCII file must red the gate: ' + rb.out)
})
