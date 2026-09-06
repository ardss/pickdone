#!/usr/bin/env node
/**
 * End-to-end full-feature walkthrough (CDP driving the real App) — the last line of defense before release
 * Usage: node cli/e2e-walkthrough.js
 * Prerequisite: the App runs with --remote-debugging-port=9333 (diagnostics on lock conflict, exit 2)
 * Script: create task → assert DOM/loading → complete → undo → reschedule → recycle bin → restore → delete again → hard-delete cleanup
 * Data self-cleans throughout (probe task hard-deleted); assertion failure exits non-zero
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

// Fail-fast data-isolation gate: this script spawns the real App and mutates data via the store.
// Never touch the user's real database by default — require an explicit isolation dir.
function assertIsolationEnv () {
  if (process.env.TODO_DB_DIR || process.env.TODO_USER_DATA_DIR) return
  console.error('[data-safety] Refusing to run without an isolated data directory.')
  console.error('  This walkthrough spawns the real App and writes through its store; without isolation it would write your real data.')
  console.error('  Set one of the following before running:')
  console.error('    PowerShell:  $env:TODO_USER_DATA_DIR = "$env:TEMP\\pickdone-e2e"; node cli/e2e-walkthrough.js')
  console.error('    bash:        TODO_USER_DATA_DIR=/tmp/pickdone-e2e node cli/e2e-walkthrough.js')
  console.error('  (TODO_DB_DIR=<data dir containing todos.db> also works, legacy CLI-only form)')
  process.exit(1)
}
assertIsolationEnv()

let failed = 0
function ok (name, cond, detail = '') {
  if (cond) console.log('  ✓ ' + name)
  else { failed++; console.error('  ✗ ' + name + (detail ? ' — ' + String(detail).slice(0, 200) : '')) }
}

async function ensureApp () {
  for (let i = 0; i < 2; i++) {
    try {
      // Wait for the page target to appear (browser starts first, page created later; /json/list may briefly return an empty array)
      for (let t = 0; t < 20; t++) {
        const l = await getJSON('/json/list')
        if (Array.isArray(l) && l.some(x => x.type === 'page')) return
        await sleep(1000)
      }
      return
    } catch { /* retry */ }
    if (i === 0) {
      console.log('starting App (CDP mode)...')
      const child = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'electron', 'cli.js'), '.', '--remote-debugging-port=' + PORT], { cwd: ROOT, detached: true, stdio: 'ignore' })
      child.unref()
      // Zombie guard: a detached spawn with no owner outlives this gate and pollutes port 9333 for every later CDP probe — always reap on exit
      spawnedChild = child
      process.on('exit', killSpawnedChild)
    }
    await sleep(8000)
  }
  const hasApp = await new Promise(res => execFile('tasklist', ['/FI', 'IMAGENAME eq electron.exe'], (e, out) => res(!e && /electron/i.test(out || ''))))
  if (hasApp) {
    console.error('App is running but not in CDP mode (single-instance lock held). Close the existing App window and retry.')
    process.exit(2)
  }
  throw new Error('CDP port wait timed out and no running App was detected')
}

