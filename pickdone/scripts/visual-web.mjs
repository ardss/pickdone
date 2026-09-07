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

import { execSync } from 'node:child_process'
const ab = (args) => execSync('agent-browser ' + args.map(a => JSON.stringify(a)).join(' '), { encoding: 'utf8', timeout: 120000, shell: true })

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
  console.error('✗ visual-web: 5175 宿主未启动 —— 先在 browser-dev/ 跑 `npm run dev`(vite --port 5175)再重跑。')
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
    for (let t = 0; t < 40000 && ready !== 'ready'; t += 500) {
      await new Promise(r => setTimeout(r, 500))
      try { ready = ab(['--session', SESSION, 'eval', readyExpr]).trim().replace(/"/g, '') } catch (e) { /* retry */ }
    }
    ab(['--session', SESSION, 'eval', `location.hash='${route}'; 'nav'`])
    await new Promise(r => setTimeout(r, 2500))
    const shotPath = path.join(DIR, '.cur.png')
    ab(['--session', SESSION, 'screenshot', shotPath])
    const buf = fs.readFileSync(shotPath)
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
process.exit(fail ? 1 : 0)
