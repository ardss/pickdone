#!/usr/bin/env node
/**
 * 覆盖率棘轮门禁(ratchet,只升不降)。
 *
 * 背景(2026-09 D4 测试度量):unit 覆盖率此前不在任何门禁内,靠人肉维护。
 * 本脚本跑 unit 覆盖率,与 pickdone/cli/.coverage-baseline.json 比对:
 *   任一指标(行/分支/函数覆盖 %)低于基线 → 非零退出(覆盖率回退即红);
 *   全部达标且某指标实测高于基线 → 自动上调基线并回写(棘轮只升不降)。
 *
 * 用法:
 *   node cli/check-coverage-ratchet.cjs                   # 跑 coverage + 比对 + 通过时回写
 *   node cli/check-coverage-ratchet.cjs --update-baseline # 无条件以本次实测回写基线(校准用)
 *
 * 基线口径:2026-09-25 win32 实测(TODO_DB_DIR=mktemp node tests/run-all.mjs
 *   --experimental-test-coverage --suite=unit):lines 76.40 / branch 72.30 / funcs 62.80,
 *   向下取整为保守值(76/72/62)。linux CI 实测更高(86.65/81.68/77.83)只会向上棘轮,
 *   不会因平台文件集差异误红。
 * 注:package.json 提供 check:coverage-ratchet script;挂入 check-all.js ①池由 D2/人工
 *   在 cli/check-all.js GROUPS 加一行(本域不碰 check-all.js)。
 */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const BASELINE_FILE = path.join(__dirname, '.coverage-baseline.json')
const METRICS = [
  { key: 'lines', label: 'lines', column: 1 },
  { key: 'branches', label: 'branch', column: 2 },
  { key: 'functions', label: 'funcs', column: 3 }
]

// Coverage differs per platform (~10pt: win32 loads a smaller file set than linux CI), so the
// ratchet is per-platform: one shared number would let the higher platform red the lower one.
const PLATFORM = process.platform

function loadBaseline () {
  let base = { lines: 0, branches: 0, functions: 0 }
  if (fs.existsSync(BASELINE_FILE)) {
    const baselines = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')).baselines || {}
    base = { ...base, ...(baselines[PLATFORM] || {}) }
  }
  return base
}

function writeBaseline (measured) {
  let baselines = {}
  if (fs.existsSync(BASELINE_FILE)) {
    baselines = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')).baselines || {}
  }
  baselines[PLATFORM] = measured
  fs.writeFileSync(BASELINE_FILE, JSON.stringify({
    // 覆盖率棘轮基线 - 由 check-coverage-ratchet.cjs 通过时自动回写,请勿手工下调
    _comment: 'ratchet baseline per platform (win32/linux/darwin file sets differ ~10pt): each metric = last passing run on that platform, floored to whole percent',
    baselines
  }, null, 2) + '\n')
}

function runCoverage () {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-cov-'))
  try {
    const r = spawnSync(process.execPath, [
      'tests/run-all.mjs', '--experimental-test-coverage', '--suite=unit'
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, TODO_DB_DIR: tmp },
      maxBuffer: 512 * 1024 * 1024
    })
    return { out: (r.stdout || '') + (r.stderr || ''), code: r.status }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

// 只认「最后一个 coverage report 的 all files 汇总行」——测试进程 stdout 与表格共信道,
// 结构锚定与 check-test-summary.cjs 的 plan-锚定同理,防止输出混入伪造汇总行
function parseAllFiles (out) {
  const lines = out.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    // node 24 prints the total row as "# all files | x | y | z"; node 22 (CI) prints it
    // via the spec reporter as "ℹ all files | x | y | z" (no '#', an ℹ glyph prefix)
    const m = /^#?\s*(?:ℹ\s*)?all\s+files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/.exec(lines[i])
    if (m) return { lines: +m[1], branches: +m[2], functions: +m[3] }
  }
  return null
}

module.exports = { parseAllFiles, loadBaseline, writeBaseline }

if (require.main !== module) return

