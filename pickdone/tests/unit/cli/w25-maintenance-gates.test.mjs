/* W25 (2026-11-01) — pre-commit staged-blob gates + cache-stamp staged-tier exemption.
 *
 * Fix 1 (high): the whole pre-commit chain gated WORKTREE files, not the staged blobs — with
 * `git add -p` partial staging the committed index blob was never seen by any gate (bad hunk
 * staged + worktree cleaned up = broken content lands green). pre-commit stage 1 now runs
 * node --check on the `git show :0:<path>` blob whenever staged ≠ worktree (zero-overhead
 * original path otherwise), and cli/lint-staged.mjs lints the extracted blob likewise.
 * Fix 2 (mid): cli/check-cache-stamp.js exempted on ANY worktree dirt (git status --porcelain)
 * without looking at the staging bit — css staged while the index.html ?v= bump stayed in the
 * worktree gated green with no bump in the commit (the exact 2026-09-05 incident shape). The
 * exemption now keys on index-vs-HEAD only; worktree-only dirt is neither exemption nor offense.
 *
 * Run: node --test tests/unit/cli/w25-maintenance-gates.test.mjs
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const CLI = path.join(import.meta.dirname, '../../../cli')
const HOOK = path.join(import.meta.dirname, '../../../.githooks/pre-commit')
// Fixture anchor inside the checkout (NOT os.tmpdir()) — same reason as gate-must-fail-golden:
// realpathSync does not expand Windows 8.3 short names. .tmp-* is gitignored.
const FIX_ROOT = path.join(import.meta.dirname, '../../../.tmp-w25-gates')
const madeDirs = []

// Scrub every GIT_* pointer: under the real pre-commit hook the env points GIT_DIR /
// GIT_INDEX_FILE at the REAL repo; a fixture `git init` under that env re-initializes the real
// gitdir (the 2026-10-11 tree-wipe incident). Same hygiene as gate-must-fail-golden.
const GIT_SAFE_ENV = (() => {
  const e = { ...process.env }
  for (const k of Object.keys(e)) { if (/^GIT_/i.test(k)) delete e[k] }
  return e
})()

function mkRepo (name, files) {
  const root = fs.mkdtempSync(FIX_ROOT + '-' + name + '-')
  madeDirs.push(root)
  const pd = path.join(root, 'pickdone')
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  execSync('git init -q && git config user.email t@t && git config user.name t && git config core.autocrlf false && git add -A && git commit -qm init', { cwd: root, env: GIT_SAFE_ENV, stdio: 'ignore' })
  // core.autocrlf=false: with autocrlf=true an LF worktree file reads as perpetually "dirty"
  // to git diff (eol roundtrip), which would force the blob leg everywhere and hide the
  // zero-overhead probe leg; the gate stays CORRECT either way (the blob is the commit), but
  // the fixture must not mask the leg we pin.
  return { root, pd }
}

// Directly build the add -p shape: put an arbitrary blob into the index while the worktree
// keeps a DIFFERENT file (no worktree change involved — exactly the partial-staging state).
function stageBlob (root, rel, content) {
  const hash = execSync('git hash-object -w --stdin', { cwd: root, env: GIT_SAFE_ENV, input: content, encoding: 'utf8' }).trim()
  execSync(`git update-index --cacheinfo 100644,${hash},${rel}`, { cwd: root, env: GIT_SAFE_ENV, stdio: 'ignore' })
  return hash
}

afterEach(() => {
  for (const d of madeDirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* next run cleans via .tmp-* */ }
  }
})

// —— Fix 1 leg A: pre-commit stage 1 checks the STAGED blob, not the worktree file ——

