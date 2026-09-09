#!/usr/bin/env node
/**
 * Web-host visual regression — occlusion-proof variant of tests/visual-regression.mjs.
 * 夜间/锁屏时 Electron 窗口停止绘制,CaptureScreenshot 会挂死;本脚本改打 5175 浏览器调试宿主
 * (Vite + localStorage shim,数据确定),用 agent-browser 截图,pixelmatch 对比,阈值同 0.4%。
 * 用法:
 *   node scripts/visual-web.mjs --baseline   # 重拍基线(tests/.artifacts/visual-web/)
 *   node scripts/visual-web.mjs              # 对比,超阈值 exit 1
 * 前置: 5175 宿主已启动,且 agent-browser 在 PATH。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const MODE = process.argv.includes('--baseline') ? 'baseline' : 'check'
const SPAWN = process.argv.includes('--spawn') // check:all 模式:自拉起 5175 宿主(视觉门禁此前游离门禁外,删单条 SFC 规则无门禁可抓)
const THRESHOLD = Number(process.env.VISUAL_THRESHOLD || 0.004)
const DIR = path.join(ROOT, 'tests', '.artifacts', 'visual-web')
fs.mkdirSync(DIR, { recursive: true })
const BASE = 'http://127.0.0.1:5175'
const SESSION = 'vweb'
const STAMP = 'v' + Date.now()
// 冻结时刻(本地时区):宿主 index.html 的 ?pdFreeze 会把页面时钟钉死在此。
// 2026-09-09 实锤:种子/视图全按真实「今天」渲染,本地过午夜必红 6 图(today/calendar/statistics)。
// 定格后 today 高亮恒为 10:00 行、统计周窗恒为 09.07 起,基线跨真实日期不再漂移。
const FREEZE = '2026-09-09T10:05:00'

const ROUTES = [
  '#/todo-list/today', '#/todo-list/todo-box', '#/todo-list/calendar',
  '#/todo-list/completed', '#/todo-list/statistics', '#/todo-list/projects',
  '#/todo-list/recycle-bin'
]

import { execSync, spawn as cpSpawn } from 'node:child_process'
// agent-browser 偶发 ETIMEDOUT(浏览器实例跨 vite 重启后坏连接,实际命令已生效)——重试兜底,别让单点抖动掀翻整道门禁
const abOnce = (args) => execSync('agent-browser ' + args.map(a => JSON.stringify(a)).join(' '), { encoding: 'utf8', timeout: 120000, shell: true })
const ab = (args) => {
  let lastErr
  for (let i = 0; i < 2; i++) {
    try { return abOnce(args) } catch (e) {
      lastErr = e
      if ((e.stdout || '').includes('✓')) return e.stdout // 命令已生效,只是等回执超时
      execSync('sleep 3', { shell: true, stdio: 'ignore' })
    }
  }
  throw lastErr
}

// --spawn: 自拉起 5175 vite 宿主(独占门禁自身生命周期,结束即杀,不依赖外部常驻服务)
let viteChild = null
if (SPAWN) {
  // 端口独占:5175 被残留宿主占用时,新 vite 绑不上、脚本却探测到旧宿主"就绪",
  // 旧宿主一死整轮全崩(2026-09-09 实锤 14 连败)——spawn 模式先清场再拉起
  try {
    const out = execSync('netstat -ano | findstr :5175 | findstr LISTENING', { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
    for (const pid of [...new Set(out.split(/\r?\n/).map(l => l.trim().split(/\s+/).pop()).filter(p => /^\d+$/.test(p)))]) {
      execSync(`taskkill /pid ${pid} /T /F`, { shell: true, stdio: 'ignore' })
    }
    await new Promise(r => setTimeout(r, 1000))
  } catch { /* 端口空闲 */ }
  viteChild = cpSpawn('npm', ['run', 'dev'], { cwd: path.join(ROOT, 'browser-dev'), shell: true, stdio: 'ignore' })
  let up = false
  for (let t = 0; t < 40000 && !up; t += 500) {
    await new Promise(r => setTimeout(r, 500))
    try { if ((await fetch(BASE, { signal: AbortSignal.timeout(2000) })).ok) up = true } catch { /* retry */ }
  }
  if (!up) {
    console.error('✗ visual-web --spawn: 40s 内 5175 宿主未就绪(vite 启动失败?)')
    killVite()
    process.exit(2)
  }
}
function killVite () {
  if (!viteChild) return
  try { execSync(`taskkill /pid ${viteChild.pid} /T /F`, { shell: true, stdio: 'ignore' }) } catch { /* already gone */ }
  viteChild = null
}
process.on('exit', killVite)