const SUMMARY_FILE = path.join(__dirname, '..', 'tests', '.artifacts', 'coverage-summary.json')
// The unit-test gate (check-all pool ②) runs run-all with --experimental-test-coverage, which
// writes coverage-summary.json. Reuse it when fresh instead of re-running the whole unit suite:
// running both suites CONCURRENTLY on a 4-vCPU CI runner doubled the load enough to time tests
// out (2026-09-26 windows red). Wait briefly for the concurrent unit stage to produce it.
const SUMMARY_MAX_AGE_MS = 30 * 60 * 1000
const SUMMARY_WAIT_MS = 12 * 60 * 1000
const SUMMARY_POLL_MS = 15 * 1000

function loadFreshSummary (notBefore) {
  try {
    const stat = fs.statSync(SUMMARY_FILE)
    if (Date.now() - stat.mtimeMs > SUMMARY_MAX_AGE_MS) return null
    if (notBefore && stat.mtimeMs < notBefore) return null
    const j = JSON.parse(fs.readFileSync(SUMMARY_FILE, 'utf8'))
    if (typeof j.lines === 'number' && typeof j.branches === 'number' && typeof j.functions === 'number') return j
    return null
  } catch { return null }
}

function waitForFreshSummary (notBefore) {
  const deadline = Date.now() + SUMMARY_WAIT_MS
  for (;;) {
    const s = loadFreshSummary(notBefore)
    if (s) return s
    if (Date.now() >= deadline) return null
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SUMMARY_POLL_MS)
  }
}

const force = process.argv.includes('--update-baseline')
// --await-summary (check-all only): the unit stage runs concurrently in the same pool, so wait
// for its coverage-summary.json. Standalone runs never wait — a missing/stale summary falls
// straight through to the suite run.
const startedAt = Date.now()
const preflight = loadFreshSummary(null)
const measuredFromSummary = preflight && (preflight.generatedAt && startedAt - Date.parse(preflight.generatedAt) < 60 * 1000)
  ? preflight
  : (process.argv.includes('--await-summary') ? waitForFreshSummary(startedAt) : null)

let measured
if (measuredFromSummary) {
  measured = { lines: measuredFromSummary.lines, branches: measuredFromSummary.branches, functions: measuredFromSummary.functions }
  console.log(`[check-coverage-ratchet] reused coverage summary from the unit gate (${measured.lines}/${measured.branches}/${measured.functions})`)
} else {
  const { out, code } = runCoverage()
  if (code !== 0) {
    console.error('✗ [check-coverage-ratchet] unit suite itself failed (exit ' + code + '), coverage not evaluated')
    const tail = out.split(/\r?\n/).filter(l => /^not ok /.test(l)).slice(0, 20)
    if (tail.length) console.error(tail.map(l => '  | ' + l).join('\n'))
    process.exit(1)
  }
  measured = parseAllFiles(out)
}
if (!measured) {
  console.error('✗ [check-coverage-ratchet] no "# all files" coverage summary found — reporter output changed?')
  process.exit(1)
}

const baseline = loadBaseline()
if (force) {
  writeBaseline(measured)
  console.log(`✓ [check-coverage-ratchet] baseline force-updated to ${JSON.stringify(measured)}`)
  process.exit(0)
}

const regressions = []
for (const { key, label } of METRICS) {
  const m = Math.floor(measured[key]) // 与基线同口径:向下取整后比较,避免 0.4 抖动误红
  if (m < baseline[key]) regressions.push(`${label}: ${measured[key]}% < baseline ${baseline[key]}%`)
}
if (regressions.length) {
  console.error('✗ [check-coverage-ratchet] coverage regressed below ratchet baseline:')
  for (const r of regressions) console.error('  - ' + r)
  console.error('  修法:补测试,不得下调基线。')
  process.exit(1)
}

// 棘轮回写:实测(取整)高于基线的指标上调
const raised = []
for (const { key, label } of METRICS) {
  const m = Math.floor(measured[key])
  if (m > baseline[key]) { baseline[key] = m; raised.push(`${label} → ${m}%`) }
}
if (raised.length) {
  writeBaseline(baseline)
  console.log(`✓ [check-coverage-ratchet] ratchet raised: ${raised.join(', ')}`)
}
console.log(`✓ [check-coverage-ratchet] coverage ${measured.lines}/${measured.branches}/${measured.functions} (lines/branch/funcs) ≥ baseline ${baseline.lines}/${baseline.branches}/${baseline.functions}`)
