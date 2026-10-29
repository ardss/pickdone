/* W18 gate fixes — detection-side pins ("who checks the checks") for four verified
 * gate defects, each proven on a temp fixture via the GATE_ROOT override:
 *   1. check-esm-graph: named re-export `export { x } from './y'` produced NO graph
 *      edge (target existence/case/named-export all unchecked) — broken target must go red.
 *   2. check-esm-graph: the vueScript regex required a newline after `<script>`, so a
 *      single-line script SFC fell ENTIRELY out of the graph — broken import inside it must go red.
 *   3. check-boot-order: declaratorIds counted destructuring property KEYS as bindings
 *      (`{ a: b }` registered phantom 'a') — a top-level use of an unbound key must NOT go red.
 *   4. check-boot-order --staged: injected GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE were not
 *      stripped, so under a hook env the git calls resolved against the wrong repo — with a
 *      poisoned GIT_DIR the gate must still work against the fixture repo (mirror of the
 *      check-file-size.cjs:92-97 fix).
 * Run: node --test tests/unit/cli/w18-gate-fixes.test.mjs
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const CLI = path.join(import.meta.dirname, '../../../cli')
// Fixture anchor: inside the checkout, NOT os.tmpdir() — esm-graph's caseMatches()
// verifies path segments against real directory entries and CI's 8.3 TEMP paths break it
// (same reasoning as gate-must-fail-golden.test.mjs). .tmp-* is gitignored.
const FIX_ROOT = path.join(import.meta.dirname, '../../../.tmp-w18-gate-fixes')
const madeDirs = []

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
  const r = spawnSync(process.execPath, [path.join(CLI, script), ...args], { timeout: 120000, env, encoding: 'utf8' })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

// esm-graph fixtures need the entry the gate walks: renderer/js/main.js
function esmFixture (write, files) {
  const main = files.main || "import './lib.js'\n"
  write('renderer/js/main.js', main)
  for (const [rel, src] of Object.entries(files)) write(rel, src)
}

afterEach(() => {
  for (const d of madeDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* next run cleans via .tmp-* */ }
  }
})

test('[1] esm-graph: named re-export to a MISSING target must go red', () => {
  const t = mkTree('esm-reexport-missing')
  esmFixture(t.write, {
    'renderer/js/lib.js': "export { x } from './target.js'\n"
  })
  const r = runGate('check-esm-graph.cjs', t.root)
  assert.equal(r.code, 1, 'broken re-export target must fail the gate\n' + r.out)
  assert.match(r.out, /target\.js/, 'must name the missing re-export target')
})

test('[1] esm-graph: named re-export of a name NOT in the target must go red', () => {
  const t = mkTree('esm-reexport-phantom-name')
  esmFixture(t.write, {
    'renderer/js/lib.js': "export { nope } from './target.js'\n",
    'renderer/js/target.js': 'export const x = 1\n'
  })
  const r = runGate('check-esm-graph.cjs', t.root)
  assert.equal(r.code, 1, 'phantom re-exported name must fail the gate\n' + r.out)
  assert.match(r.out, /nope/, 'must name the missing export')
})

test('[1] esm-graph: a LEGAL named re-export chain must stay green', () => {
  const t = mkTree('esm-reexport-legal')
  esmFixture(t.write, {
    'renderer/js/lib.js': "export { x } from './target.js'\n",
    'renderer/js/target.js': 'export const x = 1\n'
  })
  const r = runGate('check-esm-graph.cjs', t.root)
  assert.equal(r.code, 0, 'legal re-export must not false-red\n' + r.out)
})

test('[2] esm-graph: broken import inside a SINGLE-LINE script SFC must go red', () => {
  const t = mkTree('esm-single-line-sfc')
  esmFixture(t.write, {
    'renderer/js/main.js': "import './comp.vue'\n",
    'renderer/js/comp.vue': "<script>import './missing-helper.js'</script>\n<template><div /></template>\n"
  })
  const r = runGate('check-esm-graph.cjs', t.root)
  assert.equal(r.code, 1, 'single-line script SFC must not silently escape the graph\n' + r.out)
  assert.match(r.out, /missing-helper\.js/, 'must name the missing import')
})