function runHook (root) {
  const r = spawnSync('sh', [HOOK], { cwd: root, env: GIT_SAFE_ENV, encoding: 'utf8', timeout: 180000 })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

test('W25 hook stage-1: a BAD staged blob with a GOOD worktree file is red (add -p hole closed)', () => {
  const { root } = mkRepo('hook-bad-blob', { 'pickdone/cli/ok.js': 'let ok = () => {}\n' })
  // The add -p scenario verbatim: the index carries the broken hunk, the worktree was fixed up.
  stageBlob(root, 'pickdone/cli/ok.js', 'syntax((error\n')
  const r = runHook(root)
  assert.equal(r.code, 1, 'a bad staged blob must red the hook even with a clean worktree: ' + r.out)
  assert.match(r.out, /语法错误/, 'stage 1 must name the syntax failure: ' + r.out)
  assert.match(r.out, /cli\/ok\.js/, 'the offending staged path must be named: ' + r.out)
  assert.ok(!r.out.includes('2/4'), 'stage 1 must trip BEFORE stage 2 (fail stopped the chain): ' + r.out)
})

test('W25 hook stage-1: a GOOD staged blob with a BAD worktree file passes (blob, not worktree, is the contract)', () => {
  const { root } = mkRepo('hook-good-blob', { 'pickdone/cli/ok.js': 'let ok = () => {}\n' })
  // Inverse pin: the index blob is the committed truth — a dirty (syntax-broken) worktree file
  // must NOT block a commit whose staged blob is clean (old code gated the worktree instead).
  stageBlob(root, 'pickdone/cli/ok.js', 'let staged = 1 // STAGEDGOOD\n')
  fs.writeFileSync(path.join(root, 'pickdone/cli/ok.js'), 'syntax((worktreeBroken\n')
  const r = runHook(root)
  assert.ok(!r.out.includes('语法错误'), 'stage 1 must pass on the good staged blob: ' + r.out)
  assert.match(r.out, /✓ 通过（检查 1 个文件）/, 'stage 1 must check exactly 1 file and pass: ' + r.out)
  assert.match(r.out, /2\/4/, 'the chain must have advanced past stage 1: ' + r.out)
})

test('W25 hook stage-1: identical index/worktree content keeps the zero-overhead path (no regression)', () => {
  const { root } = mkRepo('hook-same', { 'pickdone/cli/ok.js': 'let ok = () => {}\n' })
  // A real staged change (index == worktree, both differ from HEAD) — the ordinary commit shape.
  fs.writeFileSync(path.join(root, 'pickdone/cli/ok.js'), 'let ok = () => { /* v2 */ }\n')
  execSync('git add pickdone/cli/ok.js', { cwd: root, env: GIT_SAFE_ENV, stdio: 'ignore' })
  const r = runHook(root)
  assert.ok(!r.out.includes('语法错误'), 'plain staged commit must pass stage 1: ' + r.out)
  assert.match(r.out, /✓ 通过（检查 1 个文件）/, 'stage 1 must check exactly 1 file: ' + r.out)
  assert.match(r.out, /2\/4/, 'the chain must have advanced past stage 1: ' + r.out)
})

// —— Fix 1 leg B: lint-staged lints the staged blob (eslint shim records what it linted) ——

function mkLintRepo (name, indexContent, worktreeContent, shim) {
  const { root, pd } = mkRepo(name, {
    'pickdone/renderer/js/ok.js': 'let ok = () => {}\n',
    'pickdone/node_modules/eslint/bin/eslint.js': shim
  })
  // HEAD keeps ok.js clean; diverge index (staged truth) from worktree afterwards.
  fs.writeFileSync(path.join(pd, 'renderer/js/ok.js'), worktreeContent)
  stageBlob(root, 'pickdone/renderer/js/ok.js', indexContent)
  return { root, pd }
}

function runLintStaged (pd) {
  const r = spawnSync(process.execPath, [path.join(CLI, 'lint-staged.mjs')], {
    cwd: pd, env: { ...GIT_SAFE_ENV, GATE_ROOT: pd }, encoding: 'utf8', timeout: 180000
  })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

const RECORD_SHIM = "const fs = require('fs')\n" +
  "const files = process.argv.slice(2).filter(f => { try { return fs.statSync(f).isFile() } catch { return false } })\n" +
  "const marker = require('path').resolve(__dirname, '../../lint-marker.txt')\n" +
  "for (const f of files) fs.appendFileSync(marker, JSON.stringify([f, fs.readFileSync(f, 'utf8')]) + String.fromCharCode(10))\n" +
  "process.exit(files.some(f => fs.readFileSync(f, 'utf8').includes('BADMARK')) ? 1 : 0)\n"

test('W25 lint-staged: the STAGED blob is linted when it differs from the worktree (marker proves it)', () => {
  const { root, pd } = mkLintRepo('lint-staged-blob', 'let staged = 1 // STAGEDGOOD\n', 'let ok = () => { /* worktree */ }\n', RECORD_SHIM)
  const r = runLintStaged(pd)
  assert.equal(r.code, 0, 'a lint-clean staged blob must pass even with a divergent worktree: ' + r.out)
  const marker = fs.readFileSync(path.join(pd, 'node_modules/lint-marker.txt'), 'utf8')
  assert.match(marker, /STAGEDGOOD/, 'the staged blob content must have reached the eslint runner: ' + marker)
  assert.ok(!marker.includes('worktree'), 'the worktree file must NOT be linted when staged ≠ worktree: ' + marker)
  const entry = JSON.parse(marker.trim().split('\n').find(l => l.includes('STAGEDGOOD')))
  assert.match(entry[0], /w25|tmp-w25|lint-staged-blob/, 'staged blob must be linted via the preserved-extension temp chain: ' + entry[0])
  assert.match(entry[0], /\.js$/, 'temp path must keep the extension: ' + entry[0])
  const leftovers = fs.readdirSync(pd).filter(n => n.startsWith('.tmp-staged-lint-'))
  assert.deepEqual(leftovers, [], 'temp lint dir must be cleaned up after the run')
  void root
})

test('W25 lint-staged: a lint-error STAGED blob with a clean worktree file reds the gate (add -p hole closed)', () => {
  const { pd } = mkLintRepo('lint-staged-bad-blob', 'noSemiBad = 5 // BADMARK eslint-disable-line\n', 'let ok = () => {}\n', RECORD_SHIM)
  const r = runLintStaged(pd)
  assert.equal(r.code, 1, 'a lint error in the staged blob must red the gate even with a clean worktree: ' + r.out)
  const marker = fs.readFileSync(path.join(pd, 'node_modules/lint-marker.txt'), 'utf8')
  assert.match(marker, /BADMARK/, 'the bad staged blob (not the clean worktree copy) must have been linted: ' + marker)
})

test('W25 lint-staged: identical index/worktree content keeps linting the real path (no regression)', () => {
  const { root, pd } = mkLintRepo('lint-staged-same', 'let ok = () => { /* v2 */ }\n', 'let ok = () => { /* v2 */ }\n', RECORD_SHIM)
  void root
  const r = runLintStaged(pd)
  assert.equal(r.code, 0, 'plain staged commit must lint green: ' + r.out)
  const marker = fs.readFileSync(path.join(pd, 'node_modules/lint-marker.txt'), 'utf8')
  const entry = JSON.parse(marker.trim().split('\n')[0])
  assert.equal(entry[0], path.join(pd, 'renderer/js/ok.js'), 'identical content keeps the original worktree path (zero-overhead leg): ' + entry[0])
})

// —— Fix 2: cache-stamp exemption keys on the STAGED tier (index vs HEAD), not worktree dirt ——

// check-cache-stamp.js anchors ROOT at its own parent dir (no GATE_ROOT support), so the
// fixture gets a COPY of the gate at <fixture>/cli/ — same script bytes, fixture ROOT.
function mkStampRepo (name, cssBody, htmlBody) {
  const { root } = mkRepo(name, {
    'assets/css/a.css': cssBody,
    'renderer/index.html': htmlBody
  })
  fs.mkdirSync(path.join(root, 'cli'), { recursive: true })
  fs.copyFileSync(path.join(CLI, 'check-cache-stamp.js'), path.join(root, 'cli/check-cache-stamp.js'))
  return root
}

function runStamp (root) {
  const r = spawnSync(process.execPath, [path.join(root, 'cli/check-cache-stamp.js')], { env: GIT_SAFE_ENV, encoding: 'utf8', timeout: 60000 })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

const HTML = '<link rel="stylesheet" href="assets/css/a.css?v=1">\n'

test('W25 cache-stamp: css staged + ?v= bump left UNSTAGED in the worktree must still RED (the 2026-09-05 hole)', () => {
  const root = mkStampRepo('stamp-unstaged-bump', '.a { color: red; }\n', HTML)
  fs.writeFileSync(path.join(root, 'assets/css/a.css'), '.a { color: blue; }\n')
  execSync('git add assets/css/a.css', { cwd: root, env: GIT_SAFE_ENV, stdio: 'ignore' })
  // The old gate exempted on this: the bump exists — but only in the WORKTREE, never in the commit.
  fs.writeFileSync(path.join(root, 'renderer/index.html'), HTML.replace('v=1', 'v=2'))
  const r = runStamp(root)
  assert.equal(r.code, 1, 'worktree-only bump must NOT exempt a staged css change: ' + r.out)
  assert.match(r.out, /缓存戳纪律/, 'must name the cache-stamp violation: ' + r.out)
})

test('W25 cache-stamp: css staged + bump staged together stays GREEN (normal same-commit path unchanged)', () => {
  const root = mkStampRepo('stamp-both-staged', '.a { color: red; }\n', HTML)
  fs.writeFileSync(path.join(root, 'assets/css/a.css'), '.a { color: blue; }\n')
  fs.writeFileSync(path.join(root, 'renderer/index.html'), HTML.replace('v=1', 'v=2'))
  execSync('git add assets/css/a.css renderer/index.html', { cwd: root, env: GIT_SAFE_ENV, stdio: 'ignore' })
  const r = runStamp(root)
  assert.equal(r.code, 0, 'same-commit css+bump staged together must stay green: ' + r.out)
})

test('W25 cache-stamp: worktree-only css dirt with NOTHING staged is neither exemption nor offense (green)', () => {
  const root = mkStampRepo('stamp-worktree-only', '.a { color: red; }\n', HTML)
  fs.writeFileSync(path.join(root, 'assets/css/a.css'), '.a { color: blue; }\n')
  const r = runStamp(root)
  assert.equal(r.code, 0, 'an empty index tier must gate green regardless of worktree dirt: ' + r.out)
})

test('W25 cache-stamp: a fully clean tree stays green (normal committed path unchanged)', () => {
  const root = mkStampRepo('stamp-clean', '.a { color: red; }\n', HTML)
  const r = runStamp(root)
  assert.equal(r.code, 0, 'clean tree must stay green: ' + r.out)
  assert.match(r.out, /缓存戳纪律/, 'must print the pass verdict: ' + r.out)
})
