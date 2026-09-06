/**
 * 统一的「自拉起 Electron 隔离实例 + CDP 客户端」公共库。
 * 合并了 integration-ui.test.mjs / run-interactions-gated.mjs / ui-smoke.mjs 三处各自的实现
 * （2026-09-01 测试体系审计：三份实现已开始漂移——端口探测法不同、page 过滤不同、退出方式不同）。
 * 参数化：端口自动分配 / 隔离 userData（预置空 todos.db 跳过 legacy 迁移）/ --no-focus / 日志写文件。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
export const ELECTRON = require('electron') // npm 安装的 electron 模块解析即二进制路径（跨平台免手拼 dist/electron.exe）

const APP_CWD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ARTIFACTS = path.join(APP_CWD, 'tests', '.artifacts')
fs.mkdirSync(ARTIFACTS, { recursive: true })

// spawnApp 自建的临时 userData 目录登记表;测试进程退出时同步清理(2026-09-02 环境隔离审计:原只建不删,%TEMP% 垃圾累积)
const _tempUserDataDirs = new Set()
export function cleanupTempUserData () {
  for (const d of _tempUserDataDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* 文件仍被占用则留给系统 */ } }
  _tempUserDataDirs.clear()
}
process.on('exit', cleanupTempUserData)

export const sleep = ms => new Promise(r => setTimeout(r, ms))

/** bind-then-release 探测空闲调试端口（比 probe-then-bind 更稳，run-interactions-gated 已验证） */
export async function pickFreePort () {
  const net = await import('node:net')
  for (let i = 0; i < 12; i++) {
    const p = 9400 + Math.floor(Math.random() * 400)
    const free = await new Promise(resolve => {
      const srv = net.createServer()
      srv.once('error', () => resolve(false))
      srv.once('listening', () => srv.close(() => resolve(true)))
      srv.listen(p, '127.0.0.1')
    })
    if (free) return p
  }
  throw new Error('no free debug port found')
}

/**
 * 拉起隔离 Electron 实例。
 * @param {object} [opts]
 * @param {string} [opts.name='app']        日志文件名前缀
 * @param {number} [opts.port]              缺省自动分配空闲端口
 * @param {string} [opts.userDataDir]       缺省 mkdtemp 临时目录（预置空 todos.db 跳过 legacy 迁移）
 * @param {string[]} [opts.appArgs]         额外命令行参数
 * @returns {Promise<{child, port, cdp, userDataDir, wsUrl:()=>string}>}
 */
export async function spawnApp (opts = {}) {
  const port = opts.port || await pickFreePort()
  const autoDir = !opts.userDataDir
  const userDataDir = opts.userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'todo-test-'))
  // 预置空 todos.db：新库直接走当前 SCHEMA，跳过 legacy 迁移分支（与 integration-ui 的 seed 语义一致）
  try { fs.writeFileSync(path.join(userDataDir, 'todos.db'), '') } catch {}
  if (autoDir) _tempUserDataDirs.add(userDataDir) // 自建临时目录登记,测试进程退出时统一清(复用外部目录的不动,重启持久化类测试还要读)
  const logFile = path.join(ARTIFACTS, `${opts.name || 'app'}-app.log`)
  const baseArgs = opts.allowFocus ? [] : ['--no-focus']
  const child = spawn(ELECTRON, ['.', ...baseArgs, '--remote-debugging-port=' + port, ...(opts.appArgs || []), ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], {
    cwd: APP_CWD,
    env: { ...process.env, TODO_USER_DATA_DIR: userDataDir },
    // app 输出写文件：node:test 会捕获 hook console，启动日志必须落盘可查
    stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')],
    detached: false
  })
  return { child, port, cdp: `http://127.0.0.1:${port}`, userDataDir, logFile }
}

