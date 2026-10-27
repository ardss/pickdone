#!/usr/bin/env node
/**
 * Unified entry for all-dimension checks (SOP-00) — runs every automated check and summarizes the results
 * Usage: node cli/check-all.js [--a11y] [--fast]
 *   --a11y: additionally runs the live axe scan (needs an app in CDP mode; not run by default, see cli/a11y-scan.js)
 *   --fast: static-only tier (group ② gates+types+unit tests, no build/live/visual) — sub-2-minute
 *           pre-push sanity; CI and release still run the full check:all
 * Any failure → non-zero exit; used as a one-shot full checkup before release/milestones.
 *
 * 执行模型(2026-09-06 效率专项:25 阶段纯串行 ~11min → 实测 5min 内,见提交 f9d60ac 及后续):
 *   ① build 先行(后续门禁依赖 renderer-dist 产物,唯一硬串行;失败即短路)
 *   ②③ build 完两池同时起跑:静态池(静态门禁+类型+单测,3 道,ESLint --cache 热跑秒级)
 *      与 Electron 活体池(3 道,各自独立随机端口+独立 mkdtemp userData 天然无共享;
 *      smoke 日志按脚本+pid 分文件;活体失败重试 1 次抗并行负载时序抖动)
 * 每阶段计时输出;总时长汇总。依赖关系只允许出现在"阶段内部",池间/池内全部并行。
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import evtUtils from './event-utils.cjs'
// D4 orphan hygiene (2026-10-23 speed wave): every stage child is registered at spawn and
// pruned on 'close'; an exit-handler reap covers the crash paths (a hard-killed check-all
// used to leave its live stage children — Electron instances included — as orphans).
import { registerChild, unregisterChild, reapAllRegisteredSync } from '../tests/lib/child-registry.mjs'

const WITH_A11Y = process.argv.includes('--a11y')
const FAST = process.argv.includes('--fast')
// Electron spawned by the live/visual pools must boot as the GUI runtime, never as plain
// Node: agent/IDE host shells (DSH/VSCode) export ELECTRON_RUN_AS_NODE=1, which makes
// electron.exe execute src/main/index.js as a plain CJS script and die at line 7
// (TypeError: Cannot read properties of undefined (reading 'getVersion')) — the
// 2026-10-23 09:15 full gate lost all 9 live lanes to exactly this when first run from a
// harness shell (fast gates never saw it: --fast skips the live pool; the d2-crosscutting
// audit had filed the two unstripped scripts, not applied). The gate itself never needs
// electron-as-node, so the strip is safe to apply centrally: every stage child inherits
// this process's env. Suite-level strips (journey-driver, e2e-exit-close, lan-sync-journey)
// stay as belt-and-braces; this removes the host-shell dependency for the whole gate.
delete process.env.ELECTRON_RUN_AS_NODE
// CPU-aware lane count for the Electron live pool: scale down on small machines, never exceed 3
// (known load-sensitive gates: dbMirror backoff, perf 5000-task, UI coverage walkthrough get WORSE
// under contention, so the ceiling stays at 3 even on 16-core boxes)
const CPUS = os.availableParallelism ? os.availableParallelism() : os.cpus().length
const LANES = Math.max(1, Math.min(3, CPUS))
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const GROUPS = [
  {
    name: '① 构建先行（Electron 门禁依赖 renderer-dist 产物）', parallel: 1,
    stages: [
      ['Vite 渲染层构建(产物 renderer-dist,app:// 运行时形态)', 'npm', ['run', 'build:renderer']],
    ]
  },
  {
    // 静态门禁红=确定性红(纯文件分析/类型/单测,无时序因素),重试没有意义只会翻倍耗时——不设 retry
    name: '② 静态门禁+类型+单元（并行 3 道,与③池同时起跑）', parallel: 3, retry: 0,
    stages: [
      ['指纹脱敏', 'node', ['cli/check-fingerprint.js']],
      ['依赖许可证', 'node', ['cli/check-licenses.js']],
      ['token 纪律', 'node', ['cli/check-tokens.js']],
      ['结构尺寸棘轮（文件行数分级上限+baseline只降不升——千行SFC与lib.js 1869行实锤后立的第6防护维度）', 'node', ['cli/check-file-size.cjs']],
      ['启动顺序（src/main 顶层 use-before-let/const + require 在首次顶层使用之后——D10 提取改动两处 boot TDZ 崩溃零门禁可抓,8 个活体门禁红都只是症状）', 'node', ['cli/check-boot-order.cjs']],
      ['CSS 冻结(全局沉积文件只删不增,组件吸收重构护栏)', 'node', ['cli/check-css-freeze.mjs']],
      ['缓存戳纪律(?v= 未 bump=已装用户永拿旧缓存,2026-09-05 三笔连漏实锤后立门禁)', 'node', ['cli/check-cache-stamp.js']],
      ['提交身份(HEAD邮箱不得携带个人身份——QQ邮箱上公开仓实锤,SOP-02 §7)', 'node', ['cli/check-commit-identity.js']],
      ['变更操作反馈一致性（完成/删除/移动必须过撤销或确认出口,白名单制）', 'node', ['cli/check-op-feedback.js']],
      ['IPC op 覆盖（渲染端调用面⊆白名单⊆db.OPS,防功能静默全断）', 'node', ['cli/check-ipc-op-coverage.cjs']],
      ['命令总线单写门（渲染端写形 dbCall 直连=0,manifest↔db.OPS/白名单互查,refactor-command-bus P1）', 'node', ['cli/check-command-bus.cjs']],
      ['sync-matrix contract (docs/sync-matrix.md entities <-> SYNCABLE_ENTITIES/command manifest/DATA_CHANNEL_KINDS, both directions — silent drop-out of sync coverage bug class)', 'node', ['cli/check-sync-matrix.cjs']],
      ['双写台账（渲染端每个 localStorage 写点须声明权威源,防 LS 镜像与 DB 漂移——CLI/UI 联动 bug 根治防线）', 'node', ['cli/check-dualwrite.cjs']],
      ['SCHEMA/MIGRATIONS 双清单收敛（todoToRow⊆SCHEMA、迁移补列⊆SCHEMA、运行时自愈兜底不得回潮——PA-3 静态拦截替代 db.js 启动补列）', 'node', ['cli/check-schema-manifests.cjs']],
      ['ESM 模块图（import/export 匹配——白屏级事故在门禁拦截）', 'node', ['cli/check-esm-graph.cjs']],
      ['i18n 全量', 'node', ['cli/check-i18n.js', '--all']],
      ['i18n 体系（缺失/占位符/双形态/异值/主进程）', 'node', ['renderer/js/i18n/check-i18n.mjs']],
      ['媒体语言配对（英文侧媒体必须 en 标记命名——中文界面 gif 曾混入英文 README 实锤,SOP-05 §5）', 'node', ['cli/check-media-lang.js']],
      ['hover 对比度（悬浮文字隐形/白字被改写,含负向自测）', 'node', ['cli/check-hover-contrast.cjs'], { HOVER_CONTRAST_SELFTEST: '1' }],
      ['scheduler 修复回归（firedReminders LRU+持久化+二次 fire 防退化）', 'node', ['cli/check-scheduler-lru.mjs']],
      // 直接用 node 起 eslint bin：npx 在部分环境（bash 无 npm 全局 PATH）spawn ENOENT 被误判为门禁红（2026-09-04 实锤）
      // --cache:热跑只 lint 变更文件,2.2min→秒级(缓存文件 .eslintcache 已 gitignore)
      ['ESLint', 'node', ['node_modules/eslint/bin/eslint.js', 'renderer/js', 'cli', 'src', 'tests', '--quiet', '--cache']],
      ['vue-tsc 类型检查(SFC script lang=ts + 全局契约)', 'node', ['node_modules/vue-tsc/bin/vue-tsc.js', '--noEmit', '--incremental']],
      // 经 check-test-summary.cjs 跑同一套 fail=0 + skip 棘轮校验(与 pre-commit 单一实现,防两处分叉)
      // --with-coverage: run-all also writes tests/.artifacts/coverage-summary.json on this pass
      // 40min budget (was 15): the round-2 audit wave (J15/J17 pin suites + anchor re-pins) plus
      // general suite growth pushed the loaded Windows host past 15min — two budget kills at
      // exactly 15.3min with zero diagnostics (2026-10-22 21:52 + 23:07 fast runs); the suite
      // itself completes in ~33min there with a full TAP. Same class as the earlier 10->15 raise.
      // 80min budget (was 40): --retry-once doubles the worst case — the budget covers BOTH
      // passes. The 2026-10-23 02:40 acceptance run proved the miss: pass1 red at 25min +
      // pass2 budget-killed at 15min mid-flight (stage total 40.1min) with pass2 heading green.
      // Coverage poller must still exceed it (85 > 80).
      // --retry-once retired (2026-10-24): run-all now retries surgically per FILE
      // (failed-file extraction + 30s settle); the outer whole-suite rerun only ever
      // fired on real reds and doubled the worst-case red time (8-26min x2).
      ['单元测试（run-all 自动发现,fail=0+skip棘轮,勿手写清单）', 'node', ['cli/check-test-summary.cjs', '--with-coverage'], null, 80],
      // D4 覆盖率棘轮(只升不降,回退即红);--await-summary 复用上一 stage 的 coverage 摘要,
      // 不再并发重跑全量单测(4vCPU CI 上双份套件并发=互相拖到超时红,2026-09-26 实锤)
      // Budget must EXCEED the unit stage's: it runs in a parallel lane and polls until the
      // summary lands (85 > 80; its own work is seconds once the summary exists).
      ['覆盖率棘轮（lines/branch/funcs 对比 cli/.coverage-baseline.json,通过时自动上调基线）', 'node', ['cli/check-coverage-ratchet.cjs', '--await-summary'], null, 85],
    ]
  },
  {
    // 2026-09-19: every ③ stage tuple carries an explicit named ceiling (5th element = minutes).
    // Previously the stages rode the 15min default with no per-stage budget — a hung live stage got
    // SIGKILLed mid-pool and read as "killed at job timeout with zero diagnostics". A named 20min
    // ceiling per live stage (mirrors the unit-test pool's `, 30` fix) turns a hang into a red with
    // a budget label instead of a silent external kill.
    name: '③ Electron 活体（并行 3 路,各自独立端口+隔离 userData;失败重试1次抗负载抖动）', parallel: 3, retry: 1,
    stages: [
      ['UI 集成测试（自拉起 Electron 隔离实例）', 'node', ['tests/integration-ui.test.mjs'], 20],
      ['更新链路活体（dev降级/downloadUpdate守卫/开关默认/红点badge;真下载须公开仓后rc实测）', 'node', ['tests/integration-updater-ui.mjs'], 20],
      ['UI 交互冒烟（真实鼠标输入链,自拉起实例;562261c pointer capture 吞 click 事件防线）', 'node', ['tests/run-interactions-gated.mjs'], 20],
      // 2026-10-23 speed wave: the six run-interactions-gated lanes (ui-smoke / e2e / keyboard-e2e /
      // cssom-integrity / ui-coverage / overlay-visibility) each booted a PRIVATE Electron instance —
      // 6 boots + up to 6 concurrent instances per full gate. tests/run-interactions-shared.mjs boots
      // ONE isolated instance and runs the targets SEQUENTIALLY against it (per-target isolation =
      // emulation-clear + page reload, NOT an app restart). Failure isolation is preserved per target:
      // a red target never reds its siblings; a target that kills the shared instance reds only itself
      // and the instance is respawned exactly once for the rest.
      // 2026-10-27 (W12): the pool grew 6 -> 9 targets (the three core-journey E2E regressions,
      // tests/e2e-journeys/) but the stage ceiling stayed at the 6-target budget — nominal worst
      // case 9 × 8min per-target budget + reset/boot overhead ≈ 85min vs the old 50min ceiling,
      // so a legitimately slow (not hung) run got SIGKILLed mid-pool with zero per-target verdicts.
      // Ceiling raised to 85 and the label/comment updated to 9门.
      ['UI 交互池（9门共享1实例:ui-smoke/e2e/键盘/cssom/覆盖走查/遮挡/旅程×3;逐目标独立裁决+单次实例重生）', 'node', ['tests/run-interactions-shared.mjs'], 85],
      ['CLI 冒烟', 'node', ['cli/cli-smoke.js'], 20],
    ]
  },
  {
    // 2026-09-07 四路审查:视觉门禁此前完全游离 check:all 外——删单条 SFC 规则无任何门禁可抓
    // (cssom 95% 容差放行 77 条内的丢失,其余门禁只扫存在的规则)。--spawn 自拉起 5175 宿主,无外部依赖。
    name: '④ Web 视觉回归（14 场景×深浅,0.4% pixelmatch;自拉起 5175 宿主）', parallel: 1, retry: 1,
    stages: [
      // 第 5 元=超时分钟覆盖:视觉组带场景重试+浏览器逐场景重启,30 分钟预算(2026-09-09 曾撞 15min 默认超时按红计;满载重试实测 22-40min)
      ['Web 视觉回归（14 场景深浅对照,防"删规则/改样式无门禁可抓"——漂移根因已修:shim 番茄锚昨天）', 'node', ['scripts/visual-web.mjs', '--spawn', '--port=6175'], null, 30],
    ]
  },
  
]
if (WITH_A11Y) GROUPS.push({
  name: '⑤ a11y（活应用实测）', parallel: 1,
  stages: [['a11y 实测(axe)', 'node', ['cli/a11y-scan.js']]]
})

const T0 = Date.now()
const fmtMs = ms => ms >= 60000 ? `${(ms / 60000).toFixed(1)}min` : `${(ms / 1000).toFixed(0)}s`

// 单阶段执行:异步 spawn + 硬超时(默认 15 分钟,挂死=红,不阻塞其他并行阶段;门禁元组第 5 位可覆盖分钟数)
function runStage (stage) {
  const [name, cmd, args, extraEnv, timeoutMin] = stage
  return new Promise(resolve => {
    const t0 = Date.now()
    // Windows cmd.exe cannot use a UNC current working directory: shell:true
    // previously redirected every gate to C:\\Windows (24 false failures).
    // npm.cmd is a shell shim; invoke its JS CLI with Node instead.
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    const binary = cmd === 'npm' && process.platform === 'win32' ? process.execPath : cmd
    const argv = cmd === 'npm' && process.platform === 'win32' ? [npmCli, ...args] : args
    const child = spawn(binary, argv, {
      cwd: ROOT, encoding: 'utf8',
      shell: false,
      env: { ...process.env, ...(extraEnv || {}) },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    // D4: registry write at spawn (command-line fragments = the reaper's kill permit), prune on close.
    if (child.pid) {
      const frags = [path.basename(String(binary))]
      for (const a of (Array.isArray(argv) ? argv : [])) if (a && !String(a).startsWith('-')) frags.push(String(a))
      registerChild(child.pid, { match: frags.slice(0, 4), purpose: `check-all stage: ${name}` })
    }
    let out = ''
    const CAP = 16 * 1024 * 1024 // 尾部 25 行足够,但保留较大环形缓冲防大输出丢关键信息
    child.stdout.on('data', d => { out = (out + d).slice(-CAP) })
    child.stderr.on('data', d => { out = (out + d).slice(-CAP) })
    const timer = setTimeout(() => {
      // win32: child 是 shell 包装进程,可能先退 handing off 孙进程——树杀 + 按特征端口补杀双保险
      // (2026-09-09 实锤:仅杀包装 pid 时孤儿 visual-web 永挂,'close' 永不触发,整池卡死)
      if (process.platform === 'win32') {
        try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: true, stdio: 'ignore' }) } catch {}
        try {
          // M-13 (2026-09-20): this file is ESM — the inline `require('node:child_process')` +
          // execSync here crashed the whole fallback with "require is not defined", so orphaned
          // visual-web listeners were never reaped. spawnSync is imported statically at the top;
          // the pid parsing lives in cli/event-utils.cjs (unit-tested).
          // 2026-09-25: reap the stage's ACTUAL port, not the historical 5175 — the visual stage
          // now spawns on --port=6175 (WinNAT excluded-range dodge), so a timed-out run's orphaned
          // vite on 6175 survived this reaper and poisoned the next run's host preflight.
          const mPort = (Array.isArray(args) ? args.join(' ') : '').match(/--port=(\d+)/)
          const reapPorts = mPort ? [mPort[1]] : ['5175', '6175']
          for (const p of reapPorts) {
            const r = spawnSync('netstat -ano | findstr :' + p + ' | findstr LISTENING', { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
            for (const pid of evtUtils.pidsFromNetstatOutput(r.stdout || '')) {
              try { spawn('taskkill', ['/pid', pid, '/T', '/F'], { shell: true, stdio: 'ignore' }) } catch {}
            }
          }
        } catch { /* 端口本就空闲 */ }
      }
      try { child.kill('SIGKILL') } catch {}
    }, (timeoutMin || 15) * 60 * 1000)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (child.pid) unregisterChild(child.pid)
      const timedOut = signal === 'SIGKILL'
      resolve({ name, ok: code === 0 && !timedOut, timedOut, out, ms: Date.now() - t0, budget: timeoutMin || 15 })
    })
  })
}

