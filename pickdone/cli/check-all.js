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
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import evtUtils from './event-utils.cjs'

const WITH_A11Y = process.argv.includes('--a11y')
const FAST = process.argv.includes('--fast')
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
      ['CSS 冻结(全局沉积文件只删不增,组件吸收重构护栏)', 'node', ['cli/check-css-freeze.mjs']],
      ['缓存戳纪律(?v= 未 bump=已装用户永拿旧缓存,2026-09-05 三笔连漏实锤后立门禁)', 'node', ['cli/check-cache-stamp.js']],
      ['提交身份(HEAD邮箱不得携带个人身份——QQ邮箱上公开仓实锤,SOP-02 §7)', 'node', ['cli/check-commit-identity.js']],
      ['变更操作反馈一致性（完成/删除/移动必须过撤销或确认出口,白名单制）', 'node', ['cli/check-op-feedback.js']],
      ['IPC op 覆盖（渲染端调用面⊆白名单⊆db.OPS,防功能静默全断）', 'node', ['cli/check-ipc-op-coverage.cjs']],
      ['命令总线单写门（渲染端写形 dbCall 直连=0,manifest↔db.OPS/白名单互查,refactor-command-bus P1）', 'node', ['cli/check-command-bus.cjs']],
      ['双写台账（渲染端每个 localStorage 写点须声明权威源,防 LS 镜像与 DB 漂移——CLI/UI 联动 bug 根治防线）', 'node', ['cli/check-dualwrite.cjs']],
      ['ESM 模块图（import/export 匹配——白屏级事故在门禁拦截）', 'node', ['cli/check-esm-graph.cjs']],
      ['i18n 全量', 'node', ['cli/check-i18n.js', '--all']],
      ['i18n 体系（缺失/占位符/双形态/异值/主进程）', 'node', ['renderer/js/i18n/check-i18n.mjs']],
      ['媒体语言配对（英文侧媒体必须 en 标记命名——中文界面 gif 曾混入英文 README 实锤,SOP-05 §5）', 'node', ['cli/check-media-lang.js']],
      ['hover 对比度（悬浮文字隐形/白字被改写,含负向自测）', 'node', ['cli/check-hover-contrast.cjs'], { HOVER_CONTRAST_SELFTEST: '1' }],
      ['scheduler 修复回归（firedReminders LRU+持久化+二次 fire 防退化）', 'node', ['cli/check-scheduler-lru.mjs']],
      // 直接用 node 起 eslint bin：npx 在部分环境（bash 无 npm 全局 PATH）spawn ENOENT 被误判为门禁红（2026-09-04 实锤）
      // --cache:热跑只 lint 变更文件,2.2min→秒级(缓存文件 .eslintcache 已 gitignore)
      ['ESLint', 'node', ['node_modules/eslint/bin/eslint.js', 'renderer/js', 'cli', 'src', 'tests', '--quiet', '--cache']],
      ['vue-tsc 类型检查(SFC script lang=ts + 全局契约)', 'npm', ['run', 'typecheck']],
      // 经 check-test-summary.cjs 跑同一套 fail=0 + skip 棘轮校验(与 pre-commit 单一实现,防两处分叉)
      ['单元测试（run-all 自动发现,fail=0+skip棘轮,勿手写清单）', 'node', ['cli/check-test-summary.cjs'], null, 30],
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
      ['UI 冒烟回归（假绿清剿后纳入门禁——游离门禁外的脚本必然腐烂,2026-09-01 实锤:标题冻结/引导遮罩吞点击均在门禁外烂了数日）', 'node', ['tests/run-interactions-gated.mjs', 'tests/ui-smoke.mjs'], 20],
      ['端到端用户流（自拉起实例;看门狗超时=红;浮窗 target 排除）', 'node', ['tests/run-interactions-gated.mjs', 'tests/e2e.test.mjs'], 20],
      ['键盘端到端（真实按键事件,自拉起实例）', 'node', ['tests/run-interactions-gated.mjs', 'tests/keyboard-e2e.mjs'], 20],
      ['CSSOM 完整性（规则数对照入库基线,防静默吞规则——两次实锤后立门禁）', 'node', ['tests/run-interactions-gated.mjs', 'tests/cssom-integrity.mjs'], 20],
      ['全功能覆盖走查（用户可达面业务语义:搜索/达成/标签/视图/回收站/重复/设置生效/习惯/项目/空态/账目）', 'node', ['tests/run-interactions-gated.mjs', 'tests/ui-coverage.mjs'], 20],
      // 2026-09-13 从单测池挪入:活体测试不得进 pre-commit(pre-commit 须零环境依赖,不被 5175 宿主实时状态劫持)
      ['视口/遮挡活体（最小视口不可见遮挡+confirm 命中,自拉起实例;leftover-ask 弹窗回归）', 'node', ['tests/run-interactions-gated.mjs', 'tests/integration/overlay-visibility.test.mjs'], 20],
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
    const child = spawn(cmd, args, {
      cwd: ROOT, encoding: 'utf8',
      shell: process.platform === 'win32',
      env: { ...process.env, ...(extraEnv || {}) },
      stdio: ['ignore', 'pipe', 'pipe']
    })
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
      const timedOut = signal === 'SIGKILL'
      resolve({ name, ok: code === 0 && !timedOut, timedOut, out, ms: Date.now() - t0, budget: timeoutMin || 15 })
    })
  })
}

