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
 * 环境变量 CHECK_TEST_SUMMARY_SKIP_BASELINE 可覆盖 skip 基线——仅当 CHECK_TEST_SUMMARY_SELFTEST=1
 * 同时设置时生效(本脚本自测);单独出现时判定为环境泄漏,大声告警并忽略(见下方 SKIP_BASELINE 计算)。
 */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// skip 棘轮基线 —— 2026-09-13 全平台收紧并由 CI 实证校准:
//   linux:7 = 2(见下) + 5(2026-10-30 e2e-exit-close 遵循 CHECK_ALL_SKIP_LIVE 的 CI 守卫:
//             该套件是真拉起 Electron、断言托盘行为的 live 测试,xvfb 无托盘无法满足其验收,
//             ubuntu 上按设计 skip 1 主测+2 子测;连同 run 41060199845 的实测计数校准;
//             live 全量仍由 windows runner 实跑覆盖,覆盖无缺口)
//             其中 2 = f6-round6-fixes 的跨盘符 file:// 语义测试(纯 Windows 概念,`WIN ? test : test.skip`)
//             + lan-sync-journey 套件级 skip(ubuntu CI 设 CHECK_ALL_SKIP_LIVE=1,live electron 类
//             测试在 ubuntu 上按设计跳过,由 windows runner 实跑覆盖;PR #160 实证)
//   darwin:1 = 推断值(WIN 条件在 darwin 同为 false 必跳这条),无 darwin CI 实证——门禁只在 ubuntu+windows 跑
//   win32:0 = windows 实测 0 skip
// 新增 skip 会被棘轮拦下并打印用例名;确属平台性合理 skip 时,在此处带注释给对应平台加基线。
// Two native window probes require a *user desktop* (Progman and physical cursor).
// GitHub-hosted Windows jobs run as a service, not an interactive desktop. They
// are still exercised on a real interactive Windows workstation before release.
// Scope the extra allowance to that exact CI service environment: local Windows
// stays at zero skipped tests; arbitrary exported skip baseline cannot bypass it.
const hostedWinService = process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_OS === 'Windows'
const PLATFORM_SKIP_BASELINE = { win32: hostedWinService ? 2 : 0, linux: 7, darwin: 1 }
// [fail-closed 2026-10-26] the raw env override voided the skip ratchet from ANY stray
// exported env var (CI job env, a dev shell rc file) — a silent ratchet bypass. It is now
// gated: honored only alongside CHECK_TEST_SUMMARY_SELFTEST=1 (the script's own self-test);
// an override without the self-test flag prints a loud warning and is IGNORED.
const SKIP_BASELINE_OVERRIDE = process.env.CHECK_TEST_SUMMARY_SKIP_BASELINE
const SELFTEST_ENABLED = process.env.CHECK_TEST_SUMMARY_SELFTEST === '1'
let SKIP_BASELINE
if (SKIP_BASELINE_OVERRIDE !== undefined && SELFTEST_ENABLED) {
  SKIP_BASELINE = Number(SKIP_BASELINE_OVERRIDE)
} else {
  if (SKIP_BASELINE_OVERRIDE !== undefined) {
    console.error(`⚠ [check-test-summary] CHECK_TEST_SUMMARY_SKIP_BASELINE=${SKIP_BASELINE_OVERRIDE} 已设置但未同时设置 CHECK_TEST_SUMMARY_SELFTEST=1 —— 判定为环境泄漏,覆盖被忽略,使用平台基线(棘轮不被绕过)`)
  }
  SKIP_BASELINE = PLATFORM_SKIP_BASELINE[process.platform] ?? 0
}
const TAIL_LINES = 30