/** 优雅退出（Browser.close 触发 before-quit/mirror flush）→ 超时 taskkill 整树（win32 必须防锁残留） */
export async function stopApp (ctx) {
  let graceful = false
  if (ctx._ws) {
    try {
      const exited = new Promise(r => { if (ctx.child) ctx.child.on('exit', r); else r() })
      await Promise.race([ctx._send('Browser.close'), sleep(4000).then(() => 'timeout')])
      graceful = await Promise.race([exited.then(() => true), sleep(4000).then(() => false)])
    } catch {}
  }
  try { ctx._ws && ctx._ws.close() } catch {}
  ctx._ws = null
  if (!graceful && ctx.child && process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(ctx.child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else if (!graceful && ctx.child) {
    try { ctx.child.kill('SIGKILL') } catch {}
  }
  await sleep(2500) // 进程树退出 + SQLite WAL 落盘
}

/** 连接主窗 page（过滤浮窗 target；保留 index.html 兜底——冷启动 hash 可能为空） */
export async function connectCdp (ctx, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const list = await (await fetch(ctx.cdp + '/json/list', { signal: AbortSignal.timeout(1500) })).json()
      const page = list.find(t => t.type === 'page' && !t.url.includes('__tomato-float') &&
        (/#\/(todo-list|__widget\/list)/.test(t.url) || t.url.includes('index.html')))
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
        const pending = new Map()
        let id = 0
        const consoleErrors = []
        const sendRaw = (method, params = {}) => new Promise(res => {
          const i2 = ++id; pending.set(i2, res); ws.send(JSON.stringify({ id: i2, method, params }))
        })
        ws.onmessage = e => {
          const m = JSON.parse(e.data)
          if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
          if (m.method === 'Runtime.exceptionThrown') {
            consoleErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || 'unknown')
          }
          if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
            consoleErrors.push(m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300))
          }
        }
        await sendRaw('Runtime.enable')
        ctx._ws = ws
        ctx._send = sendRaw
        ctx.consoleErrors = consoleErrors
        // 语言钉死 zh-CN:CI runner 系统语言 en-US,应用跟随系统变英文,全套中文选择器/文案断言全哑
        // (2026-09-06 公开 CI 实锤:body 文本以 "PickDone Completed…" 开头=导航已英文化)。pin appLocale=en-US (product default: en unless system zh) + reload + wait for shell ready.
        try {
          await sendRaw('Page.enable')
          await sendRaw('Runtime.evaluate', { expression: "try{localStorage.setItem('appLocale','en-US')}catch(e){}" })
          await sendRaw('Page.reload', { ignoreCache: true })
          for (let i = 0; i < 40; i++) {
            const rr = await sendRaw('Runtime.evaluate', { expression: '!!window.appUI && !!document.querySelector(.app-shell-INIT)'.replace('.app-shell-INIT', String.fromCharCode(39) + '.app-shell' + String.fromCharCode(39)), returnByValue: true }).catch(() => null)
            if (rr && rr.result && rr.result.value === true) break
            await sleep(500)
          }
        } catch { /* reload 通道异常时交还脚本自身的等待逻辑 */ }
        return ctx
      }
    } catch { /* app not ready */ }
    await sleep(500)
  }
  throw new Error('app not ready within retry budget (port ' + ctx.port + ')')
}

export async function send (ctx, method, params = {}) { return ctx._send(method, params) }

/** 页面内求值（JSON 序列化往返；12s 超时=页面僵死或 WS 断连） */
export async function evalJson (ctx, expression) {
  const r = await Promise.race([
    ctx._send('Runtime.evaluate', { expression: `(async () => JSON.stringify(await (${expression})))()`, returnByValue: true, awaitPromise: true }),
    sleep(12000).then(() => null)
  ])
  if (r === null) throw new Error('Runtime.evaluate timed out after 12s (page wedged or WS disconnected)')
  const raw = r.result?.result?.value
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    throw new Error('evalJson: non-string value | expr: ' + (expression && expression.slice ? expression.slice(0, 140) : String(expression)) + ' | got: ' + String(JSON.stringify(r.result && r.result.result)).slice(0, 80))
  }
  try { return raw == null ? null : JSON.parse(raw) } catch (e) { throw new Error('evalJson parse fail: ' + String(raw).slice(0, 120) + ' | expr: ' + (expression && expression.slice ? expression.slice(0, 160) : String(expression).slice(0, 160))) }
}

/** 等待应用启动完成（侧边导航渲染 = 渲染端 OK；仅确认窗口存在则传 {shellOnly:true}） */
export async function waitBoot (ctx, { tries = 40, shellOnly = false } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const list = await (await fetch(ctx.cdp + '/json/list', { signal: AbortSignal.timeout(1500) })).json()
      const ok = shellOnly
        ? list.some(t => t.type === 'page')
        : list.some(t => t.type === 'page' && /#\/(todo-list|__widget\/list)/.test(t.url))
      if (ok) { await sleep(1500); return true }
    } catch { /* not ready */ }
    await sleep(500)
  }
  throw new Error('app boot timeout')
}