// 并行池:并发上限 N,完成一个补一个,保持机器不被 Electron 实例打满
async function runPool (stages, limit, { retry = 0 } = {}) {
  const results = new Array(stages.length)
  let next = 0
  async function worker () {
    while (next < stages.length) {
      const i = next++
      process.stdout.write(`  ▶ [${i + 1}/${stages.length}] ${stages[i][0]} ... 启动\n`)
      results[i] = await runStage(stages[i])
      // 活体门禁在 3 车道并行负载下存在时序脆弱点(实测:更新链路单跑全绿,并行偶发红)——失败重试一次,
      // 仍然红才是真回归;重试通过会累计耗时,便于区分稳定绿与抖动绿
      for (let t = 0; t < retry && !results[i].ok; t++) {
        console.log(`  ↻ [${i + 1}/${stages.length}] ${stages[i][0]} 失败,重试 ${t + 1}/${retry} ...`)
        const r2 = await runStage(stages[i])
        if (r2.ok) r2.ms += results[i].ms
        results[i] = r2
      }
      const r = results[i]
      console.log(`  ${r.ok ? '✓' : '✗'} [${i + 1}/${stages.length}] ${r.name} — ${fmtMs(r.ms)}${r.timedOut ? `（超时 ${r.budget} 分钟按红计）` : ''}`)
      if (!r.ok && r.out.trim()) {
        console.log(r.out.trim().split('\n').slice(-25).map(l => '    ' + l).join('\n'))
        // tail 25 行常吞掉 node:test 的 "not ok N - <name>"（失败名在输出中段），单独抽失败用例行
        const diag = r.out.split('\n').filter(l => /✖|not ok \d|AssertionError|FAIL:|✗ /.test(l)).slice(0, 20)
        if (diag.length) console.log('  [diag] failing cases:\n' + diag.map(l => '    ' + l.trim().slice(0, 150)).join('\n'))
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, stages.length) }, worker))
  return results
}

const results = []
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
const ON_CI = !!(process.env.CI || process.env.GITHUB_ACTIONS)
// CHECK_ALL_SKIP_LIVE=1: 跳过③活体池(双 OS 分工——ubuntu runner 靠 xvfb 拉 Electron 最慢,
// 让它只跑静态池+单测,活体全量由 windows job 独扛;墙钟取 max 而非两 OS 各跑全套)
const SKIP_LIVE = process.env.CHECK_ALL_SKIP_LIVE === '1'
if (SKIP_LIVE && !ON_CI) console.warn('  [warn] 本地环境忽略 CHECK_ALL_SKIP_LIVE——活体池只在 CI 的双 OS 分工下跳过(红队 G1:防该 env 未来被误用成本地静默降级开关)')
if (FAST) {
  console.log('\n===== [check:fast] 只跑静态门禁+类型+单元（跳过 build/活体/视觉——CI 与发布仍走全量 check:all） =====')
  results.push(...await runPool(GROUPS[1].stages, GROUPS[1].parallel, { retry: GROUPS[1].retry || 0 }))
} else if (ON_CI) {
  if (SKIP_LIVE) {
    console.log('\n===== [CI 模式+SKIP_LIVE] 只跑静态池(2 道),活体池由另一 OS job 独扛 =====')
    results.push(...await runPool(GROUPS[1].stages, 2))
  } else {
    console.log('\n===== [CI 模式] 静态池(2 道)与 Electron 活体(1 道)顺序执行,不并发 =====')
    results.push(...await runPool(GROUPS[1].stages, 2))
    results.push(...await runPool(GROUPS[2].stages, 1, { retry: 1 }))
  }
} else {
  // 2026-09-21: 视觉池(④)并入同一波——它自拉起 6175 端口宿主(--strictPort,与活体池随机
  // CDP 端口+独立 userData 互不相干),此前排在整个 ③ 池之后纯串行,是墙钟最大的一块空闲串行段。
  // 代价是满载更高(dbMirror/5000-task/走查等时序敏感门禁有 retry 1 兜底;若实测抖动恶化再降道)。
  console.log(`\n===== ${GROUPS[1].name} × ${GROUPS[2].name} × ${GROUPS[3].name}（三池同时起跑） =====`)
  const [staticRs, liveRs, visualRs] = await Promise.all([
    runPool(GROUPS[1].stages, GROUPS[1].parallel, { retry: GROUPS[1].retry || 0 }),
    runPool(GROUPS[2].stages, LANES, { retry: GROUPS[2].retry || 0 }),
    runPool(GROUPS[3].stages, GROUPS[3].parallel, { retry: GROUPS[3].retry || 0 })
  ])
  results.push(...staticRs, ...liveRs, ...visualRs)
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
for (const r of [...results].sort((a, b) => b.ms - a.ms)) console.log(` ${r.ok ? '✓' : '✗'} ${fmtMs(r.ms).padStart(7)}  ${r.name}`)
const failed = results.filter(r => !r.ok)
const total = Date.now() - T0
console.log(`\n${failed.length ? `✗ ${failed.length} 项失败: ${failed.map(f => f.name).join(' / ')}` : '✓ 全部通过'}（共 ${results.length} 项,总耗时 ${fmtMs(total)}）`)
if (!WITH_A11Y) console.log('提示: a11y 实测需活应用,加 --a11y 追加(cli/a11y-scan.js)')
process.exit(failed.length ? 1 : 0)
