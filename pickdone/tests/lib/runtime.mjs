/**
 * 统一的「自拉起 Electron 隔离实例 + CDP 客户端」公共库。
 * 合并了 integration-ui.test.mjs / run-interactions-gated.mjs / ui-smoke.mjs 三处各自的实现
 * （2026-09-01 测试体系审计：三份实现已开始漂移——端口探测法不同、page 过滤不同、退出方式不同）。
 * 参数化：端口自动分配 / 隔离 userData（预置空 todos.db 跳过 legacy 迁移）/ --no-focus / 日志写文件。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

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

/** bind-then-release 探测空闲调试端口（比 probe-then-bind 更稳，run-interactions-gated 已验证）
 *  候选池横跨多个不连续段：WinNAT 保留段会随重启漂移，2026-09-23 实锤 9400-9799 整段被吞
 *  （bind 全拒 → 'no free debug port found'），单一连续池必然再撞。40 次尝试覆盖四段。 */
export async function pickFreePort () {
  const net = await import('node:net')
  const spans = [9400, 12000, 18000, 21000]
  for (let i = 0; i < 40; i++) {
    const span = spans[i % spans.length]
    const p = span + Math.floor(Math.random() * 400)
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
 *
 * Attach mode (2026-10-23 speed wave): when TODO_SHARED_CDP points at a live debug endpoint,
 * spawnApp returns an ATTACHED ctx without spawning anything — the shared live-pool runner
 * (tests/run-interactions-shared.mjs) owns the instance lifecycle. stopApp() on an attached
 * ctx only drops the WebSocket; the instance is NOT ours to kill.
 */
export async function spawnApp (opts = {}) {
  const attachCdp = process.env.TODO_SHARED_CDP
  if (attachCdp) {
    let port = 0
    try { port = Number(new URL(attachCdp).port) || 0 } catch { /* let connectCdp name the failure */ }
    return { child: null, port, cdp: attachCdp, userDataDir: null, logFile: null, attached: true }
  }
  const port = opts.port || await pickFreePort()
  const autoDir = !opts.userDataDir
  const userDataDir = opts.userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'todo-test-'))
  // 预置空 todos.db：新库直接走当前 SCHEMA，跳过 legacy 迁移分支（与 integration-ui 的 seed 语义一致）
  try { fs.writeFileSync(path.join(userDataDir, 'todos.db'), '') } catch {}
  if (autoDir) _tempUserDataDirs.add(userDataDir) // 自建临时目录登记,测试进程退出时统一清(复用外部目录的不动,重启持久化类测试还要读)
  // Isolation assertion (log-isolation fix): every app spawned through this helper MUST be
  // data-isolated — TODO_USER_DATA_DIR points into a temp dir, never at %APPDATA%/pickdone.
  // Failing loudly here keeps future tests from regressing to attaching the real user data
  // (and, via src/main/log-isolation.js, from leaking log lines into the real main.log).
  assert.ok(userDataDir && path.isAbsolute(userDataDir) && !path.resolve(userDataDir).toLowerCase().includes(process.env.APPDATA ? process.env.APPDATA.toLowerCase() : 'appdata'),
    `spawnApp refuses non-isolated userData dir: ${userDataDir}`)
  const logFile = path.join(ARTIFACTS, `${opts.name || 'app'}-app.log`)
  const baseArgs = opts.allowFocus ? [] : ['--no-focus']
  // 2026-10-24: per-instance sync port — without an override every spawned app binds the
  // FIXED default 3442, colliding with concurrently-running instances (unit tier's
  // lan-sync-journey pair rides the same gate). Ephemeral port per instance.
  const syncPort = await new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)) })
    srv.on('error', reject)
  })
  // strip ELECTRON_RUN_AS_NODE (same as the shared pool's bootInstance): harness/IDE host
  // shells export it → electron.exe boots as plain Node and dies in src/main/index.js.
  const env = { ...process.env, TODO_USER_DATA_DIR: userDataDir, TODO_SYNC_PORT: String(syncPort) }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(ELECTRON, ['.', ...baseArgs, '--remote-debugging-port=' + port, ...(opts.appArgs || []), ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], {
    cwd: APP_CWD,
    env,
    // app 输出写文件：node:test 会捕获 hook console，启动日志必须落盘可查
    stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')],
    detached: false
  })
  return { child, port, cdp: `http://127.0.0.1:${port}`, userDataDir, logFile }
}