// preflight (2026-09-07 review): crash-red mid-route-loop when 5175 is down or agent-browser missing;
// fail loudly BEFORE any scene runs, with actionable message instead of a cryptic eval error
try {
  execSync('agent-browser --version', { encoding: 'utf8', timeout: 30000, shell: true, stdio: 'pipe' })
} catch {
  console.error('✗ visual-web: agent-browser 不在 PATH —— 无法截图对比。安装/PATH 修复后重跑。')
  process.exit(2)
}
try {
  const res = await fetch(BASE, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error('HTTP ' + res.status)
} catch {
  console.error('✗ visual-web: 5175 宿主未启动 —— 加 --spawn 自拉起,或在 browser-dev/ 跑 `npm run dev`(vite --port 5175)再重跑。')
  killVite()
  process.exit(2)
}

const readBoot = () => ab(['--session', SESSION, 'eval', 'String(window.__pdBootId)']).trim().replace(/"/g, '')
async function setEnv (theme) {
  // theme 走 URL 参数(pdTheme),由宿主 head 脚本在应用启动前写 LS。此前是 eval 在上一个页面世界
  // 里改 LS 再 reload——旧世界的设置回写竞态覆盖成 light,前 4 个 dark 场景 100% 翻车(2026-09-09)。
  // seed=today re-injected per scene: shim tomatoes anchor to yesterday (deterministic all day);
  // pdFreeze pins the page clock so baselines stop drifting across real dates.
  const url = BASE + '/?' + STAMP + theme + '&seed=today&pdTheme=' + theme + '&pdFreeze=' + encodeURIComponent(FREEZE) + '#/todo-list/today'
  // agent-browser 的 open 偶发静默不导航(命令成功、页面没换,场景继承上一场景的主题/URL,
  // 2026-09-09 run B 12 连败实锤)——先去 about:blank 强制离场,再对「文档纪元已变化」逐环断言
  ab(['--session', SESSION, 'open', 'about:blank'])
  await new Promise(r => setTimeout(r, 500))
  let boot = ''
  for (let i = 0; i < 3 && (!boot || boot === 'undefined'); i++) {
    ab(['--session', SESSION, 'open', url])
    for (let t = 0; t < 15000; t += 400) {
      await new Promise(r => setTimeout(r, 400))
      try { boot = readBoot(); if (boot && boot !== 'undefined') break } catch (e) { /* retry */ }
    }
  }
  ab(['--session', SESSION, 'eval', `(() => { try { localStorage.setItem('appLocale', 'en-US'); localStorage.setItem('sidebarCollapsed', 'false'); localStorage.setItem('onboardingToursSeen', '1'); localStorage.setItem('onboardingDone', '1') } catch (e) {} const b = [...document.querySelectorAll('button')].find(x => ['Stay yesterday', '留在昨天', 'Skip', '稍后'].includes(x.textContent.trim())); if (b) b.click(); return 'ok' })()`])
  ab(['--session', SESSION, 'eval', `location.reload(); 'r'`])
  // reload 同样断言纪元变化(未变则重试一次)
  for (let i = 0; i < 2; i++) {
    let changed = false
    for (let t = 0; t < 8000; t += 400) {
      await new Promise(r => setTimeout(r, 400))
      try { if (readBoot() !== boot) { changed = true; break } } catch (e) { /* retry */ }
    }
    if (changed) break
    ab(['--session', SESSION, 'eval', `location.reload(); 'r'`])
  }
}

// 每 run 重置浏览器:标签页累积状态(undo 栈/store/会话守卫)会让后面的场景渐次劣化(2026-09-09 实锤:
// 连续第三轮 check 10/14 崩)——run 级隔离比场景内补丁更治本
const resetBrowser = () => { try { execSync('agent-browser close', { shell: true, stdio: 'ignore', timeout: 30000 }) } catch { /* 首次无实例 */ } }
resetBrowser()

async function runAll () {
  let fail = 0
  for (const route of ROUTES) {
    for (const theme of ['light', 'dark']) {
      const name = route.replace(/\//g, '_').replace(/^_/, '') + '-' + theme + '.png'
      const file = path.join(DIR, name)
    // 场景级重试:偶发一帧抖动/一次数据未及 hydrate,整个场景重来一次即可自愈
    let verdict = null // null=成功;字符串=最终失败原因
    for (let sceneAttempt = 0; sceneAttempt < 2 && !verdict; sceneAttempt++) {
      if (sceneAttempt > 0) console.log('↻ retry ' + name)
      await setEnv(theme)
      // wait for readiness: app mounted + theme applied (fixed sleeps race against vite cold transforms)
      // single-line expr: win32 shell:true routes through cmd.exe, embedded newlines break the quoted arg
      const readyExpr = `(() => { const themed = document.documentElement.getAttribute('data-theme') === '${theme}'; const mounted = !!document.querySelector('#app .side-nav'); const overlay = !!document.querySelector('vite-error-overlay'); return (themed && mounted && !overlay) ? 'ready' : 'wait' })()`
      let ready = ''
      for (let t = 0; t < 90000 && ready !== 'ready'; t += 500) {
        await new Promise(r => setTimeout(r, 500))
        try { ready = ab(['--session', SESSION, 'eval', readyExpr]).trim().replace(/"/g, '') } catch (e) { /* retry */ }
      }
      ab(['--session', SESSION, 'eval', `location.hash='${route}'; 'nav'`])
      // 等待场景沉降:同文档(__pdBootId 不变,免疫宿主种子/自愈的 reload 级联——2026-09-09 后半场
      // 曾截到刚重播种的 Today 启动帧)+ 主题 + 挂载 + hash 全部就位,且连续 8 次读数(≈4s)稳定:
      // 窗口短了会在任务数据 hydrate 完成前拍到「No events」空态帧(同日实锤)
      const settleExpr = `JSON.stringify((function(){ return { boot: window.__pdBootId || '?', themed: document.documentElement.getAttribute('data-theme') === '${theme}', mounted: !!document.querySelector('#app .side-nav'), hash: location.hash } })())`
      const readSettle = () => {
        const raw = ab(['--session', SESSION, 'eval', settleExpr]).trim()
        return JSON.parse(raw.replace(/^"|"$/g, '').replace(/\\"/g, '"').replace(/\\\\/g, '\\'))
      }
      let lastBoot = null
      let stable = 0
      for (let t = 0; t < 60000 && stable < 8; t += 500) {
        await new Promise(r => setTimeout(r, 500))
        try {
          const s = readSettle()
          if (s.boot !== lastBoot) { lastBoot = s.boot; stable = 0; ab(['--session', SESSION, 'eval', `location.hash='${route}'; 'renav'`]); continue }
          // hash 不对(启动期 router 未就绪会吞掉首次 hash 导航)必须主动补导航,不能只靠纪元变化触发
          if (s.hash !== route) { stable = 0; ab(['--session', SESSION, 'eval', `location.hash='${route}'; 'renav2'`]); continue }
          stable = (s.themed && s.mounted) ? stable + 1 : 0
        } catch (e) { stable = 0 }
      }
      // 稳定帧拍摄:合成器滞后帧会跨场景串台(2026-09-09 实锤:基线拍到上一场景的深色回收站)。
      // 连拍两帧 pixelmatch <0.05% 才采信;最多 5 轮。
      const shotPath = path.join(DIR, '.cur.png')
      let buf = null
      let prev = null
      for (let attempt = 0; attempt < 5 && !buf; attempt++) {
        try {
          ab(['--session', SESSION, 'screenshot', shotPath])
          const b = fs.readFileSync(shotPath)
          if (b.length > 10000) {
            if (prev) {
              const pa = PNG.sync.read(prev)
              const pb = PNG.sync.read(b)
              if (pa.width === pb.width && pa.height === pb.height) {
                const d = pixelmatch(pa.data, pb.data, null, pa.width, pa.height, { threshold: 0.1 })
                if (d / (pa.width * pa.height) < 0.0005) { buf = b; break }
              }
            }
            prev = b
          }
        } catch (e) { /* retry */ }
        await new Promise(r => setTimeout(r, 1200))
      }
      if (!buf) {
        if (sceneAttempt > 0) verdict = '(no stable frame under load)'
        else console.log('↻ ' + name + ' no stable frame — retry scene')
        continue
      }
      if (MODE === 'baseline') {
        fs.writeFileSync(file, buf)
        console.log('baseline ' + name)
        break
      }
      if (!fs.existsSync(file)) { console.log('MISSING-BASELINE ' + name); verdict = 'missing-baseline'; break }
      const a = PNG.sync.read(fs.readFileSync(file))
      const b = PNG.sync.read(buf)
      if (a.width !== b.width || a.height !== b.height) {
        console.log('FAIL ' + name + ` size ${a.width}x${a.height} -> ${b.width}x${b.height}`)
        if (sceneAttempt > 0) verdict = 'size-mismatch'
        continue
      }
      const diff = pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.1 })
      const ratio = diff / (a.width * a.height)
      const ok = ratio <= THRESHOLD
      // 诊断:截图时刻的主题属性 + dark 样式表是否真挂上(区分属性层/CSS 层翻车)
      let seen = 'eval-err'
      try {
        seen = ab(['--session', SESSION, 'eval', `(() => { const t = document.documentElement.getAttribute('data-theme'); const l = document.querySelector('link[href*="theme-dark"]'); return 'theme=' + t + '|darkRules=' + (l && l.sheet ? l.sheet.cssRules.length : 'none') })()`]).trim().replace(/"/g, '')
      } catch (e) { /* keep */ }
      if (ok) {
        console.log('PASS ' + name + ' diff ' + (ratio * 100).toFixed(3) + '% [' + seen + ']' + (sceneAttempt > 0 ? ' (retry)' : ''))
        break
      }
      fs.writeFileSync(file.replace('.png', '.current.png'), buf)
      if (sceneAttempt === 0) { console.log('↻ ' + name + ' diff ' + (ratio * 100).toFixed(3) + '% [' + seen + '] — 重试整个场景') }
      else { console.log('FAIL ' + name + ' diff ' + (ratio * 100).toFixed(3) + '% [' + seen + ']'); verdict = 'diff ' + (ratio * 100).toFixed(3) + '%' }
    }
    if (verdict) fail++
    }
  }
  return fail
}

// run 级重试:活体宿主残存随机单场景翻车(主题偶发翻回/空态帧,每轮 ≤1-2 图、不可复现定位)。
// 真回归两次都红照常拦;环境抖动重试即绿。VISUAL_NO_RETRY=1 关闭(调试用)。
let fail = await runAll()
if (fail && MODE === 'check' && !process.env.VISUAL_NO_RETRY) {
  console.log('↻ run-level retry(整轮重跑一次)')
  resetBrowser()
  fail = await runAll()
}
console.log(fail ? `✗ ${fail} failures` : '✓ all web visual checks passed')
killVite()
process.exit(fail ? 1 : 0)
