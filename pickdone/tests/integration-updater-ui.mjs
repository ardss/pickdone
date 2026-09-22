/**
 * Updater UI 链路活体验证（独立脚本,不入 check:all——真更新下载依赖真实 GitHub Release,无法离线门禁）
 * 覆盖:UI store 镜像 updater:event → 齿轮红点 badge 渲染;dev 环境降级(active:false);
 *       autoDownloadUpdates 默认值;downloadUpdate 非 available 态守卫返回 false。
 * 运行:node tests/integration-updater-ui.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ELECTRON = require('electron')
const appCwd = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))

let ws = null
let id = 0
const pending = new Map()
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id
  pending.set(mid, { resolve, reject })
  ws.send(JSON.stringify({ id: mid, method, params }))
  // 2026-09-23: 10s was fine standalone but this stage runs in check:all's 3-lane live pool —
  // three Electron instances + the unit wall compete for CPU and a cold Runtime.evaluate can
  // legitimately exceed 10s (the retry-once wrapper in check-all papers over it at best). 30s
  // covers the contended case without slowing the uncontended one.
  setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error('cdp timeout ' + method)) } }, 30000)
})
// Poll an evaluate until it settles, instead of one fixed sleep + one shot: under the 3-lane
// live pool the renderer's first paint can land well after the CDP socket opens.
const evaluateReady = async (expr, { tries = 20, gapMs = 1500 } = {}) => {
  let lastErr
  for (let i = 0; i < tries; i++) {
    try { return await evaluate(expr) } catch (e) { lastErr = e; await sleep(gapMs) }
  }
  throw lastErr
}
const evaluate = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.error) throw new Error('cdp error: ' + r.error.message)
  const ed = r.result && r.result.exceptionDetails
  if (ed) throw new Error('eval failed: ' + JSON.stringify(ed.exception?.description || ed).slice(0, 300))
  // Runtime.evaluate 返回双层:result.result 才是 RemoteObject({type,value})
  const ro = r.result && r.result.result
  return ro ? ro.value : undefined
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-upd-'))
fs.writeFileSync(path.join(tmpDir, 'todos.db'), '')
// Candidate ports tried in order. ANY fixed/formula port can land in a Windows WinNAT excluded
// range — those ranges SHIFT between reboots (9400-9499 was reserved here once, 9700-9949 later;
// bind() then fails with 0x271D and devtools silently never starts). So: try candidates until
// /json/list actually answers, kill the instance otherwise. (2026-09-23)
const CANDIDATE_PORTS = [9750, 9761, 9772, 9783, 9794, 9805, 9816, 9827, 9838, 9849, 9860, 9950, 9961]
let PORT = null
let child = null
// 2026-09-13: this script is standalone and used to rely on the unit-pool overlay test (runtime.mjs
// import side effect) having created tests/.artifacts first — moving that test out of the unit pool
// broke it on fresh checkouts. Create the dir instead of depending on another script's side effect.
fs.mkdirSync(path.join(appCwd, 'tests', '.artifacts'), { recursive: true })

async function devtoolsAnswers (port, deadlineMs = 12000) {
  const t0 = Date.now()
  while (Date.now() - t0 < deadlineMs) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1200) })).json()
      if (Array.isArray(list)) return true
    } catch { await sleep(500) }
  }
  return false
}

for (const candidate of CANDIDATE_PORTS) {
  PORT = candidate
  child = spawn(ELECTRON, ['.', '--no-focus', '--remote-debugging-port=' + PORT, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], {
    cwd: appCwd,
    env: { ...process.env, TODO_USER_DATA_DIR: tmpDir },
    stdio: ['ignore', fs.openSync(path.join(appCwd, 'tests', '.artifacts', 'upd-app.log'), 'a'), fs.openSync(path.join(appCwd, 'tests', '.artifacts', 'upd-app.log'), 'a')]
  })
  if (await devtoolsAnswers(PORT)) break
  // devtools never came up: the bind was refused (excluded range) — kill and try the next port
  console.log(`[port] ${candidate} unusable (devtools bind refused or no CDP), trying next`)
  if (process.platform === 'win32') { try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} } else { try { child.kill('SIGKILL') } catch {} }
  await sleep(1500)
  child = null
}
try {
  const CDP = `http://127.0.0.1:${PORT}`

// Connect to the app page. Accept the bare index.html page too: on a fresh CI profile the
// first route is not necessarily #/todo-list. Pre-mount pages are fine — the #app.__vue_app__
// poll below gates the assertions.
const connectApp = async () => {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(CDP + '/json/list', { signal: AbortSignal.timeout(1500) })).json()
      const page = list.find(t => t.type === 'page' && /#\/todo-list/.test(t.url)) || list.find(t => t.type === 'page' && /index\.html/.test(t.url))
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
        ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m); pending.delete(m.id) } }
        return true
      }
    } catch { await sleep(600) }
  }
  return false
}

// The renderer reloads once early on a fresh profile (locale bootstrap / LS restore). When that
// reload lands mid-sequence, #app goes null under the ws's feet — the correct response is to
// RECONNECT to the new document and re-run, not to red the gate.
for (let attempt = 1; attempt <= 3; attempt++) {
  if (!ws) {
    const connected = await connectApp()
    if (!connected) {
      console.error('[diag] electron pid', child.pid, 'killed?', child.killed, 'exitCode', child.exitCode)
      try { console.error('[diag] app log tail:\n' + fs.readFileSync(path.join(appCwd, 'tests', '.artifacts', 'upd-app.log'), 'utf8').split('\n').slice(-40).join('\n')) } catch {}
    }
    assert.ok(connected, 'app not ready within ~60s')
  }
  try {
    // 0. wait for the real todoAPI (poll: under the 3-lane live pool the renderer's first paint
    // can land well after the CDP socket opens)
    const probe = await evaluateReady(`(async () => ({ hasAPI: !!window.todoAPI, keys: window.todoAPI ? Object.keys(window.todoAPI).filter(k => /updat|check/i.test(k)) : [] }))()`)
    console.log('[probe]', JSON.stringify(probe))
    const targets = await (await fetch('http://127.0.0.1:' + PORT + '/json/list', { signal: AbortSignal.timeout(1500) })).json()
    console.log('[targets]', targets.map(x => x.type + ' ' + x.url.slice(0, 60)).join(' | '))
    // wait for the Vue app to actually mount (#app.__vue_app__) — the CDP connection can beat
    // the router+mount, and #app is null until then.
    await evaluateReady(`(function(){ const el = document.querySelector('#app'); return !!(el && el.__vue_app__) })()`, { tries: 30, gapMs: 1000 })
    // 1. dev downgrade: updater inactive (preload->main full chain)
    const st = await evaluate('window.todoAPI.updaterStatus()')
    assert.equal(st.active, false, 'dev 环境应 active:false')
    assert.ok(st.version, '应带当前版本号')

    // 2. downloadUpdate guard: must return false while inactive
    const dl = await evaluate('window.todoAPI.downloadUpdate()')
    assert.equal(dl, false, 'downloadUpdate 在未发现新版时应返回 false')

    // 3. default settings: autoDownloadUpdates merged true via DEFAULT_SETTINGS
    const auto = await evaluate(`(function(){ const $store = document.querySelector('#app').__vue_app__.config.globalProperties.$store; const v = $store.state.settings.autoDownloadUpdates; if (v === undefined) { $store.commit('settings/updateSettings', {}); } return v; })()`)
    assert.equal(auto, true, 'autoDownloadUpdates 默认应为 true(store 合并后)')

    // 4. UI chain: drive the same commit path as updater:event and verify the badge renders
    await evaluate(`document.querySelector('#app').__vue_app__.config.globalProperties.$store.commit('ui/setUpdateState', { status: 'ready' })`)
    let dots = 0
    for (let i = 0; i < 20; i++) {
      dots = await evaluate('document.querySelectorAll(".sn-upd-dot").length')
      if (dots >= 1) break
      await sleep(300)
    }
    assert.ok(dots >= 1, `ready 态齿轮红点未渲染(dots=${dots})`)
    await evaluate(`document.querySelector('#app').__vue_app__.config.globalProperties.$store.commit('ui/setUpdateState', { status: 'uptodate' })`)
    for (let i = 0; i < 20; i++) {
      dots = await evaluate('document.querySelectorAll(".sn-upd-dot").length')
      if (dots === 0) break
      await sleep(300)
    }
    assert.equal(dots, 0, '非 ready 态不应残留红点')
    break
  } catch (e) {
    // early-boot reload landed mid-sequence: drop the dead document and retry on the new one
    if (attempt < 3 && /Cannot read properties of null/.test(String(e))) {
      console.log(`[retry] page navigated mid-sequence (early-boot reload), reconnecting — attempt ${attempt + 1}/3`)
      try { ws && ws.close() } catch {}
      ws = null
      await sleep(1500)
      continue
    }
    throw e
  }
}

} finally {
  try { ws && ws.close() } catch {}
  if (process.platform === 'win32') { try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} } else { try { child.kill('SIGKILL') } catch {} }
  await sleep(1500)
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
}