// ── flake 事件度量(2026-09-25 D2 效率波):runPool 重试通过的 stage 此前与一次通过同形、不落盘,
// 活体池抖动率无从观测。重试通过即记一条事件(stage/attempt/首跑与重试耗时),结束后落盘 JSON
// (tests/.artifacts/flake-events.json)并在汇总表打 ⚑ 标;单次 check:all 重试通过 stage 数 >2
// 触发黄标警告(可执行门禁的观测面,不红——先观察 retry 触发率再谈收紧)。导出为纯函数供单测。
const FLAKE_EVENTS = []
export function resetFlakeEvents () { FLAKE_EVENTS.length = 0 }
export function getFlakeEvents () { return FLAKE_EVENTS }
export function evaluateFlakeThreshold (events, max = 2) {
  return { count: events.length, max, level: events.length > max ? 'warn' : 'ok' }
}
export function writeFlakeEvents (events, dir, extra = {}) {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'flake-events.json')
  fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), flakeCount: events.length, events, ...extra }, null, 2))
  return file
}

// 并行池:并发上限 N,完成一个补一个,保持机器不被 Electron 实例打满
// opts.workerGate(i):第 i 个 worker 起跑前须先 await 的 gate(CI 流水线重叠用——第 2 条活体车道
// 等静态池收尾才放行);opts.onLastStage:最后一个 stage 被 worker 领走时回调一次(静态池降到最后
// 1 个 stage 时提前放行第 1 条活体车道)
async function runPool (stages, limit, { retry = 0, onLastStage, workerGate, silent = false } = {}) {
  const results = new Array(stages.length)
  let next = 0
  let tailCb = onLastStage
  // 车道 gate 的"排空兜底":最后一个 stage 被领走即放行所有仍在等 gate 的车道直接收工——
  // 否则一条永不 resolve 的 gate 会把整池挂死(worker 的 await 永不返回,Promise.all 卡死)
  let drainedRes = null
  const drained = new Promise(res => { drainedRes = res })
  // silent:true 供单测导入使用——node --test 的子进程以 stdout 承载 runner 序列化协议帧,
  // 本池的原生 process.stdout.write/console.log 直写会随机插进帧中间,父端反序列化即炸
  // ('Unable to deserialize cloned data',2026-09-25 对抗复审实测 15 跑 4 红);静默跑法零直写
  const sayRaw = silent ? () => {} : s => process.stdout.write(s)
  const say = silent ? () => {} : (...a) => console.log(...a)
  async function worker (idx) {
    let gateOpen = !workerGate
    while (next < stages.length) {
      if (!gateOpen) {
        const verdict = await Promise.race([
          workerGate(idx).then(() => 'go'),
          drained.then(() => 'drained')
        ])
        if (verdict === 'drained') return // 池已排空,这条被 gate 压住的车道无活可干
        gateOpen = true
      }
      const i = next++
      if (next === stages.length && drainedRes) { const res = drainedRes; drainedRes = null; res() }
      if (tailCb && next === stages.length) { const cb = tailCb; tailCb = null; cb() }
      sayRaw(`  ▶ [${i + 1}/${stages.length}] ${stages[i][0]} ... 启动\n`)
      results[i] = await runStage(stages[i])
      // 活体门禁在 3 车道并行负载下存在时序脆弱点(实测:更新链路单跑全绿,并行偶发红)——失败重试一次,
      // 仍然红才是真回归;重试通过会累计耗时,便于区分稳定绿与抖动绿
      for (let t = 0; t < retry && !results[i].ok; t++) {
        say(`  ↻ [${i + 1}/${stages.length}] ${stages[i][0]} 失败,重试 ${t + 1}/${retry} ...`)
        const r2 = await runStage(stages[i])
        if (r2.ok) {
          r2.ms += results[i].ms
          FLAKE_EVENTS.push({ stage: stages[i][0], attempt: t + 2, firstRunMs: results[i].ms, retryMs: r2.ms - results[i].ms })
        }
        results[i] = r2
      }
      const r = results[i]
      say(`  ${r.ok ? '✓' : '✗'} [${i + 1}/${stages.length}] ${r.name} — ${fmtMs(r.ms)}${r.timedOut ? `（超时 ${r.budget} 分钟按红计）` : ''}`)
      if (!r.ok && r.out.trim()) {
        say(r.out.trim().split('\n').slice(-25).map(l => '    ' + l).join('\n'))
        // tail 25 行常吞掉 node:test 的 "not ok N - <name>"（失败名在输出中段），单独抽失败用例行
        const diag = r.out.split('\n').filter(l => /✖|not ok \d|AssertionError|FAIL:|✗ /.test(l)).slice(0, 20)
        if (diag.length) say('  [diag] failing cases:\n' + diag.map(l => '    ' + l.trim().slice(0, 150)).join('\n'))
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, stages.length) }, (_, idx) => worker(idx)))
  return results
}