function parseSummary (tap) {
  const lines = tap.split(/\r?\n/)
  // 结构锚定(2026-09-13 红队 G1):摘要行只认「最后一个 TAP plan(1..N)之后」的区段——
  // 之前只按"最后出现"取值,测试进程 stdout 与摘要共信道,任何输出里混入 `# fail 0`
  // 都能覆盖真实摘要(5 种注入变体实测全部绕过)。锚定后 plan 之前的所有 `#` 行都是普通输出。
  // 仍无法防御 run-all.mjs 本身被篡改(门禁解释器与被检代码同仓,结构性上限),那层防线在 CI+分支保护。
  let planIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^1\.\.\d+\s*$/.test(lines[i])) { planIdx = i; break }
  }
  if (planIdx === -1) return { pass: undefined, fail: undefined, skip: undefined, cancelled: undefined, plan: undefined }
  let pass, fail, skip, cancelled
  for (const line of lines.slice(planIdx + 1)) {
    let m
    // [2026-10-31] `# pass` anchored after the last plan too — the raw grep at the success log
    // used to take the LAST `# pass` anywhere in the stream, so a composed flake-retry run
    // (raw pass1 plan above + authoritative composed plan below) could report the WRONG pass
    // count; fail/skip/cancelled were already plan-anchored, now pass matches that contract.
    if ((m = /^# pass(?:ed)?\s+(\d+)\s*$/.exec(line))) pass = Number(m[1])
    else if ((m = /^# fail(?:ed)?\s+(\d+)\s*$/.exec(line))) fail = Number(m[1])
    else if ((m = /^# skip(?:ped)?\s+(\d+)\s*$/.exec(line))) skip = Number(m[1])
    else if ((m = /^# cancel(?:l)?ed\s+(\d+)\s*$/.exec(line))) cancelled = Number(m[1])
  }
  // W25 2026-11-01: expose the anchored plan's N so the caller can cross-check plan vs
  // summary (TAP plan semantics = test-point count). Raw node:test TAP legitimately has
  // plan = TOP-LEVEL tests while the summary counts ALL test points (nested subtests) —
  // that mismatch is expected and must NOT red; only a COMPOSED stream (run-all's own
  // synthesis, which promises summary-unit plans since W25) is held to the contract.
  const planM = /^1\.\.(\d+)\s*$/.exec(lines[planIdx])
  return { pass, fail, skip, cancelled, plan: planM ? Number(planM[1]) : undefined }
}

function red (msg, tapFile) {
  console.error(`✗ [check-test-summary] ${msg}`)
  if (tapFile) {
    // Failure TAP lands IN THE REPO TREE (tests/.artifacts/last-failed-unit.tap), not just
    // %TEMP%: a tmpdir path nobody can find cost a whole diagnostic cycle on 2026-10-22 (a
    // budget-killed run left zero accessible diagnostics and burned three gate re-runs).
    // Overwrite per run — it is a pointer to the LATEST failure, not an archive.
    try {
      const repoTap = path.join(__dirname, '..', 'tests', '.artifacts', 'last-failed-unit.tap')
      fs.mkdirSync(path.dirname(repoTap), { recursive: true })
      fs.copyFileSync(tapFile, repoTap)
      console.error(`  —— full failing TAP copied to ${repoTap} ——`)
    } catch { /* best effort — the tmpdir original below is still there */ }
    const lines = fs.readFileSync(tapFile, 'utf8').split(/\r?\n/)
    if (lines.length) {
      console.error(`  —— TAP 输出尾部 ${TAIL_LINES} 行 ——`)
      console.error(lines.slice(-TAIL_LINES).map(l => `  | ${l}`).join('\n'))
    }
    // 失败用例名全量回放(tail-30 常吞掉输出中段的 "not ok N - <name>",2026-09-19 ubuntu 实锤:
    // "# fail 1" 可见但失败用例名既不在尾部也不在 check-all 的 diag 里,无法定位)
    const failCases = lines.filter(l => /^not ok \d/.test(l)).slice(0, 20)
    if (failCases.length) {
      console.error(`  —— 失败用例(${failCases.length}) ——`)
      console.error(failCases.map(l => `  | ${l.trim().slice(0, 200)}`).join('\n'))
      // 每个失败用例 TAP 块里的错误信息行(name/message/stack 首行)
      for (const fc of failCases) {
        const i = lines.indexOf(fc)
        if (i === -1) continue
        const detail = lines.slice(i + 1, i + 40).filter(l => /^\s+(message|code|expected|actual|operator):/.test(l)).slice(0, 6)
        if (detail.length) console.error(detail.map(l => `  | ${l.trim().slice(0, 200)}`).join('\n'))
      }
    }
  }
  process.exit(1)
}

// W30 (2026-11-01) coverage instrument unification. run-all tags its coverage-summary.json with
// the suite pool it ran (suiteTag: `all` with no --suite, `unit` with --suite=unit, `unit+core`
// when --tier rides along), and the ratchet gate treats anything but bare 'unit' as a foreign
// instrument (tier-suffixed summaries are outright slot pollution → hard red). A bare
// `--with-coverage` therefore used to produce an 'all'-pool summary that the ratchet could only
// compare-not-raise against — the two gates were measuring with different instruments.
// Fix: --with-coverage pins --suite=unit (the ratchet's calibration pool). Consequences handled:
//   - --with-coverage + --core is FORBIDDEN outright: the pool would be unit∩core = unit-minus-deep,
//     tagged 'unit+core', which summaryIsTierScoped reds on. There is no legal calibration story
//     for that combo, so fail fast before spawning any tests.
//   - --affected dirs come from the code-surface map (any suite); under --suite=unit the pool is
//     tests/unit/** + sibling test/ only, and run-all fail-closes on a --dirs entry matching zero
//     pool files. Intersect with the unit pool; empty intersection → drop --dirs entirely
//     (degrade to the full unit pool, still the right instrument) instead of a hard red.
// Pure + exported so the w30 anchor test can pin the matrix without spawning tests.
const UNIT_POOL_DIRS = ['tests/unit', 'test'] // run-all suiteOf: tests/unit/** + sibling test/ dir
function resolveCoverageScope ({ withCoverage, core, affectedDirs }) {
  if (!withCoverage) return { suite: null, dirs: affectedDirs || null, degraded: false }
  if (core) {
    return {
      fatal: '--with-coverage 与 --core 不得组合:池为 unit∩core 且摘要 suite 标签会是 "unit+core",被覆盖率棘轮判为共享槽污染直接报红,组合无合法口径。校准请单跑 --with-coverage(全量 unit 池);core 层单测走无覆盖率门禁。',
      suite: null, dirs: null, degraded: false
    }
  }
  const requested = affectedDirs || []
  const dirs = requested.filter(d => UNIT_POOL_DIRS.some(p => d === p || d.startsWith(p + '/')))
  return {
    suite: 'unit',
    dirs: dirs.length ? dirs : null,
    degraded: requested.length > 0 && dirs.length === 0
  }
}

module.exports = { parseSummary, resolveCoverageScope, UNIT_POOL_DIRS }

function main () {
// Only a non-flag argument is a TAP-file path; flags (--with-coverage) are options
const arg = process.argv.slice(2).find(a => !a.startsWith('--')) ?? null
let tapFile = arg || null
let exitCode = 0

if (arg) {
  if (!fs.existsSync(arg)) red(`TAP 文件不存在: ${arg}`)
} else {
  // 主管道模式:跑单测层,TAP 重定向进临时文件(不靠管道,exit code 不被吞)
  tapFile = path.join(os.tmpdir(), `check-test-summary-${process.pid}-${Date.now()}.tap`)
  // --with-coverage: forward --experimental-test-coverage so run-all writes the coverage
  // summary for the ratchet gate (avoids a second concurrent full-suite run). W30: this gate
  // now ALWAYS pins --suite=unit alongside it (see resolveCoverageScope) so the shared slot
  // always holds the ratchet's calibration instrument.
  // --core: forward --tier=core (pure in-process specs; deep suites — live Electron, two-instance
  // lan-sync journeys, loopback drills — stay with the full check:all gate). Forbidden with
  // --with-coverage (resolveCoverageScope fatal) — no legal coverage-calibration story for it.
  // --affected: consult cli/check-test-scope.cjs; scoped → --dirs run, full → plain --core,
  // skip → docs-only change, unit stage not meaningful (loud, never silent).
  const withCoverage = process.argv.includes('--with-coverage')
  const core = process.argv.includes('--core')
  let affectedDirs = null
  if (process.argv.includes('--affected')) {
    const { scopeFor } = require('./check-test-scope.cjs')
    const verdict = scopeFor() // no args: reads git staged set itself
    if (verdict.verdict === 'skip') {
      console.log(`✓ [check-test-summary] SKIPPED: ${verdict.reason}`)
      process.exit(0)
    }
    if (verdict.verdict === 'scoped') {
      affectedDirs = verdict.dirs
      console.log(`[check-test-summary] affected scope: ${verdict.reason}`)
    } else {
      console.log(`[check-test-summary] affected scope unavailable → full core tier (${verdict.reason})`)
    }
  }
  const cov = resolveCoverageScope({ withCoverage, core, affectedDirs })
  if (cov.fatal) red(cov.fatal)
  if (cov.degraded) console.log('[check-test-summary] affected scope 与 unit 池目录交集为空 → 去掉 --dirs,降级为全量 unit 口径(--with-coverage 的覆盖率摘要必须来自 unit 池;空 --dirs 会被 run-all 判硬红)')
  const extra = [
    ...(withCoverage ? ['--experimental-test-coverage'] : []),
    ...(cov.suite ? [`--suite=${cov.suite}`] : []),
    ...(!withCoverage && core ? ['--tier=core'] : []),
  ]
  if (cov.dirs) extra.push(`--dirs=${cov.dirs.join(',')}`)
  const runOnce = tapPath => {
    const fd = fs.openSync(tapPath, 'w')
    // run-all is streaming now: the tap file grows live, so a hung/budget-killed run leaves
    // diagnostics instead of a 0-byte mystery.
    const r = spawnSync(process.execPath, ['tests/run-all.mjs', ...extra], {
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', fd, fd], // TAP 输出全量落盘,失败时回放尾部
    })
    fs.closeSync(fd)
    return r
  }
  let r = runOnce(tapFile)
  // --retry-once (2026-10-23, load-flake doctrine): on a loaded dev host a DIFFERENT
  // timing-sensitive suite dies per run (2026-10-22/23 evidence: purge family at conc 4,
  // +tombstone at conc 8, updater-metadata in a third run — each green in isolation). Same
  // doctrine as run-all's native-crash retry and the CI rerun-failed rule: a single rerun;
  // green second pass = pass with a loud note, red again = real red. The first TAP is kept
  // as *.prev for forensics either way.
  if (process.argv.includes('--retry-once')) {
    const firstTap = tapFile + '.prev'
    const judge = rr => rr.status ?? (rr.error ? 1 : 1)
    if (judge(r) !== 0) {
      try { fs.copyFileSync(tapFile, firstTap) } catch { /* forensics best-effort */ }
      console.error('[check-test-summary] red on pass 1 — retry-once (load-flake doctrine); pass-1 TAP kept at ' + firstTap)
      r = runOnce(tapFile)
    }
  }
  exitCode = r.status ?? (r.error ? 1 : 1)
  if (r.error) console.error(`  [warn] spawn 异常: ${r.error.message}`)
}

// 校验一: exit code(不再被管道丢弃)
if (exitCode !== 0) red(`单测进程 exit code = ${exitCode}(非 0 即红,不看摘要)`, tapFile)

// 校验二: TAP 摘要 fail=0, cancelled=0, skip ≤ 基线
const tap = fs.readFileSync(tapFile, 'utf8')
const { pass, fail, skip, cancelled, plan } = parseSummary(tap)
if (fail == null || skip == null || cancelled == null) {
  red(`TAP 摘要解析失败(fail=${fail} skip=${skip} cancelled=${cancelled})——未见 plan 行(1..N)或摘要不全,reporter 可能不是 TAP 或输出被截断,不得假绿放行`, tapFile)
}
if (fail > 0) red(`# fail = ${fail}(要求 0)`, tapFile)
if (cancelled > 0) red(`# cancelled = ${cancelled}(要求 0——被取消的用例既非 pass 也非 fail,不得静默)`, tapFile)
// W25 2026-11-01: plan vs summary consistency (low-confidence detector).
//  - COMPOSED stream (run-all's own synthesis, marked `# COMPOSED-TAP-FOLLOWS`): the composer
//    promises plan = pass+fail+skip+cancelled (all in test-point units). A mismatch means the
//    composer's accounting broke — that is exactly the "no consumer could detect the drift"
//    hole this closes, and low confidence here must NOT read green → red (fail-closed).
//  - Raw node:test TAP: plan counts TOP-LEVEL tests only while the summary counts all test
//    points (nested subtests), so a mismatch is node's own legitimate semantics — warn loud,
//    never red (a hard red here would fail every raw run).
if (plan != null && pass != null && fail != null && skip != null && cancelled != null) {
  const summaryPoints = pass + fail + skip + cancelled
  if (plan !== summaryPoints) {
    if (/^# COMPOSED-TAP-FOLLOWS/m.test(tap)) {
      red(`TAP plan(1..${plan}) 与摘要行口径不一致(pass ${pass} + fail ${fail} + skip ${skip} + cancelled ${cancelled} = ${summaryPoints})——composed 流承诺 plan 与摘要同单位,错位即低置信,不得放行`, tapFile)
    } else {
      console.error(`⚠ [check-test-summary] plan(1..${plan}) ≠ 摘要点数(${summaryPoints})——node:test 原生口径(plan=顶层用例数,摘要=全部测试点),仅告警不拦截`)
    }
  }
}
if (skip > SKIP_BASELINE) {
  // 打出 skip 用例名,定位是哪条测试在跳
  // W25 2026-11-01: `^\s*ok` — node:test nests each file's test points as INDENTED
  // `ok N ... # SKIP` lines inside the file's top-level block (same shape run-all's
  // W15 per-test-point counter matches); the old `^ok\b` replay missed them all.
  const skipNames = tap.split(/\r?\n/).filter(l => /# SKIP|# skipped/i.test(l) && /^\s*ok\b/.test(l)).slice(0, 10)
  if (skipNames.length) console.error('  [skip cases]\n' + skipNames.map(l => `    ${l.trim().slice(0, 150)}`).join('\n'))
  red(`# skipped = ${skip} > 棘轮基线 ${SKIP_BASELINE}——新增 skip 需要说明+降基线(改 cli/check-test-summary.cjs 的 SKIP_BASELINE)`, tapFile)
}

console.log(`✓ [check-test-summary] # pass ${pass ?? '?'} / # fail ${fail} / # cancelled ${cancelled} / # skipped ${skip} ≤ 基线 ${SKIP_BASELINE}`)
// 临时 TAP:成功即清;失败路径经 red() exit 保留在 tmpdir 供人工回放(有意为之)。
// W30: --retry-once 的 pass-1 存证(*.prev)同样只在失败路径保留——成功路径必须一并清掉,
// 否则每次带 retry 的绿跑都在 %TEMP% 泄漏一份全量 TAP(原实现只删了正本)。
if (!arg) {
  try { fs.unlinkSync(tapFile) } catch { /* already gone */ }
  try { fs.unlinkSync(tapFile + '.prev') } catch { /* no retry pass-1 this run */ }
}
} // main

if (require.main === module) main()
