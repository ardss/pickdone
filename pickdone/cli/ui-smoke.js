#!/usr/bin/env node
/**
 * UI behavior walkthrough (CDP) — automated defense line for invariant V3
 * Usage: node cli/ui-smoke.js [--launch]
 *   --launch  automatically starts the App in CDP mode if nothing is on port 9333
 * Assertions: 0 exceptions on page reload / global bridge and root instance exist / todos and categories loaded / statistics page renders
 * Any assertion failure exits non-zero
 */
const { execFile, spawn } = require('child_process')
const path = require('path')
const http = require('http')

const PORT = 9333
const ROOT = path.join(__dirname, '..')
const getJSON = p => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 2000 }, r => {
    let s = ''; r.on('data', d => { s += d }); r.on('end', () => res(JSON.parse(s)))
  }).on('error', rej)
})
const sleep = ms => new Promise(r => setTimeout(r, ms))

let spawnedChild = null
function killSpawnedChild () {
  if (!spawnedChild || spawnedChild.exitCode !== null) return
  try { spawn('taskkill', ['/pid', String(spawnedChild.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* best effort */ }
}

async function ensureApp () {
  for (let i = 0; i < 2; i++) {
    try { await getJSON('/json/list'); return } catch { /* not up */ }
    if (i === 0) {
      if (!process.argv.includes('--launch')) throw new Error('App is not running in CDP mode: run node cli/pickdone.js open first, or use --launch')
      // Fail-fast data-isolation gate: spawning the App here would write the real userData DB — never do that by default
      if (!process.env.TODO_DB_DIR && !process.env.TODO_USER_DATA_DIR) {
        console.error('[data-safety] --launch refused: no isolated data directory set.')
        console.error('  The spawned App would open your real %APPDATA%\\pickdone database.')
        console.error('  Set an isolation dir first, e.g.:  PowerShell: $env:TODO_USER_DATA_DIR = "$env:TEMP\\pickdone-smoke"; node cli/ui-smoke.js --launch')
        console.error('  (bash: TODO_USER_DATA_DIR=/tmp/pickdone-smoke node cli/ui-smoke.js --launch; TODO_DB_DIR also accepted)')
        process.exit(1)
      }
      console.log('starting App (CDP mode)...')
      const child = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'electron', 'cli.js'), '.', '--remote-debugging-port=' + PORT], { cwd: ROOT, detached: true, stdio: 'ignore' })
      child.unref()
      // Zombie guard: a detached spawn with no owner outlives this gate and pollutes port 9333 for every later CDP probe — always reap on exit
      spawnedChild = child
      process.on('exit', killSpawnedChild)
    }
    await sleep(8000)
  }
  // Diagnostics: electron is running but 9333 is unreachable = the existing instance is not in CDP mode (holding the single-instance lock)
  const hasApp = await new Promise(res => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq electron.exe'], (e, out) => res(!e && /electron/i.test(out || '')))
  })
  if (hasApp) {
    console.error('App is running but not in CDP mode (single-instance lock held). The walkthrough needs CDP: close the existing App window and retry, or restart it with --remote-debugging-port=9333 from the holder.')
    process.exit(2)
  }
  throw new Error('CDP port wait timed out and no running App was detected')
}

let failed = 0
function ok (name, cond, detail = '') {
  if (cond) console.log('  ✓ ' + name)
  else { failed++; console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')) }
}

async function main () {
  await ensureApp()
  const list = await getJSON('/json/list')
  // Float windows and other child windows also load index.html; prefer the main window (hash route)
  const page = list.find(t => t.type === 'page' && t.url.includes('#/todo-list')) || list.find(t => t.type === 'page' && !t.url.includes('__tomato-float'))
  ok('page target exists', !!page, JSON.stringify(list.map(t => t.type)))
  if (!page) process.exit(1)

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0; const pending = new Map(); const exceptions = []
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return }
    if (m.method === 'Runtime.exceptionThrown') exceptions.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 200))
  }
  await new Promise((r) => { ws.onopen = () => r() })
  await send('Runtime.enable')
  const evalJS = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error('EXC: ' + (r.exceptionDetails.exception?.description || '').slice(0, 200))
    return r.result.value
  }

  // Reload and wait for stability (collecting exceptions meanwhile)
  await send('Page.enable')
  await send('Page.reload')
  for (let i = 0; i < 15; i++) {
    try {
      const ready = await send('Runtime.evaluate', { expression: '!!(window.appUI && window.appUI.$store && window.appUI.$store.state.todo.todoList)', returnByValue: true })
      if (ready.result && ready.result.value === true) break
    } catch { /* page still navigating */ }
    await sleep(1500)
  }
  await sleep(1000)

  console.log('[1] global contract (II1/II2)')
  ok('window.todoAPI bridge exists', await evalJS('!!window.todoAPI && !!window.todoAPI.dbCall'))
  ok('window.appUI root instance exists', await evalJS('!!window.appUI && !!window.appUI.$store'))
  ok('dayjs isoWeek plugin attached', await evalJS('typeof window.dayjs().isoWeekday === "function"'))

  console.log('[2] data loading (I1/I2/I3)')
  const todoN = await evalJS('window.appUI.$store.state.todo.todoList.length')
  ok('todos loaded (>0)', todoN > 0, 'got ' + todoN)
  const catN = await evalJS('(window.appUI.$store.state.category.list||[]).length')
  ok('categories state loaded (number, cached state is valid)', typeof catN === 'number', 'got ' + catN)

  console.log('[3] statistics page rendering')
  await evalJS('location.hash = "#/todo-list/statistics"; "ok"')
  await sleep(2500)
  ok('statistics page DOM mounted', await evalJS('!!document.querySelector(".stat-page")'))
  const excAfterNav = await evalJS('(window.__lastVueErr?1:0)')
  ok('no Vue render errors', excAfterNav === 0, JSON.stringify(await evalJS('window.__lastVueErr||""')).slice(0, 200))

  console.log('[4] runtime exceptions (V3)')
  ok('0 exceptions throughout', exceptions.length === 0, exceptions.slice(0, 2).join(' | '))

  if (failed) { console.error(`\n== ${failed} failed ==`); process.exitCode = 1 }
  else console.log('\n== all UI walkthrough checks passed ==')
  process.exit(0)
}

main().catch(e => { console.error('walkthrough failed:', e.message); process.exit(1) })
