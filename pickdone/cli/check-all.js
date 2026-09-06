#!/usr/bin/env node
/**
 * Unified entry for all-dimension checks (SOP-00) — runs every automated check and summarizes the results
 * Usage: node cli/check-all.js [--a11y]
 *   --a11y: additionally runs the live axe scan (needs an app in CDP mode; not run by default, see cli/a11y-scan.js)
 * Any failure → non-zero exit; used as a one-shot full checkup before release/milestones.
 *
 * 执行模型(2026-09-06 效率专项:25 阶段纯串行 ~11min → 实测 5min 内,见提交 f9d60ac 及后续):
 *   ① build 先行(后续门禁依赖 renderer-dist 产物,唯一硬串行;失败即短路)
 *   ②③ build 完两池同时起跑:静态池(静态门禁+类型+单测,3 道,ESLint --cache 热跑秒级)
 *      与 Electron 活体池(3 道,各自独立随机端口+独立 mkdtemp userData 天然无共享;
 *      smoke 日志按脚本+pid 分文件;活体失败重试 1 次抗并行负载时序抖动)
 * 每阶段计时输出;总时长汇总。依赖关系只允许出现在"阶段内部",池间/池内全部并行。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WITH_A11Y = process.argv.includes('--a11y')
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const GROUPS = [
  {
    name: '① 构建先行（Electron 门禁依赖 renderer-dist 产物）', parallel: 1,
    stages: [
      ['Vite 渲染层构建(产物 renderer-dist,app:// 运行时形态)', 'npm', ['run', 'build:renderer']],
    ]
  },
  {
    name: '② 静态门禁+类型+单元（并行 3 道,与③池同时起跑;重试1次抗负载抖动）', parallel: 3, retry: 1,
    stages: [
      ['指纹脱敏', 'node', ['cli/check-fingerprint.js']],
      ['依赖许可证', 'node', ['cli/check-licenses.js']],
      ['token 纪律', 'node', ['cli/check-tokens.js']],
      ['缓存戳纪律(?v= 未 bump=已装用户永拿旧缓存,2026-09-05 三笔连漏实锤后立门禁)', 'node', ['cli/check-cache-stamp.js']],
      ['提交身份(HEAD邮箱不得携带个人身份——QQ邮箱上公开仓实锤,SOP-02 §7)', 'node', ['cli/check-commit-identity.js']],
      ['变更操作反馈一致性（完成/删除/移动必须过撤销或确认出口,白名单制）', 'node', ['cli/check-op-feedback.js']],
      ['IPC op 覆盖（渲染端调用面⊆白名单⊆db.OPS,防功能静默全断）', 'node', ['cli/check-ipc-op-coverage.cjs']],
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
      ['单元测试（run-all 自动发现，勿手写清单）', 'node', ['tests/run-all.mjs']],
    ]
  },
  {
    name: '③ Electron 活体（并行 3 路,各自独立端口+隔离 userData;失败重试1次抗负载抖动）', parallel: 3, retry: 1,
    stages: [
      ['UI 集成测试（自拉起 Electron 隔离实例）', 'node', ['tests/integration-ui.test.mjs']],
      ['更新链路活体（dev降级/downloadUpdate守卫/开关默认/红点badge;真下载须公开仓后rc实测）', 'node', ['tests/integration-updater-ui.mjs']],
      ['UI 交互冒烟（真实鼠标输入链,自拉起实例;562261c pointer capture 吞 click 事件防线）', 'node', ['tests/run-interactions-gated.mjs']],
      ['UI 冒烟回归（假绿清剿后纳入门禁——游离门禁外的脚本必然腐烂,2026-09-01 实锤:标题冻结/引导遮罩吞点击均在门禁外烂了数日）', 'node', ['tests/run-interactions-gated.mjs', 'tests/ui-smoke.mjs']],
      ['端到端用户流（自拉起实例;看门狗超时=红;浮窗 target 排除）', 'node', ['tests/run-interactions-gated.mjs', 'tests/e2e.test.mjs']],
      ['键盘端到端（真实按键事件,自拉起实例）', 'node', ['tests/run-interactions-gated.mjs', 'tests/keyboard-e2e.mjs']],
      ['CSSOM 完整性（规则数对照入库基线,防静默吞规则——两次实锤后立门禁）', 'node', ['tests/run-interactions-gated.mjs', 'tests/cssom-integrity.mjs']],
      ['全功能覆盖走查（用户可达面业务语义:搜索/达成/标签/视图/回收站/重复/设置生效/习惯/项目/空态/账目）', 'node', ['tests/run-interactions-gated.mjs', 'tests/ui-coverage.mjs']],
      ['CLI 冒烟', 'node', ['cli/cli-smoke.js']],
    ]
  },
]
if (WITH_A11Y) GROUPS.push({
  name: '⑤ a11y（活应用实测）', parallel: 1,
  stages: [['a11y 实测(axe)', 'node', ['cli/a11y-scan.js']]]
})

const T0 = Date.now()
const fmtMs = ms => ms >= 60000 ? `${(ms / 60000).toFixed(1)}min` : `${(ms / 1000).toFixed(0)}s`

// 单阶段执行:异步 spawn + 15 分钟硬超时(挂死=红,不阻塞其他并行阶段)
function runStage ([name, cmd, args, extraEnv]) {
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
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 15 * 60 * 1000)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const timedOut = signal === 'SIGKILL'
      resolve({ name, ok: code === 0 && !timedOut, timedOut, out, ms: Date.now() - t0 })
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
      console.log(`  ${r.ok ? '✓' : '✗'} [${i + 1}/${stages.length}] ${r.name} — ${fmtMs(r.ms)}${r.timedOut ? '（超时 15 分钟按红计）' : ''}`)
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
// ① 构建先行（产物依赖,唯一硬串行;构建失败后续全无意义,直接短路）
console.log(`\n===== ${GROUPS[0].name} =====`)
const buildRs = await runPool(GROUPS[0].stages, 1)
results.push(...buildRs)
if (buildRs.some(r => !r.ok)) {
  console.error('\n✗ 构建失败,后续门禁全部短路(产物缺失跑了也是假象)')
  process.exit(1)
}
// ②③ 构建完成后同时起跑:静态池(纯文件分析/类型/单测)与 Electron 活体池互不依赖,
// 只有 CPU 竞争——两池各自限道(3+3)避免把机器打满;更新链路类时序敏感阶段靠重试1次兜底
// CI 自适应降道:GitHub windows runner 仅 4 vCPU,3+3 车道会挤爆多 Electron 实例+单测池
// (2026-09-06 首次公开 CI 实锤:本地全绿、CI 6 项全红且全是自拉起实例门禁)。CI=静态 2 道+活体 1 道且两池不并发
const ON_CI = !!(process.env.CI || process.env.GITHUB_ACTIONS)
if (ON_CI) {
  console.log('\n===== [CI 模式] 静态池(2 道)与 Electron 活体(1 道)顺序执行,不并发 =====')
  results.push(...await runPool(GROUPS[1].stages, 2))
  results.push(...await runPool(GROUPS[2].stages, 1, { retry: 1 }))
} else {
  console.log(`\n===== ${GROUPS[1].name} × ${GROUPS[2].name}（两池同时起跑） =====`)
  const [staticRs, liveRs] = await Promise.all([
    runPool(GROUPS[1].stages, GROUPS[1].parallel),
    runPool(GROUPS[2].stages, GROUPS[2].parallel, { retry: GROUPS[2].retry || 0 })
  ])
  results.push(...staticRs, ...liveRs)
}
for (const g of GROUPS.slice(3)) {
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
