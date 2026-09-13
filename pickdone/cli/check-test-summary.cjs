#!/usr/bin/env node
/**
 * 单测 TAP 摘要门禁（单一实现,pre-commit 与 check-all 共用,防两处逻辑再分叉）
 * 规则: exit code 非 0 即红;TAP 摘要 # fail 必须 0;# skipped ≤ SKIP_BASELINE(skip 棘轮,超线即红)
 *
 * 背景(2026-09-13 假绿清剿,堵 pre-commit 旧实现 `npm test --silent | grep -qE "# fail 0"` 的两个洞):
 *   ① 管道吞掉 exit code——只看输出里出现 "# fail 0" 7 个字符,任何来源的该字符串都能假绿;
 *   ② TAP 摘要 `# skip N` 不影响 `# fail 0`——把任意多测试改成 t.skip() 门禁照样绿(skip 侵蚀)。
 *
 * 用法:
 *   node cli/check-test-summary.cjs             # 自跑 node tests/run-all.mjs,TAP 写临时文件,exit code + 摘要双重校验
 *   node cli/check-test-summary.cjs <tapfile>   # 校验已有 TAP 输出文件(离线/测试复用同一套逻辑)
 * 环境变量 CHECK_TEST_SUMMARY_SKIP_BASELINE 可覆盖 skip 基线(仅供本脚本自测,门禁调用方不得设置)
 */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// skip 棘轮基线 —— 2026-09-13,实测 `npm test`(node --test TAP): # tests 849 / # pass 849 / # fail 0 / # skipped 0
// 新增 skip 需在提交说明中给出理由并手动下调此数;上调此数 = 放行更多 skip,门禁会拦
const SKIP_BASELINE = Number(process.env.CHECK_TEST_SUMMARY_SKIP_BASELINE ?? 0)
const TAIL_LINES = 30

function parseSummary (tap) {
  let fail, skip
  for (const line of tap.split(/\r?\n/)) {
    let m
    if ((m = /^# fail(?:ed)?\s+(\d+)\s*$/.exec(line))) fail = Number(m[1])
    else if ((m = /^# skip(?:ped)?\s+(\d+)\s*$/.exec(line))) skip = Number(m[1])
  }
  return { fail, skip }
}

function red (msg, tapFile) {
  console.error(`✗ [check-test-summary] ${msg}`)
  if (tapFile) {
    const lines = fs.readFileSync(tapFile, 'utf8').split(/\r?\n/)
    if (lines.length) {
      console.error(`  —— TAP 输出尾部 ${TAIL_LINES} 行 ——`)
      console.error(lines.slice(-TAIL_LINES).map(l => `  | ${l}`).join('\n'))
    }
  }
  process.exit(1)
}

const arg = process.argv[2]
let tapFile = arg || null
let exitCode = 0

if (arg) {
  if (!fs.existsSync(arg)) red(`TAP 文件不存在: ${arg}`)
} else {
  // 主管道模式:跑全量单测,TAP 重定向进临时文件(不靠管道,exit code 不被吞)
  tapFile = path.join(os.tmpdir(), `check-test-summary-${process.pid}-${Date.now()}.tap`)
  const fd = fs.openSync(tapFile, 'w')
  const r = spawnSync(process.execPath, ['tests/run-all.mjs'], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', fd, fd], // TAP 输出全量落盘,失败时回放尾部
  })
  fs.closeSync(fd)
  exitCode = r.status ?? (r.error ? 1 : 1)
  if (r.error) console.error(`  [warn] spawn 异常: ${r.error.message}`)
}

// 校验一: exit code(不再被管道丢弃)
if (exitCode !== 0) red(`单测进程 exit code = ${exitCode}(非 0 即红,不看摘要)`, tapFile)

// 校验二: TAP 摘要 fail=0 且 skip ≤ 基线
const tap = fs.readFileSync(tapFile, 'utf8')
const { fail, skip } = parseSummary(tap)
if (fail == null || skip == null) {
  red(`TAP 摘要解析失败(fail=${fail} skip=${skip})——reporter 可能不是 TAP 或输出被截断,不得假绿放行`, tapFile)
}
if (fail > 0) red(`# fail = ${fail}(要求 0)`, tapFile)
if (skip > SKIP_BASELINE) {
  red(`# skipped = ${skip} > 棘轮基线 ${SKIP_BASELINE}——新增 skip 需要说明+降基线(改 cli/check-test-summary.cjs 的 SKIP_BASELINE)`, tapFile)
}

console.log(`✓ [check-test-summary] # pass ${/# pass\s+(\d+)/.exec(tap)?.[1] ?? '?'} / # fail ${fail} / # skipped ${skip} ≤ 基线 ${SKIP_BASELINE}`)
