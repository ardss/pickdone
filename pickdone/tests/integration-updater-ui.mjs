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
  setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error('cdp timeout ' + method)) } }, 10000)
})
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
const PORT = 9447 // Windows 保留段 9292-9391 之外
const child = spawn(ELECTRON, ['.', '--no-focus', '--remote-debugging-port=' + PORT], {
  cwd: appCwd,
  env: { ...process.env, TODO_USER_DATA_DIR: tmpDir },
  stdio: ['ignore', fs.openSync(appCwd + '/tests/.artifacts/upd-app.log', 'a'), fs.openSync(appCwd + '/tests/.artifacts/upd-app.log', 'a')]
})
try {
  const CDP = `http://127.0.0.1:${PORT}`
  let ok = false
  for (let i = 0; i < 40 && !ok; i++) {
    try {
      const list = await (await fetch(CDP + '/json/list', { signal: AbortSignal.timeout(1500) })).json()
      const page = list.find(t => t.type === 'page' && /#\/todo-list/.test(t.url)) || list.find(t => t.type === 'page' && /index\.html/.test(t.url))
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
        ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m); pending.delete(m.id) } }
        ok = true
      }
    } catch { await sleep(600) }
  }
  assert.ok(ok, 'app not ready within ~24s')
  await sleep(1500)

  // 0. 诊断:确认挂在真实 todoAPI 上
  const probe = await evaluate(`(async () => ({ hasAPI: !!window.todoAPI, keys: window.todoAPI ? Object.keys(window.todoAPI).filter(k => /updat|check/i.test(k)) : [] }))()`)
  console.log('[probe]', JSON.stringify(probe))
  const targets = await (await fetch('http://127.0.0.1:' + PORT + '/json/list', { signal: AbortSignal.timeout(1500) })).json()
  console.log('[targets]', targets.map(x => x.type + ' ' + x.url.slice(0, 60)).join(' | '))
  // 1. dev 环境:updater 降级 active:false(preload→main 全链通)
  const st = await evaluate('window.todoAPI.updaterStatus()')
  assert.equal(st.active, false, 'dev 环境应 active:false')
  assert.ok(st.version, '应带当前版本号')

  // 2. downloadUpdate 守卫:非 available 态(且 dev inactive)必须返回 false,不会误触安装器
  const dl = await evaluate('window.todoAPI.downloadUpdate()')
  assert.equal(dl, false, 'downloadUpdate 在未发现新版时应返回 false')

  // 3. 默认设置:autoDownloadUpdates 经 DEFAULT_SETTINGS 合并后 store 中必须为 true(旧库逐键补默认语义)
  const auto = await evaluate(`(function(){ const $store = document.querySelector('#app').__vue_app__.config.globalProperties.$store; const v = $store.state.settings.autoDownloadUpdates; if (v === undefined) { $store.commit('settings/updateSettings', {}); } return v; })()`)
  assert.equal(auto, true, 'autoDownloadUpdates 默认应为 true(store 合并后)')

  // 4. UI 链路:模拟主进程广播 ready → badge 红点必须出现;切回 idle → 红点消失
  //    (直接驱动与 updater:event 同一条 commit 路径的 mutation,验 badge 渲染而非事件传输)
  await evaluate(`document.querySelector('#app').__vue_app__.config.globalProperties.$store.commit('ui/setUpdateState', { status: 'ready' })`)
  await sleep(300)
  let dots = await evaluate('document.querySelectorAll(".sn-upd-dot").length')
  assert.ok(dots >= 1, `ready 态齿轮红点未渲染(dots=${dots})`)
  await evaluate(`document.querySelector('#app').__vue_app__.config.globalProperties.$store.commit('ui/setUpdateState', { status: 'uptodate' })`)
  await sleep(300)
  dots = await evaluate('document.querySelectorAll(".sn-upd-dot").length')
  assert.equal(dots, 0, '非 ready 态不应残留红点')

  console.log('✓ updater UI 链路 4/4 全过:降级 active:false / downloadUpdate 守卫 / 开关默认值 / 红点随状态渲染')
} finally {
  try { ws && ws.close() } catch {}
  if (process.platform === 'win32') { try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} } else { try { child.kill('SIGKILL') } catch {} }
  await sleep(1500)
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
}
