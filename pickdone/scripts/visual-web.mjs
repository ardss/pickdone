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

const ROUTES = [
  '#/todo-list/today', '#/todo-list/todo-box', '#/todo-list/calendar',
  '#/todo-list/completed', '#/todo-list/statistics', '#/todo-list/projects',
  '#/todo-list/recycle-bin'
]

import { execSync, spawn as cpSpawn } from 'node:child_process'
const ab = (args) => execSync('agent-browser ' + args.map(a => JSON.stringify(a)).join(' '), { encoding: 'utf8', timeout: 120000, shell: true })

// --spawn: 自拉起 5175 vite 宿主(独占门禁自身生命周期,结束即杀,不依赖外部常驻服务)
let viteChild = null
if (SPAWN) {
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

function setEnv (theme) {
  // fresh cache-busted URL: head merge script re-applies demo settings; we override theme afterwards
  // seed=today re-injected per scene: shim tomatoes anchor to yesterday (deterministic all day);
  // without this, LS holds whatever a previous manual visit seeded and aggregations drift across days
  ab(['--session', SESSION, 'open', BASE + '/?' + STAMP + theme + '&seed=today#/todo-list/today'])
  ab(['--session', SESSION, 'eval', `(() => { try { localStorage.setItem('appLocale', 'en-US'); localStorage.setItem('sidebarCollapsed', 'false'); localStorage.setItem('onboardingToursSeen', '1'); localStorage.setItem('onboardingDone', '1'); const st = JSON.parse(localStorage.getItem('settingsState') || '{}'); st.colorMode = '${theme}'; localStorage.setItem('settingsState', JSON.stringify(st)) } catch (e) {} const b = [...document.querySelectorAll('button')].find(x => ['Stay yesterday', '留在昨天', 'Skip', '稍后'].includes(x.textContent.trim())); if (b) b.click(); return 'ok' })()`])
  ab(['--session', SESSION, 'eval', `location.reload(); 'r'`])
}

let fail = 0
for (const route of ROUTES) {
  for (const theme of ['light', 'dark']) {
    const name = route.replace(/\//g, '_').replace(/^_/, '') + '-' + theme + '.png'
    setEnv(theme)
    // wait for readiness: app mounted + theme applied (fixed sleeps race against vite cold transforms)
    // single-line expr: win32 shell:true routes through cmd.exe, embedded newlines break the quoted arg
    const readyExpr = `(() => { const themed = document.documentElement.getAttribute('data-theme') === '${theme}'; const mounted = !!document.querySelector('#app .side-nav'); const overlay = !!document.querySelector('vite-error-overlay'); return (themed && mounted && !overlay) ? 'ready' : 'wait' })()`
    let ready = ''
    for (let t = 0; t < 90000 && ready !== 'ready'; t += 500) {
      await new Promise(r => setTimeout(r, 500))
      try { ready = ab(['--session', SESSION, 'eval', readyExpr]).trim().replace(/"/g, '') } catch (e) { /* retry */ }
    }
    ab(['--session', SESSION, 'eval', `location.hash='${route}'; 'nav'`])
    await new Promise(r => setTimeout(r, 2500))
    const shotPath = path.join(DIR, '.cur.png')
    // load-burst robustness: a wedged shot returns an unchanged/blank frame; retry once after re-wait
    let buf = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        ab(['--session', SESSION, 'screenshot', shotPath])
        const b = fs.readFileSync(shotPath)
        if (b.length > 10000) { buf = b; break }
      } catch (e) { /* retry */ }
      await new Promise(r => setTimeout(r, 2000))
    }
    if (!buf) { console.log('FAIL ' + name + ' (screenshot twice unavailable under load)'); fail++; continue }
    const file = path.join(DIR, name)
    if (MODE === 'baseline') {
      fs.writeFileSync(file, buf)
      console.log('baseline ' + name)
      continue
    }
    if (!fs.existsSync(file)) { console.log('MISSING-BASELINE ' + name); fail++; continue }
    const a = PNG.sync.read(fs.readFileSync(file))
    const b = PNG.sync.read(buf)
    if (a.width !== b.width || a.height !== b.height) {
      console.log('FAIL ' + name + ` size ${a.width}x${a.height} -> ${b.width}x${b.height}`)
      fail++
      continue
    }
    const diff = pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.1 })
    const ratio = diff / (a.width * a.height)
    const ok = ratio <= THRESHOLD
    console.log((ok ? 'PASS ' : 'FAIL ') + name + ' diff ' + (ratio * 100).toFixed(3) + '%')
    if (!ok) { fs.writeFileSync(file.replace('.png', '.current.png'), buf); fail++ }
  }
}
console.log(fail ? `✗ ${fail} failures` : '✓ all web visual checks passed')
killVite()
process.exit(fail ? 1 : 0)
