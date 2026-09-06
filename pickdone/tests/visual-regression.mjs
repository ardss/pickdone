/**
 * Visual regression gate - drives the real app via CDP, screenshots every route x light/dark themes, and pixel-diffs against baselines.
 * 用法:
 *   npm run visual:baseline   # retake baselines (before refactors / after intentional redesigns)
 *   npm run visual:check      # compare against baselines; diff beyond the threshold exits non-zero (mandatory after refactor/style changes)
 * Requires the app running with a debug port: npx electron . --no-focus --remote-debugging-port=9333 (SKIPs with exit 0 when absent, never blocking CI)
 * Baselines/artifacts go to tests/.artifacts/visual/ (gitignored).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'

const CDP = process.env.TODO_CDP || 'http://127.0.0.1:9333'
const MODE = process.argv.includes('--baseline') ? 'baseline' : 'check'
const THRESHOLD = Number(process.env.VISUAL_THRESHOLD || 0.004) // diff pixel ratio >0.4% counts as a regression
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '.artifacts', 'visual')
fs.mkdirSync(DIR, { recursive: true })

// The route list is derived from views/registry.js (single source of truth)
const { SMOKE_ROUTES } = await import('../renderer/js/views/registry.js')

const watchdog = setTimeout(() => { console.error('FAIL: visual regression did not finish within 120s; forcing exit'); process.exit(1) }, 120000)
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function connect () {
  let list
  try { list = await (await fetch(CDP + '/json/list')).json() } catch { return null }
  const page = list.find(t => t.type === 'page' && /index\.html/.test(t.url) && !t.url.includes('__tomato-float'))
  if (!page || typeof WebSocket === 'undefined') return null
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  let pending = null
  ws.onmessage = ev => {
    try {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
      if (m.id === 1 && pending) { const p = pending; pending = null; m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) }
    } catch { /* ignore event frames */ }
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    pending = { resolve, reject }
    ws.send(JSON.stringify({ id: 1, method, params }))
  })
  return { ws, send }
}

const conn = await connect()
if (!conn) { console.log('SKIP: app is not running with a debug port (npx electron . --no-focus --remote-debugging-port=9333)'); process.exit(0) }
const { ws, send } = conn

// Fixed emulated viewport: decouples screenshots from real window size/zoom/minimized state (baselines must be reproducible)
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })

async function navigate (hash) {
  await send('Runtime.evaluate', { expression: `location.hash='${hash}'` })
  await sleep(1100) // wait for route render + charts/transitions to settle
}

async function setTheme (dark) {
  await send('Runtime.evaluate', { expression: `document.documentElement.setAttribute('data-theme','${dark ? 'dark' : 'light'}')` })
  await sleep(350)
}

async function shot () {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  return Buffer.from(data, 'base64')
}

// 拍摄前状态消毒:引导遮罩/新手引导会污染所有基线(ui-smoke L130 实锤);统一清理后再进场景循环
async function hygiene () {
  await send('Runtime.evaluate', { expression: `(() => {
    try { localStorage.setItem('onboardingToursSeen', '1'); localStorage.setItem('onboardingDone', '1') } catch {}
    document.querySelectorAll('.ob-mask, [class*=onboarding]').forEach(e => e.remove())
    window.appUI && window.appUI.$store.commit('ui/toggleSettings', false)
    return 'ok'
  })()` })
  await sleep(400)
}
await hygiene()

// 弹窗开态场景(审计 C 批:目录前缀式路由基线拍不到弹窗几何/层叠,RepeatModal 事故形态)
const EXTRA_SCENES = [
  { name: 'today-settings-open-light', hash: '#/todo-list/today', dark: false, setup: `window.appUI.$store.commit('ui/toggleSettings', true)` },
  { name: 'today-settings-open-dark', hash: '#/todo-list/today', dark: true, setup: `window.appUI.$store.commit('ui/toggleSettings', true)` }
]

let fail = 0
for (const route of SMOKE_ROUTES) {
  for (const theme of ['light', 'dark']) {
    const name = route.replace(/\//g, '_').replace(/^_/, '') + '-' + theme + '.png'
    await navigate(route)
    await setTheme(theme === 'dark')
    const buf = await shot()
    const file = path.join(DIR, name)
    if (MODE === 'baseline') {
      fs.writeFileSync(file, buf)
      console.log('baseline ' + name)
      continue
    }
    if (!fs.existsSync(file)) { console.log('MISSING-BASELINE ' + name + ' (run visual:baseline first)'); fail++; continue }
    const a = PNG.sync.read(fs.readFileSync(file))
    const b = PNG.sync.read(buf)
    if (a.width !== b.width || a.height !== b.height) {
      console.log('FAIL ' + name + ` size changed ${a.width}x${a.height} -> ${b.width}x${b.height}`)
      fail++
      continue
    }
    const diff = pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.1 })
    const ratio = diff / (a.width * a.height)
    const ok = ratio <= THRESHOLD
    console.log((ok ? 'PASS ' : 'FAIL ') + name + ' diff ' + (ratio * 100).toFixed(3) + '%')
    if (!ok) fail++
  }
}
for (const scene of EXTRA_SCENES) {
  await navigate(scene.hash)
  await setTheme(scene.dark)
  await send('Runtime.evaluate', { expression: scene.setup })
  await sleep(900)
  const buf = await shot()
  const file = path.join(DIR, scene.name + '.png')
  if (MODE === 'baseline') { fs.writeFileSync(file, buf); console.log('baseline ' + scene.name); continue }
  if (!fs.existsSync(file)) { console.log('MISSING-BASELINE ' + scene.name); fail++; continue }
  const a = PNG.sync.read(fs.readFileSync(file))
  const b = PNG.sync.read(buf)
  const diff = pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.1 })
  const ratio = diff / (a.width * a.height)
  const ok = ratio <= THRESHOLD
  console.log((ok ? 'PASS ' : 'FAIL ') + scene.name + ' diff ' + (ratio * 100).toFixed(3) + '%')
  if (!ok) fail++
  // 收尾关弹窗,避免污染下一场景
  await send('Runtime.evaluate', { expression: `window.appUI && window.appUI.$store.commit('ui/toggleSettings', false)` })
  await sleep(400)
}
try { ws.close() } catch { /* empty */ }
clearTimeout(watchdog)
if (MODE === 'baseline') console.log('✓ baselines updated (' + SMOKE_ROUTES.length * 2 + ' images)')
else if (fail) { console.error('✗ ' + fail + ' visual regression failures'); process.exit(1) }
else console.log('✓ all visual regression checks passed')
