/**
 * smoke:interact gate wrapper - fixes the false-green gate caused by "SKIP = exit 0":
 * running ui-interactions.mjs directly in check:all SKIPs with exit 0 when no debug-port instance exists, making the defense useless.
 * This wrapper: runs directly if an instance already exists (TODO_CDP/9333); otherwise it spawns an isolated instance itself (separate userData + a random free port,
 * same pattern as integration-ui), kills it when done, and passes the exit code through.
 */
import { spawn, execSync } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const appCwd = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
const ELECTRON = process.platform === 'win32'
  ? path.join(appCwd, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(appCwd, 'node_modules', 'electron', 'dist', 'electron')

async function cdpAlive (url) {
  try { await fetch(url + '/json/list', { signal: AbortSignal.timeout(800) }); return true } catch { return false }
}

async function pickFreePort () {
  // Bind-then-release: the old probe-then-bind raced between probe and Electron's actual listen,
  // two parallel instances could pick the same port and both "succeeded"
  for (let i = 0; i < 12; i++) {
    const p = await new Promise((res, rej) => {
      const srv = net.createServer()
      srv.listen(0, '127.0.0.1', () => { const port = srv.address().port; srv.close(() => res(port)) })
      srv.on('error', rej)
    })
    if (!(await cdpAlive(`http://127.0.0.1:${p}`))) return p
  }
  throw new Error('no free debug port found')
}

// Usage: node tests/run-interactions-gated.mjs [script path] (defaults to tests/ui-interactions.mjs)
const SCRIPT = process.argv[2] || 'tests/ui-interactions.mjs'
const run = () => new Promise(res => {
  const child = spawn(process.execPath, [SCRIPT], {
    cwd: appCwd,
    env: { ...process.env, TODO_CDP: CDP },
    stdio: 'inherit'
  })
  child.on('exit', code => res(code ?? 1))
})

let CDP = process.env.TODO_CDP || 'http://127.0.0.1:9333'
let child = null
let tmpDir = null
// exit 钩子兜底:任何早退路径(实例25s未就绪/用例超时/异常)都必须杀掉隔离实例+清临时目录,
// 否则孤儿 Electron 持续占 CPU/DB 锁并污染下一轮门禁(2026-09-05 二轮审查 P1)
function reapIsolated () {
  if (child && process.platform === 'win32') { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch {} }
  if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 }) } catch {} }
}
process.on('exit', reapIsolated)
// Isolated-instance-by-default (2026-09-01): reusing a live 9333 instance reads/writes the developer's REAL
// database and inherits arbitrary UI state (open EditPanel swallowed every real click once; keyboard-e2e
// even persisted its sample task into the dev DB). Reuse is now opt-in via TODO_ALLOW_REUSE=1.
const ALLOW_REUSE = process.env.TODO_ALLOW_REUSE === '1'
if (ALLOW_REUSE && await cdpAlive(CDP)) {
  console.log('[gate] reusing the existing debug instance ' + CDP + ' (TODO_ALLOW_REUSE=1; writes may land in the real DB)')
} else {
  if (!ALLOW_REUSE && await cdpAlive(CDP)) console.log('[gate] a live instance exists on ' + CDP + ' but reuse is opt-in (TODO_ALLOW_REUSE=1); spawning an isolated instance instead')
  const port = await pickFreePort()
  CDP = `http://127.0.0.1:${port}`
  console.log('[gate] spawning an isolated instance ' + CDP)
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-smoke-'))
  // 按脚本名+pid 分文件:check:all 并行跑多个活体门禁时,共享单 log 会交错成乱码(2026-09-06 并行化配套)
  fs.mkdirSync(appCwd + '/tests/.artifacts', { recursive: true })
  const logFile = appCwd + '/tests/.artifacts/smoke-' + path.basename(SCRIPT).replace(/\W+/g, '-') + '-' + process.pid + '.log'
  child = spawn(ELECTRON, ['.', '--no-focus', '--remote-debugging-port=' + port], {
    cwd: appCwd,
    env: { ...process.env, TODO_USER_DATA_DIR: tmpDir },
    stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')]
  })
  // Wait for the instance to be ready (up to 60s:CI runner 冷启动 Electron 可超 25s,2026-09-06 公开 CI 实锤)
  let up = false
  for (let i = 0; i < 60; i++) { if (await cdpAlive(CDP)) { up = true; break } await new Promise(r => setTimeout(r, 1000)) }
  if (!up) { console.error('FAIL: isolated instance not ready within 60s'); process.exit(1) }
  await new Promise(r => setTimeout(r, 2000)) // wait for the renderer to boot
}

// run() 自身看门狗:check:all 的 15 分钟阶段超时在 win32 shell:true 下只杀得掉中间 shell,
// 杀不到本脚本 spawn 的 Electron——wrapper 必须自带超时自裁(10 分钟=最长用例链的充足余量)
const code = await Promise.race([
  run(),
  new Promise(res => setTimeout(() => { console.error('FAIL: gate exceeded 10min watchdog — reaping isolated instance'); res(1) }, 10 * 60 * 1000))
])
reapIsolated()
child = null; tmpDir = null
process.exit(code)
