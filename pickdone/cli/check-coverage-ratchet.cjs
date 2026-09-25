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

function loadBaseline () {
  let base = { lines: 0, branches: 0, functions: 0 }
  if (fs.existsSync(BASELINE_FILE)) {
    base = { ...base, ...JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')).baselines }
  }
  return base
}

function writeBaseline (measured) {
  fs.writeFileSync(BASELINE_FILE, JSON.stringify({
    // 覆盖率棘轮基线 - 由 check-coverage-ratchet.cjs 通过时自动回写,请勿手工下调
    _comment: 'ratchet baseline: each metric = last passing run, floored to whole percent',
    baselines: measured
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
    const m = /^#\s*all\s+files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/.exec(lines[i])
    if (m) return { lines: +m[1], branches: +m[2], functions: +m[3] }
  }
  return null
}

module.exports = { parseAllFiles, loadBaseline, writeBaseline }

if (require.main !== module) return

const force = process.argv.includes('--update-baseline')
const { out, code } = runCoverage()
if (code !== 0) {
  console.error('✗ [check-coverage-ratchet] unit suite itself failed (exit ' + code + '), coverage not evaluated')
  const tail = out.split(/\r?\n/).filter(l => /^not ok /.test(l)).slice(0, 20)
  if (tail.length) console.error(tail.map(l => '  | ' + l).join('\n'))
  process.exit(1)
}
const measured = parseAllFiles(out)
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