async function main () {
  await ensureApp()
  const list = await getJSON('/json/list')
  // Float windows and other child windows also load index.html; prefer the main window (hash route)
  const page = list.find(t => t.type === 'page' && t.url.includes('#/todo-list')) || list.find(t => t.type === 'page' && !t.url.includes('__tomato-float'))
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0; const pending = new Map(); const exceptions = []
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return }
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(((m.params.exceptionDetails.exception?.description || '')).slice(0, 200))
  }
  await new Promise((r) => { ws.onopen = () => r() })
  await send('Runtime.enable')
  const evalJS = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error('EXC: ' + (r.exceptionDetails.exception?.description || '').slice(0, 300))
    return r.result.value
  }

  await send('Page.enable')
  await send('Page.reload')
  let readyOk = false
  for (let i = 0; i < 20; i++) {
    try {
      const ready = await send('Runtime.evaluate', { expression: '!!(window.appUI && window.appUI.$store && window.appUI.$store.state.todo.todoList)', returnByValue: true })
      if (ready.result && ready.result.value === true) { readyOk = true; break }
    } catch (e) { /* page still navigating */ }
    await sleep(1500)
  }
  console.log('appUI ready:', readyOk)
  if (!readyOk) console.error('target URL:', page.url)
  await sleep(1000)

  const store = 'window.appUI.$store'
  const probe = 'E2E冒烟_' + Date.now()

  console.log('[0] baseline')
  // 空隔离目录(首跑/独立跑)本来就没有任务:baseline=0 不是"store 未加载",
  // 自播一条基线任务再断言,门禁不再依赖前序门禁留下的脏数据(2026-09-05 深审)
  let baseline = await evalJS(`${store}.state.todo.todoList.length`)
  if (baseline === 0) {
    await evalJS(`${store}.dispatch('todo/addTodo', { todoContent: 'E2E基线_' + Date.now(), todoDate: +window.dayjs().endOf('day') })`)
    await sleep(600)
    baseline = await evalJS(`${store}.state.todo.todoList.length`)
  }
  ok('store loaded', baseline > 0, 'got ' + baseline)

  console.log('[1] create task')
  await evalJS(`${store}.dispatch('todo/addTodo', { todoContent: ${JSON.stringify(probe)}, todoDate: +window.dayjs().endOf('day') })`)
  await sleep(600)
  const added = await evalJS(`(function(){const l=${store}.state.todo.todoList;const t=l.find(x=>x.taskContent===${JSON.stringify(probe)});return t?JSON.stringify({taskId:t.taskId,dayStart:t.dayStart,status:t.status}):'null'})()`)
  const addedObj = JSON.parse(added)
  ok('task created and landed in store', !!addedObj, added)
  ok('status=add（I5）', addedObj && addedObj.status === 'add')
  const tid = addedObj && addedObj.taskId
  ok('view rendered (not blank)', await evalJS('document.body.innerText.trim().length > 50'), 'innerText len=' + (await evalJS('document.body.innerText.trim().length')))

  console.log('[2] complete semantics (I4/III2)')
  await evalJS(`(function(){const s=${store};const t=s.state.todo.todoList.find(x=>x.taskId===${JSON.stringify(tid)});return s.dispatch('todo/toggleComplete',t)})()`)
  await sleep(600)
  const doneState = JSON.parse(await evalJS(`(function(){const a=${store}.state.todo.todoList.concat(${store}.state.todo.recycleList);const t=a.find(x=>x.taskId===${JSON.stringify(tid)});return t?JSON.stringify({complete:t.complete,completedAt:t.completedAt}):'null'})()`))
  ok('complete=true and completedAt>0 (I4)', doneState && doneState.complete && doneState.completedAt > 0, JSON.stringify(doneState))

  console.log('[3] undo complete')
  await evalJS(`(function(){const s=${store};const t=s.state.todo.todoList.find(x=>x.taskId===${JSON.stringify(tid)});return s.dispatch('todo/toggleComplete',t)})()`)
  await sleep(600)
  ok('completedAt reset to 0', await evalJS(`(function(){const t=${store}.state.todo.todoList.find(x=>x.taskId===${JSON.stringify(tid)});return t&&!t.complete&&t.completedAt===0})()`))

  console.log('[4] reschedule (I6 derived)')
  const tomorrow = await evalJS(`+window.dayjs().add(1,'day')`)
  await evalJS(`${store}.dispatch('todo/updateTodoFields',{taskId:${JSON.stringify(tid)},patch:{todoTime:${tomorrow}}})`)
  await sleep(600)
  ok('dayStart derived correctly', await evalJS(`(function(){const t=${store}.state.todo.todoList.find(x=>x.taskId===${JSON.stringify(tid)});return t&&t.dayStart===+window.dayjs(${tomorrow}).startOf('day')})()`))

  console.log('[5] recycle-bin round trip')
  await evalJS(`${store}.dispatch('todo/deleteTodo', { taskId: ${JSON.stringify(tid)} })`)
  await sleep(600)
  ok('soft delete (status=delete)', await evalJS(`(function(){const t=${store}.state.todo.recycleList.find(x=>x.taskId===${JSON.stringify(tid)});return t&&t.delete&&t.status==='delete'})()`))
  await evalJS(`${store}.dispatch('todo/restoreFromRecycle', { taskId: ${JSON.stringify(tid)} })`)
  await sleep(600)
  const restored = await evalJS(`(function(){const a=${store}.state.todo.todoList.concat(${store}.state.todo.recycleList);const t=a.find(x=>x.taskId===${JSON.stringify(tid)});return t?JSON.stringify({del:t.delete,st:t.status}):'gone'})()`)
  ok('restore', (() => { try { const o = JSON.parse(restored); return o.del === false } catch { return false } })(), restored)

  console.log('[6] statistics page navigation without exceptions')
  await evalJS('location.hash = "#/todo-list/statistics"; "ok"')
  await sleep(2000)
  ok('statistics page mounted', await evalJS('!!document.querySelector(".stat-page")'))

  console.log('[7] clean up probe data')
  await evalJS(`window.todoAPI.dbCall('hardDelete', ${JSON.stringify(tid)})`)
  await evalJS(`${store}.dispatch('todo/init')`)
  await sleep(800)
  ok('probe cleaned up', await evalJS(`!${store}.state.todo.todoList.concat(${store}.state.todo.recycleList).some(x=>x.taskId===${JSON.stringify(tid)})`))

  console.log('[8] runtime exceptions throughout (V3)')
  ok('0 exceptions', exceptions.length === 0, exceptions.slice(0, 3).join(' | '))

  if (failed) { console.error(`\n== ${failed} failed ==`); process.exitCode = 1 }
  else console.log('\n== all end-to-end walkthrough checks passed ==')
  process.exit(process.exitCode || 0)
}

main().catch(e => { console.error('walkthrough failed:', e.message); process.exit(1) })
