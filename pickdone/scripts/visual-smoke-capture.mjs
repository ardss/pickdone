#!/usr/bin/env node
/**
 * 视觉冒烟截图(CI 观测设备,非门禁):与 visual-web.mjs 同源的 14 场景(7 路由 × 深浅色)
 * 截图存档,供人工 diff。不比对、不设阈值、恒 exit 0(除非环境级失败,由 workflow 的
 * continue-on-error 兜底不阻塞)。
 *
 * 为什么不复用 visual-web.mjs:它硬依赖本机 agent-browser CLI(Windows 专属二进制 +
 * daemon + taskkill 清场),CI(ubuntu)没有。本脚本用 playwright chromium 实现同样的
 * "5175 Vite 宿主 + pdTheme/seed/pdFreeze URL 参数" 截图机制。
 *
 * 用法:
 *   node scripts/visual-smoke-capture.mjs              # 全部 14 场景
 *   SMOKE_SCENES=2 node ...                            # 只截前 2 个场景(本地调试)
 * 前置: playwright 已安装(npm i --no-save playwright && npx playwright install chromium)。
 * 宿主 vite 由本脚本自拉起(独占生命周期,结束即杀),端口默认 5175,可用 SMOKE_PORT 覆盖。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn as cpSpawn } from 'node:child_process'
import { chromium } from 'playwright'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = process.env.SMOKE_PORT || '5175'
const BASE = `http://127.0.0.1:${PORT}`
const DIR = path.join(ROOT, 'tests', '.artifacts', 'visual-smoke')
// 与 visual-web.mjs 保持同源:同一冻结时刻,基线跨真实日期不漂移
const FREEZE = '2026-09-09T10:05:00'
// 与 visual-web.mjs ROUTES 完全一致(2026-09-13 同步)
const ROUTES = [
  '#/todo-list/today', '#/todo-list/todo-box', '#/todo-list/calendar',
  '#/todo-list/completed', '#/todo-list/statistics', '#/todo-list/projects',
  '#/todo-list/recycle-bin'
]
const LIMIT = Number(process.env.SMOKE_SCENES || 0) // 0 = all

// --- 自拉起 5175 宿主(同 visual-web --spawn,但跨平台:不 netstat/taskkill,CI 是干净环境) ---
// vite 输出写入日志文件而非 ignore——宿主起不来时把日志倾倒出来,否则 CI 上死因不可见
const VITE_LOG = path.join(os.tmpdir(), `visual-smoke-vite-${process.pid}.log`)
const viteLogFd = fs.openSync(VITE_LOG, 'w')
const viteChild = cpSpawn('npm', ['run', 'dev'], { cwd: path.join(ROOT, 'browser-dev'), shell: true, stdio: ['ignore', viteLogFd, viteLogFd] })
process.on('exit', () => { try { viteChild.kill() } catch { /* gone */ } })

const BASE_ALT = BASE.replace('//localhost:', '//127.0.0.1:') // ubuntu 上 localhost 可能先解析 ::1
let up = false
// CI 冷缓存时 vite 依赖预构建能跑 60s 以上,给足 3 分钟;每 10s 打一次进度防止黑等
for (let t = 0; t < 180000 && !up; t += 500) {
  await new Promise(r => setTimeout(r, 500))
  for (const u of [BASE, BASE_ALT]) {
    try { if ((await fetch(u, { signal: AbortSignal.timeout(2000) })).ok) { console.error(`visual-smoke: host ready via ${u} after ${t}ms`); up = true; break } } catch { /* retry */ }
  }
  if (t > 0 && t % 10000 === 0 && !up) console.error(`visual-smoke: waiting for host, ${t}ms elapsed, vite alive=${viteChild.exitCode === null}`)
}
if (!up) {
  console.error('✗ visual-smoke: 180s 内宿主未就绪(vite 启动失败?)')
  try { console.error('--- vite log FULL ---\n' + fs.readFileSync(VITE_LOG, 'utf8').slice(-12000)) } catch { /* no log */ }
  process.exit(2)
}

fs.mkdirSync(DIR, { recursive: true })
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
// 场景固定设置:等价 visual-web setEnv 里的 localStorage 写入;addInitScript 在页面脚本前生效,
// 免掉 eval+reload 的竞态(playwright 全新 context,无跨运行污染)
await context.addInitScript(() => {
  try {
    localStorage.setItem('appLocale', 'en-US')
    localStorage.setItem('sidebarCollapsed', 'false')
    localStorage.setItem('onboardingToursSeen', '1')
    localStorage.setItem('onboardingDone', '1')
  } catch (e) { /* ignore */ }
})
const page = await context.newPage()

let shot = 0
outer:
for (const route of ROUTES) {
  for (const theme of ['light', 'dark']) {
    if (LIMIT && shot >= LIMIT) break outer
    // STAMP 每场景换值:宿主按参数重播种并重启纪元,场景间状态不串台(同 visual-web)
    const url = `${BASE}/?s${Date.now()}${theme}&seed=today&pdTheme=${theme}&pdFreeze=${encodeURIComponent(FREEZE)}#/todo-list/today`
    const name = route.replace(/\//g, '_').replace(/^_/, '') + '-' + theme + '.png'
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      // 关掉「留在昨天」类引导弹层(同 visual-web)
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find(x => ['Stay yesterday', '留在昨天', 'Skip', '稍后'].includes(x.textContent.trim()))
        if (b) b.click()
      }).catch(() => { /* 弹层可能不存在 */ })
      // 就绪:主题 + 应用挂载(同 visual-web readyExpr 判据)
      await page.waitForFunction(
        (t) => document.documentElement.getAttribute('data-theme') === t && !!document.querySelector('#app .side-nav'),
        theme, { timeout: 30000 }
      )
      await page.evaluate((r) => { location.hash = r }, route)
      await page.waitForFunction((r) => location.hash === r, route, { timeout: 15000 })
      // 双 rAF 等一次真实出帧,避免拍到陈旧帧(同 visual-web 绘制栅栏)
      await page.evaluate(() => new Promise((res) => {
        const t = setTimeout(() => res('timeout'), 5000)
        requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); res('painted') }))
      }))
      await page.waitForTimeout(1500) // 数据 hydrate 沉降
      await page.screenshot({ path: path.join(DIR, name) })
      shot++
      console.log('shot ' + name)
    } catch (e) {
      console.error('✗ ' + name + ' — ' + (e && e.message ? e.message.split('\n')[0] : e))
    }
  }
}

await browser.close()
viteChild.kill()
console.log(`visual-smoke: ${shot} screenshots -> ${DIR}`)
process.exit(0) // 冒烟不是门禁:即使个别场景失败也不红