test('[2] esm-graph: single-line script SFC with intact imports stays green', () => {
  const t = mkTree('esm-single-line-sfc-ok')
  esmFixture(t.write, {
    'renderer/js/main.js': "import './comp.vue'\n",
    'renderer/js/comp.vue': "<script>import './helper.js'</script>\n<template><div /></template>\n",
    'renderer/js/helper.js': 'export const h = 1\n'
  })
  const r = runGate('check-esm-graph.cjs', t.root)
  assert.equal(r.code, 0, 'legal single-line script SFC must not false-red\n' + r.out)
})

test('[3] boot-order: destructuring KEY use is not a phantom binding (no false red)', () => {
  const t = mkTree('boot-phantom-key')
  // `a` is the KEY in `{ a: b }` — only `b` is bound. Using `a` above the require
  // used to red via the phantom 'a' binding.
  t.write('src/main/mod.js', "const x = a\nconst { a: b } = require('./x.js')\nmodule.exports = { x, b }\n")
  t.write('src/main/x.js', 'module.exports = {}\n')
  const r = runGate('check-boot-order.cjs', t.root)
  assert.equal(r.code, 0, 'unbound key must not be treated as a require binding\n' + r.out)
})

test('[3] boot-order: real destructured VALUE binding below first use still goes red', () => {
  const t = mkTree('boot-value-binding')
  t.write('src/main/mod.js', "const x = b\nconst { a: b } = require('./x.js')\nmodule.exports = { x }\n")
  t.write('src/main/x.js', 'module.exports = {}\n')
  const r = runGate('check-boot-order.cjs', t.root)
  assert.equal(r.code, 1, 'value binding below first use must still be detected\n' + r.out)
  assert.match(r.out, /require destructuring binds 'b'/)
})

test('[4] boot-order --staged: poisoned GIT_DIR must not break the git calls', () => {
  const t = mkTree('boot-staged-env')
  t.write('src/main/mod.js', "const x = b\nconst { a: b } = require('./x.js')\nmodule.exports = { x }\n")
  t.write('src/main/x.js', 'module.exports = {}\n')
  execFileSync('git', ['init', '-q'], { cwd: t.root, env: GIT_SAFE_ENV })
  execFileSync('git', ['add', '-A'], { cwd: t.root, env: GIT_SAFE_ENV })
  // Poison the hook env exactly like git does: without the env strip the git calls
  // resolve against the bogus GIT_DIR and the gate fails for the WRONG reason (git
  // error / zero-file scan) instead of the real finding.
  const r = runGate('check-boot-order.cjs', t.root, ['--staged'], {
    GIT_DIR: 'Z:\\definitely-not-a-git-dir',
    GIT_WORK_TREE: 'Z:\\definitely-not-a-worktree'
  })
  assert.equal(r.code, 1, 'staged violation must still go red under a poisoned hook env\n' + r.out)
  assert.match(r.out, /require destructuring binds 'b'/, 'red must be the REAL finding, not a git failure\n' + r.out)
})

test('[4] boot-order --staged: clean staged file under poisoned GIT_DIR stays green', () => {
  const t = mkTree('boot-staged-env-clean')
  t.write('src/main/mod.js', "const { a: b } = require('./x.js')\nmodule.exports = { b }\n")
  t.write('src/main/x.js', 'module.exports = {}\n')
  execFileSync('git', ['init', '-q'], { cwd: t.root, env: GIT_SAFE_ENV })
  execFileSync('git', ['add', '-A'], { cwd: t.root, env: GIT_SAFE_ENV })
  const r = runGate('check-boot-order.cjs', t.root, ['--staged'], {
    GIT_DIR: 'Z:\\definitely-not-a-git-dir',
    GIT_WORK_TREE: 'Z:\\definitely-not-a-worktree'
  })
  assert.equal(r.code, 0, 'clean staged scan must stay green under a poisoned hook env\n' + r.out)
  assert.doesNotMatch(r.out, /0 个文件/, 'must have actually scanned the staged files (no zero-scan fake green)')
})