/** 优雅退出（Browser.close 触发 before-quit/mirror flush）→ 超时 taskkill 整树（win32 必须防锁残留）
 *  attached ctx（TODO_SHARED_CDP 共享实例）只断 WS,绝不杀实例——生命周期归共享 runner 所有 */
export async function stopApp (ctx) {
  if (ctx.attached) {
    try { ctx._ws && ctx._ws.close() } catch {}
    ctx._ws = null
    return
  }
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
  // [load-budget 2026-10-25] wait for the tree to actually exit instead of a fixed
  // sleep(2500) (idle-host figure): under load the tree can outlive 2.5s and the next
  // step (dir deletion / port rebind) then trips over a dying process. Poll the OS for
  // pid liveness; the fixed floor stays as the WAL-flush settle.
  if (ctx.child && ctx.child.pid) {
    const dl = Date.now() + 20000
    while (Date.now() < dl) {
      try { process.kill(ctx.child.pid, 0); await sleep(200) } catch { break }
    }
  }
  await sleep(2500) // SQLite WAL settle floor (fs flush lag, not process lifetime)
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
        // bounded send: ws.send never rejects and a wedged/dead page never replies, so an
        // unbounded sendRaw parks the boot sequence forever (outside any caller budget).
        // Race each call against a 20s ceiling — a timeout rejects NAMED so the caller's
        // catch (or the probe loop below) degrades to its own wait logic (2026-10-27).
        const sendRawT = (method, params = {}) => Promise.race([
          sendRaw(method, params),
          sleep(20000).then(() => { throw new Error('timeout ' + method) })
        ])
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
        await sendRawT('Runtime.enable') // W15: bounded like every other call below — an unbounded sendRaw parked the boot forever on a wedged page
        ctx._ws = ws
        ctx._send = sendRaw
        ctx.consoleErrors = consoleErrors
        // 语言钉死 zh-CN:CI runner 系统语言 en-US,应用跟随系统变英文,全套中文选择器/文案断言全哑
        // (2026-09-06 公开 CI 实锤:body 文本以 "PickDone Completed…" 开头=导航已英文化)。pin appLocale=en-US (product default: en unless system zh) + reload + wait for shell ready.
        try {
          await sendRawT('Page.enable')
          await sendRawT('Runtime.evaluate', { expression: "try{localStorage.setItem('appLocale','en-US')}catch(e){}" })
          // plain reload — ignoreCache hangs under the app:// protocol (ui-smoke lesson, run-interactions-shared.mjs:176)
          await sendRawT('Page.reload')
          for (let i = 0; i < 40; i++) {
            const rr = await sendRawT('Runtime.evaluate', { expression: '!!window.appUI && !!document.querySelector(.app-shell-INIT)'.replace('.app-shell-INIT', String.fromCharCode(39) + '.app-shell' + String.fromCharCode(39)), returnByValue: true }).catch(() => null)
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

/** 页面内求值（JSON 序列化往返）
 *  [load-budget 2026-10-25] 60s (was 12s, idle-host figure): this is THE shared evaluation
 *  channel for every live target (ui-smoke/ui-coverage/cssom/overlay/integration-ui), and
 *  caller-side seeds chain multiple 1s-class sleeps inside one expression — under a full
 *  gate the whole IIFE legitimately ran past 12s and read as "page wedged". A truly wedged
 *  page still times out at the budget; the timeout message keeps the old shape. */
export async function evalJson (ctx, expression) {
  const r = await Promise.race([
    ctx._send('Runtime.evaluate', { expression: `(async () => JSON.stringify(await (${expression})))()`, returnByValue: true, awaitPromise: true }),
    sleep(60000).then(() => null)
  ])
  if (r === null) throw new Error('Runtime.evaluate timed out after 60s (page wedged or WS disconnected)')
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
      if (ok) {
        // [load-budget 2026-10-25] post-boot settle is CONDITIONAL now: the old fixed
        // sleep(1500) paid 1.5s on every fast boot AND still raced a slow renderer under
        // load. Poll for the renderer actually answering evaluations, floor 300ms.
        const settleDl = Date.now() + 8000
        while (Date.now() < settleDl) {
          await sleep(300)
          try {
            const probe = await Promise.race([
              (await fetch(ctx.cdp + '/json/list', { signal: AbortSignal.timeout(1500) })).json(),
              sleep(1200).then(() => null)
            ])
            if (probe && probe.some(t => t.type === 'page')) break
          } catch { /* still settling — keep polling */ }
        }
        return true
      }
    } catch { /* not ready */ }
    await sleep(500)
  }
  throw new Error('app boot timeout')
}