export { runPool, GROUPS }

async function main () {
const results = []
// D4 exit-handler reap: normal runs prune each entry at 'close', so this is a no-op on a
// clean exit; on a crash/throw/hard-signal path the still-registered stage children get
// tree-killed here (command-line-verified, sync) instead of surviving as orphans.
// Registered inside main() only — importing modules (the flake-metrics unit test) must not
// grow process-level side effects.
process.on('exit', () => { try { reapAllRegisteredSync() } catch { /* best-effort by contract */ } })
// Ambient-load label (2026-10-23 S4): pure diagnostics, never blocks. A loaded host inflates
// every timing 2-3x — a red landing exactly on a stage budget is a KILL, not a product
// failure, and timing flakes multiply (2026-10-22/23 evidence). Sampling once over 300ms via
// os.cpus() deltas (os.loadavg is a stub on Windows).
// 2026-10-23 architecture: the sample is now also a GATE INPUT — under burst the FRAGILE
// pools (③ live Electron, ④ visual) are deferred LOUDLY (exit 3, named) instead of running
// as a dice roll; --force-load overrides (release officers only). IMMUNE pools (① static,
// ② unit at conc 4) run everywhere, every time.
let ambientPct = -1
try {
  const c0 = os.cpus()
  await new Promise(res => setTimeout(res, 300))
  const c1 = os.cpus()
  let busy = 0
  let total = 0
  for (let i = 0; i < c1.length; i++) {
    const d = c1[i].times
    const p = c0[i]?.times || { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 }
    busy += (d.user - p.user) + (d.nice - p.nice) + (d.sys - p.sys) + (d.irq - p.irq)
    total += busy + (d.idle - p.idle)
  }
  ambientPct = total > 0 ? Math.round(busy / total * 100) : 0
  if (ambientPct >= 80) {
    console.warn(`  [check-all] ⚠ ambient CPU load ~${ambientPct}% — timings inflated 2-3x under this load; a red landing exactly on a stage budget is a budget KILL (re-run in a quiet window before triaging it as product red)`)
  } else {
    console.log(`  [check-all] ambient CPU load ~${ambientPct}% (within normal band)`)
  }
} catch { /* diagnostics only — never block the gate on its own label */ }
// CI detection hoisted here (was below, after the build stage): the gate
// doctor's scope decision needs it BEFORE the build, and redeclaring it at
// its old site would be a SyntaxError.
const ON_CI = !!(process.env.CI || process.env.GITHUB_ACTIONS)
// Gate doctor (2026-10-23 architecture): declared environment needs validated + auto-
// provisioned BEFORE any pool starts. Scope: fast tier = structural only; local full gate
// = + visual-lane machine-state (browser-dev deps, baselines, agent-browser). CI skips the
// visual lane by design, so its needs are not blocking there. --no-doctor for emergencies;
// a blocking miss exits 2 with the named fix — a 5-second preflight instead of a mid-gate
// mystery red (2026-10-23: five-layer checkout-env onion, each layer misattributed once).
if (!process.argv.includes('--no-doctor')) {
  const { runDoctor } = await import('./gate-doctor.cjs')
  const doctorScope = (!FAST && !ON_CI) ? 'full-local' : 'structural'
  const doctor = await runDoctor({ scope: doctorScope, fix: true, silentBanner: false })
  if (!doctor.ok) process.exit(2)
}
// Burst deferral (load-tier policy): FRAGILE pools under ≥80% ambient load are DEFERRED,
// never silently skipped and never dice-rolled. Exit code 3 = "validated partially" —
// distinct from 0 (all green) and 1 (red): CI/pre-commit semantics unchanged (they run
// --fast or scoped tiers, which never defer); the nightly quiet-window job runs the FULL
// set because its load sits below the threshold. --force-load is the release-officer
// override and prints its own loud banner.
const FORCE_LOAD = process.argv.includes('--force-load')
const LOAD_DEFER_THRESHOLD = 80
const deferred = []
function deferGroup (g, reason) {
  for (const st of g.stages) deferred.push(st[0])
  console.log(`\n===== ${g.name} —— ⏸ DEFERRED (${reason};安静窗跑全量,或 --force-load 强制) =====`)
}
// ① 构建先行（产物依赖,唯一硬串行;构建失败后续全无意义,直接短路）——fast 档纯静态,无产物依赖,跳过
if (FAST) {
  console.log('\n[check:fast] 跳过 ①构建（静态门禁不依赖 renderer-dist）')
} else {
  console.log(`\n===== ${GROUPS[0].name} =====`)
  const buildRs = await runPool(GROUPS[0].stages, 1)
  results.push(...buildRs)
  if (buildRs.some(r => !r.ok)) {
    console.error('\n✗ 构建失败,后续门禁全部短路(产物缺失跑了也是假象)')
    process.exit(1)
  }
}
// ②③ 构建完成后同时起跑:静态池(纯文件分析/类型/单测)与 Electron 活体池互不依赖,
// 只有 CPU 竞争——两池各自限道(3+3)避免把机器打满;更新链路类时序敏感阶段靠重试1次兜底
// CI 自适应降道:GitHub windows runner 仅 4 vCPU,3+3 车道会挤爆多 Electron 实例+单测池
// (2026-09-06 首次公开 CI 实锤:本地全绿、CI 6 项全红且全是自拉起实例门禁)。CI=静态 2 道+活体 1 道且两池不并发
// (ON_CI hoisted above the gate doctor — it is needed before the build stage)
// CHECK_ALL_SKIP_LIVE=1: 跳过③活体池(双 OS 分工——ubuntu runner 靠 xvfb 拉 Electron 最慢,
// 让它只跑静态池+单测,活体全量由 windows job 独扛;墙钟取 max 而非两 OS 各跑全套)
const SKIP_LIVE = process.env.CHECK_ALL_SKIP_LIVE === '1'
if (SKIP_LIVE && !ON_CI) console.warn('  [warn] 本地环境忽略 CHECK_ALL_SKIP_LIVE——活体池只在 CI 的双 OS 分工下跳过(红队 G1:防该 env 未来被误用成本地静默降级开关)')
if (FAST) {
  // Fast tier runs the CORE test tier: the deep suites (live-Electron e2e, two-instance
  // lan-sync journeys, loopback drills) are the wall-time dominators AND the load-sensitive
  // flake surface — under a loaded dev host they cascade into contention-artifact reds
  // (2026-10-22 fast unit run: 12 of 17 not-ok entries, each green in isolation). CI and the
  // full check:all keep the FULL pool. The coverage ratchet stage is also skipped here: its
  // baseline is calibrated on the full pool, a core-pool percentage is a different instrument
  // (compare-only at the ratchet), and coverage discipline stays enforced by the merge gate.
  const fastStages = GROUPS[1].stages
    .filter(([name]) => !name.startsWith('覆盖率棘轮'))
    .map(([name, cmd, args, env, budget]) =>
      (name.startsWith('单元测试') ? [name, cmd, [...(args || []), '--core'], env, budget] : [name, cmd, args, env, budget]))
  console.log('\n===== [check:fast] 静态门禁+类型+core 层单元（深潜层套件与覆盖棘轮归全量 check:all） =====')
  results.push(...await runPool(fastStages, GROUPS[1].parallel, { retry: GROUPS[1].retry || 0 }))
} else if (ON_CI) {
  if (SKIP_LIVE) {
    console.log('\n===== [CI 模式+SKIP_LIVE] 只跑静态池(2 道),活体池由另一 OS job 独扛 =====')
    results.push(...await runPool(GROUPS[1].stages, 2))
  } else {
    // 2026-09-25 D2 效率波:CI 两池不再纯顺序。①活体池 1→2 车道——活体开跑时静态池已结束、
    // 机器空闲,'4 vCPU 挤爆'论证只针对两池并发场景(run 36123046333 口径活体 10 阶段串行 ~350s,
    // 2 车道理论省 ~2.2min);②静态池降到最后 1 个 stage 时(workerGate/onLastStage 流水线钩子)
    // 提前起第 1 条活体车道,静态池整体收尾后第 2 条车道放行——活体只依赖①构建产物,与静态池
    // 无产物依赖,按 run 36123046333 时间线再省 ~4.2min。retry:1 兜底保留(与单测尾段并发有
    // 抖动风险,flake 事件度量见 runPool——重试通过会落盘 flake-events.json 供观测)。
    console.log('\n===== [CI 模式] 静态池(2 道)尾段与活体池流水线重叠;静态收尾后活体升 2 道 =====')
    let fireTail = null
    const staticTailStarted = new Promise(res => { fireTail = res })
    const staticRsP = runPool(GROUPS[1].stages, 2, {
      onLastStage: () => {
        console.log('  ⇄ 静态池进入尾段(最后 1 个 stage),提前放行第 1 条活体车道')
        fireTail()
      }
    })
    const liveRs = await runPool(GROUPS[2].stages, 2, {
      retry: 1,
      workerGate: i => (i === 0 ? staticTailStarted : staticRsP)
    })
    results.push(...await staticRsP, ...liveRs)
  }
} else {
  // 2026-09-21: 视觉池(④)并入同一波——它自拉起 6175 端口宿主(--strictPort,与活体池随机
  // CDP 端口+独立 userData 互不相干),此前排在整个 ③ 池之后纯串行,是墙钟最大的一块空闲串行段。
  // 代价是满载更高(dbMirror/5000-task/走查等时序敏感门禁有 retry 1 兜底;若实测抖动恶化再降道)。
  // 2026-10-23 burst deferral: ≥80% ambient 响亮顺延 ③④ 池(exit 3),掷骰子红从结构上退场。
  const burst = ambientPct >= LOAD_DEFER_THRESHOLD && !FORCE_LOAD && !ON_CI
  if (burst) {
    console.warn(`  [check-all] ⏸ ambient load ~${ambientPct}% ≥ ${LOAD_DEFER_THRESHOLD}%:FRAGILE 池(③活体/④视觉)顺延至安静窗(--force-load 可强制)`)
    deferGroup(GROUPS[2], `ambient ${ambientPct}%`)
    deferGroup(GROUPS[3], `ambient ${ambientPct}%`)
    results.push(...await runPool(GROUPS[1].stages, GROUPS[1].parallel, { retry: GROUPS[1].retry || 0 }))
  } else {
    if (FORCE_LOAD && ambientPct >= LOAD_DEFER_THRESHOLD) console.warn('  [check-all] --force-load:burst 期强制全量(红一律按真回归分诊,预算 KILL 自担)')
    console.log(`\n===== ${GROUPS[1].name} × ${GROUPS[2].name} × ${GROUPS[3].name}（三池同时起跑） =====`)
    const [staticRs, liveRs, visualRs] = await Promise.all([
      runPool(GROUPS[1].stages, GROUPS[1].parallel, { retry: GROUPS[1].retry || 0 }),
      runPool(GROUPS[2].stages, LANES, { retry: GROUPS[2].retry || 0 }),
      runPool(GROUPS[3].stages, GROUPS[3].parallel, { retry: GROUPS[3].retry || 0 })
    ])
    results.push(...staticRs, ...liveRs, ...visualRs)
  }
}
for (const g of GROUPS.slice(FAST ? GROUPS.length : 4)) {
  // 视觉回归(第4组)是本机门禁:基线为 gitignored 的机器本地文件,且依赖 agent-browser——
  // CI 裸机上必然 14 场景全 MISSING-BASELINE,不得入 CI;本地 check:all 照常护航
  if (ON_CI && /视觉/.test(g.name)) {
    console.log(`\n===== ${g.name} —— CI 跳过(机器本地基线+agent-browser 依赖;视觉护航在开发者本机执行) =====`)
    continue
  }
  console.log(`\n===== ${g.name} =====`)
  const rs = await runPool(g.stages, g.parallel, { retry: g.retry || 0 })
  results.push(...rs)
}

console.log('\n========== 体检汇总（按耗时降序） ==========')
const flakeNames = new Set(FLAKE_EVENTS.map(e => e.stage))
for (const r of [...results].sort((a, b) => b.ms - a.ms)) console.log(` ${r.ok ? '✓' : '✗'} ${fmtMs(r.ms).padStart(7)}  ${r.name}${flakeNames.has(r.name) ? '  ⚑flake(重试通过)' : ''}`)
if (deferred.length) for (const n of deferred) console.log(` ⏸   DEFER  ${n}（顺延至安静窗;非失败,不参与红绿判定）`)
const failed = results.filter(r => !r.ok)
const total = Date.now() - T0
console.log(`\n${failed.length ? `✗ ${failed.length} 项失败: ${failed.map(f => f.name).join(' / ')}` : deferred.length ? `⏸ 全部已跑项通过 + ${deferred.length} 项顺延（部分验证,exit 3;安静窗跑全量补钢印）` : '✓ 全部通过'}（共 ${results.length} 项+顺延 ${deferred.length} 项,总耗时 ${fmtMs(total)},flake 重试通过 ${FLAKE_EVENTS.length} 条）`)
// flake 事件落盘:重试通过 stage 此前与一次通过同形,抖动率无从观测(D2 效率波新增)
if (FLAKE_EVENTS.length) {
  try {
    const file = writeFlakeEvents(FLAKE_EVENTS, path.join(ROOT, 'tests', '.artifacts'), { totalStages: results.length, totalMs: total })
    console.log(`flake 事件已落盘: ${file}`)
  } catch (e) { console.warn(`  [warn] flake-events.json 写入失败: ${e.message}`) }
}
const flakeVerdict = evaluateFlakeThreshold(FLAKE_EVENTS)
if (flakeVerdict.level === 'warn') console.log(`⚠ [flake-gate] 单次 check:all 重试通过 stage 数 ${flakeVerdict.count} > 阈值 ${flakeVerdict.max} —— 活体池抖动超标,黄标警告(不红;连续超标再考虑降道/修时序)`)
if (!WITH_A11Y) console.log('提示: a11y 实测需活应用,加 --a11y 追加(cli/a11y-scan.js)')
// Exit contract: 0 = all ran green; 1 = red (real regression or budget kill);
// 3 = validated PARTIALLY (burst deferral — never a silent green). CI and
// pre-commit run --fast/scoped tiers which never defer, so their contract is
// untouched; the nightly quiet-window job runs full and never hits the burst
// branch.
process.exit(failed.length ? 1 : deferred.length ? 3 : 0)
}

// 仅直接执行时跑主流程;被单测 import 时只暴露 runPool/flake 纯函数(tests/unit/cli/check-all-flake-metrics.test.mjs)
const AS_MAIN = (() => {
  const a = String(process.argv[1] || '')
  return a.replace(/\\/g, '/').toLowerCase().endsWith('/check-all.js') ||
    (() => { try { return pathToFileURL(a).href === import.meta.url } catch { return false } })()
})()
if (AS_MAIN) await main()
