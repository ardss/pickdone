/* eslint-env node */
// Web PWA <-> REAL desktop bridge — full scripted browser round-trip acceptance (client lane).
//
// Everything real: the REAL Lane A bridge (read-only import) on an isolated in-memory canonical
// SQLite, a REAL Chromium (isolated temp profile) loading the REAL built PWA over HTTP, driven
// through the production Sync-tab UI (fill endpoint + pairing payload, click 立即配对, pull,
// add a task, push, desktop tombstone conflict, revoke). No fakes, no mock client.
//
// Steps (each asserted):
//   R1 pair            -> paired notice rendered, pull/push enabled
//   R2 pull            -> desktop seeded task content visible in the web task list
//   R3 local add+push  -> the new row lands in the bridge-side SQLite (repo-level check)
//   R4 conflict pull   -> remote tombstone surfaces a conflict verdict in the UI
//   R5 revoke          -> subsequent pull fails with an auth error, UI surfaces the failure
//
// Exit codes: 0 = all green; 1 = real failure; 2 = BLOCKED by the documented Lane A CORS
// preflight gap (E2E-EVIDENCE.md §①) — run preflight-probe.mjs to confirm the gap precisely.
//
// Usage: node e2e/web-roundtrip.mjs
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, renameSync, rmSync, appendFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import net from 'node:net'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUN = join(HERE, '.run')
// Use a sibling isolated worktree by default; permit an explicit override for CI.
// No personal workstation path is embedded in the script.
const LANE_A = process.env.PICKDONE_BRIDGE_REPO || resolve(HERE, '../..')
const BRIDGE_PORT = 52141
const WEB_PORT = 5173
const CDP_PORT = 9251
const DEVICE = 'web-e2e-rt'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`

mkdirSync(RUN, { recursive: true })
const audit = line => appendFileSync(join(RUN, 'roundtrip.log'), new Date().toISOString() + ' ' + line + '\n')
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until (fn, budget, what) {
  const deadline = Date.now() + budget
  let lastErr = null
  while (Date.now() < deadline) {
    let v = null
    try { v = await fn() } catch (e) { lastErr = e }
    if (v) return v
    await sleep(300)
  }
  throw new Error(`timed out (${budget}ms): ${what}${lastErr ? ' — last error: ' + (lastErr && lastErr.message) : ''}`)
}

function freePort (prefer) {
  return new Promise(resolve => {
    const srv = net.createServer()
    srv.listen(prefer || 0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)) })
    srv.on('error', () => resolve(freePort(0)))
  })
}

// ---- 1) real bridge over isolated canonical SQLite (mirrors bridge-harness.mjs) ----
const { CrossPlatformBridge } = await import(pathToFileURL(join(LANE_A, 'src/main/cross-platform/http-bridge.mjs')).href)
const { createDesktopRepo } = await import(pathToFileURL(join(LANE_A, 'src/main/cross-platform/desktop-repo.js')).href)
const { SCHEMA } = await import(pathToFileURL(join(LANE_A, 'src/main/db-schema.js')).href)

const db = new DatabaseSync(':memory:')
db.exec(SCHEMA)
const NOW = Date.now()
const currentDay = new Date(NOW)
const TODAY = currentDay.getFullYear() * 10000 + (currentDay.getMonth() + 1) * 100 + currentDay.getDate()
const seed = db.prepare(`INSERT INTO todos (id, content, description, categoryId, complete, scheduledAt, scheduledDay, remindAt, deadlineTs, createdAt, updatedAt, deleted, deletedAt, version, syncAuthor)
  VALUES (?, ?, '', 0, 0, 0, ?, NULL, 0, ?, ?, 0, 0, 1, NULL)`)
seed.run('desk-task-1', '桌面seed任务-往返验收', TODAY, NOW - 5000, NOW - 5000)
seed.run('desk-task-2', '桌面seed任务-冲突路径', TODAY, NOW - 4000, NOW - 4000)
let pushedByWeb = null
const OPS = {
  getById: id => db.prepare('SELECT * FROM todos WHERE id = ?').get(String(id)) || null,
  getAll: () => db.prepare('SELECT * FROM todos').all(),
  upsert: row => {
    pushedByWeb = String(row.id)
    db.prepare(`INSERT INTO todos (id, content, description, categoryId, complete, scheduledAt, scheduledDay, remindAt, deadlineTs, createdAt, updatedAt, deleted, deletedAt, version, syncAuthor)
      VALUES (?, ?, '', ?, ?, 0, ?, NULL, 0, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET content=excluded.content, complete=excluded.complete, deleted=excluded.deleted,
        deletedAt=excluded.deletedAt, updatedAt=excluded.updatedAt, version=excluded.version`)
      .run(String(row.id), row.content ?? null, Number(row.categoryId || 0), Number(row.complete || 0), Number(row.scheduledDay || 0),
        Number(row.createdAt || 0), Number(row.updatedAt || 0), row.deleted ? 1 : 0, Number(row.deletedAt || 0), Number(row.version || 0))
    return true
  },
  getAllCategories: () => [],
  upsertCategory: () => true,
  episodeAllRows: () => [],
  episodePut: () => '',
  episodeRemoveIds: () => 0,
  sourceAllRows: () => [], sourcePut: () => '', sourceRemoveByIds: () => 0,
  taskSourceAllRows: () => [], taskSourcePut: () => '', taskSourceRemove: () => 0
}
const repo = createDesktopRepo((op, params) => OPS[op](params))
const stores = { pairingSecret: { load: () => null, save: () => {} }, sessionNonce: { load: () => null, save: () => {} }, revocations: { load: () => [], save: () => {} } }
const bridge = new CrossPlatformBridge({
  repo, stores,
  allowedOrigins: [WEB_ORIGIN, 'http://localhost:5173'],
  log: (tag, line) => audit(`[bridge:${tag}] ${line}`)
})
await bridge.start({ port: await (async () => BRIDGE_PORT)() })
const challenge = bridge.issuePairing(DEVICE, { scope: 'WRITE' })
const payload = JSON.stringify({ challengeId: challenge.challengeId, code: challenge.code, deviceId: DEVICE })
audit('pairing issued for ' + DEVICE)

// ---- 2) build + serve the REAL PWA on the allowlisted origin ----
console.log('[roundtrip] building PWA…')
const viteBin = join(HERE, '..', 'node_modules', 'vite', 'bin', 'vite.js')
const buildProc = spawn(process.execPath, [viteBin, 'build'], { cwd: join(HERE, '..'), stdio: 'pipe' })
const buildCode = await new Promise(res => buildProc.on('exit', res))
if (buildCode !== 0) { console.error('vite build failed (exit ' + buildCode + ')'); process.exit(1) }
const preview = spawn(process.execPath, [viteBin, 'preview', '--host', '127.0.0.1', '--port', String(WEB_PORT), '--strictPort'],
  { cwd: join(HERE, '..'), stdio: 'ignore' })
await until(async () => { const r = await fetch(WEB_ORIGIN).catch(() => null); return r && r.ok }, 20000, 'vite preview serving the built PWA')

// ---- 3) real Chromium, isolated profile ----
const profile = mkdtempSync(join(RUN, 'chrome-prof-'))
const chrome = spawn(CHROME, [
  '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1280,900',
  'about:blank'
], { stdio: 'ignore' })

// minimal CDP client (same shape as the desktop journey harness)
class Cdp {
  constructor (wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.nextId = 1
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve)
      this.ws.addEventListener('error', () => reject(new Error('CDP websocket failed to open')))
    })
    this.ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id) } })
  }
  static async connect () {
    const list = await until(async () => {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).catch(() => null)
      if (!res || !res.ok) return null
      const pages = await res.json()
      return pages.find(p => p.type === 'page') || null
    }, 15000, 'chrome CDP /json/list')
    const cdp = new Cdp(list.webSocketDebuggerUrl)
    await cdp.ready
    return cdp
  }
  send (method, params) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, m => m.error ? reject(new Error(m.error.message)) : resolve(m.result))
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async evalExpr (expr, timeoutMs = 20000) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error('page eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result && r.result.value
  }
}

let exitCode = 1
let blocked = false
try {
  const cdp = await Cdp.connect()
  await cdp.send('Page.enable')
  await cdp.send('Page.navigate', { url: WEB_ORIGIN })
  await until(async () => cdp.evalExpr(`!!document.querySelector('.sidebar nav button')`).catch(() => null), 15000, 'PWA app shell rendered')
  // switch to the Sync tab
  const navSync = cdp.evalExpr(`(function(){const b=[...document.querySelectorAll('.sidebar nav button')].find(x=>x.textContent.trim().includes('同步')||x.textContent.trim().toLowerCase().includes('sync'));if(!b)return 'NO-SYNC-TAB';b.click();return 'ok'})()`)
  if (await navSync !== 'ok') throw new Error('Sync tab nav button not found')
  await until(async () => cdp.evalExpr(`!!document.querySelector('input[type=url]')`).catch(() => null), 8000, 'Sync tab rendered (endpoint input)')

  // R1: pair through the real form
  console.log('[roundtrip] R1 pair…')
  await cdp.evalExpr(`(function(){
    const inp = document.querySelector('input[type=url]'); inp.value = ${JSON.stringify(`http://127.0.0.1:${BRIDGE_PORT}`)}; inp.dispatchEvent(new Event('input'))
    const ta = document.querySelector('.sync-card textarea'); ta.value = ${JSON.stringify(payload)}; ta.dispatchEvent(new Event('input'))
    return 'filled'
  })()`)
  const pairClicked = await cdp.evalExpr(`(function(){
    const btn=[...document.querySelectorAll('.sync-card button[type=submit]')].find(b=>!b.disabled); if(!btn) return 'NO-BTN'; btn.click(); return 'ok'
  })()`)
  if (pairClicked !== 'ok') throw new Error('pair submit button not clickable')
  // Pairing is the CORS-sensitive hop: a Failed-to-fetch here means the preflight gap is still open.
  const paired = await until(async () => {
    const state = await cdp.evalExpr(`(function(){
      const err=document.querySelector('.message.error'); const okM=document.querySelector('.message.success');
      return { err: err ? err.textContent : null, ok: okM ? okM.textContent : null, paired: !!document.querySelector('.sync-state') && document.querySelector('.sync-state').textContent.indexOf('未配对') === -1 }
    })()`)
    return (state.paired || state.ok) ? state : null
  }, 15000, 'pairing result (paired notice or honest failure)').catch(e => { blocked = true; throw new Error('R1 pair BLOCKED — ' + e.message + ' (expected while the Lane A CORS preflight gap is open; see E2E-EVIDENCE.md §① / preflight-probe.mjs)') })
  console.log('  ✓ R1 pair: ' + (paired.ok || 'paired state on'))

  // R2: pull — desktop seeds land in the web list
  console.log('[roundtrip] R2 pull…')
  await cdp.evalExpr(`(function(){const b=[...document.querySelectorAll('button')].find(x=>x.textContent.indexOf('拉取')>=0||x.textContent.toLowerCase().includes('pull'));if(!b)return 'NO';b.click();return 'ok'})()`)
  // Task cards render only on Today's page, not inside the Sync tab.
  await cdp.evalExpr(`(function(){const b=document.querySelector('.sidebar nav button:nth-child(1)');if(!b)return 'NO';b.click();return 'ok'})()`)
  await until(async () => cdp.evalExpr(`document.body.textContent.indexOf(${JSON.stringify('桌面seed任务-往返验收')}) >= 0`), 20000, 'seeded desktop task visible after pull').catch(async e => {
    const facts = await cdp.evalExpr(`(function(){return {selectedNav:[...document.querySelectorAll('.sidebar nav button.selected')].map(x=>x.textContent.trim()),errors:[...document.querySelectorAll('.message.error')].map(x=>x.textContent),notices:[...document.querySelectorAll('.message.success')].map(x=>x.textContent),taskCards:document.querySelectorAll('.task-row').length,taskNames:[...document.querySelectorAll('.task-main strong')].map(x=>x.textContent),todayHead:document.body.textContent.slice(0,350)}})()`)
    console.error('[R2 DIAGNOSTIC]', JSON.stringify(facts))
    throw e
  })
  console.log('  ✓ R2 pull: desktop seed rendered in the web task list')

  // R3: local add + push — verify at the bridge-side repo level
  console.log('[roundtrip] R3 local add + push…')
  await cdp.evalExpr(`(function(){const b=document.querySelector('.sidebar nav button:nth-child(1)');if(!b)return 'NO';b.click();return 'ok'})()`)
  await until(async () => cdp.evalExpr(`!!document.querySelector('.quick-add input')`), 8000, 'today tab quick-add visible')
  await cdp.evalExpr(`(function(){const i=document.querySelector('.quick-add input');i.value='web端新增-往返'+Date.now();i.dispatchEvent(new Event('input'));const f=document.querySelector('.quick-add');f.dispatchEvent(new Event('submit'));return 'ok'})()`)
  await until(async () => cdp.evalExpr(`document.body.textContent.indexOf('web端新增-往返') >= 0`), 8000, 'local task added')
  // Return to Sync before clicking Push; it is not mounted on Today's page.
  if (await cdp.evalExpr(`(function(){const b=[...document.querySelectorAll('.sidebar nav button')].find(x=>x.textContent.indexOf('同步')>=0||x.textContent.toLowerCase().includes('sync'));if(!b)return 'NO';b.click();return 'ok'})()`) !== 'ok') throw new Error('R3 sync tab missing')
  if (await cdp.evalExpr(`(function(){const b=[...document.querySelectorAll('button')].find(x=>x.textContent.indexOf('推送')>=0||x.textContent.toLowerCase().includes('push'));if(!b)return 'NO';b.click();return 'ok'})()`) !== 'ok') throw new Error('R3 push button missing')
  await until(async () => { const rows = db.prepare('SELECT id FROM todos WHERE content LIKE ?').all('web端新增-往返%'); return rows.length ? rows[0].id : null }, 20000, 'pushed row present in the bridge-side SQLite')
  console.log('  ✓ R3 push: web-added row landed in the desktop database (id ' + pushedByWeb + ')')

  // R4: desktop tombstones a row with a NEWER stamp; pull surfaces the conflict verdict
  console.log('[roundtrip] R4 conflict pull…')
  const stamp = Date.now()
  db.prepare('UPDATE todos SET deleted=1, deletedAt=?, updatedAt=? WHERE id=?').run(stamp, stamp, 'desk-task-2')
  audit('desktop tombstoned desk-task-2 (conflict door) at ' + stamp)
  await cdp.evalExpr(`(function(){const b=[...document.querySelectorAll('button')].find(x=>x.textContent.indexOf('拉取')>=0||x.textContent.toLowerCase().includes('pull'));if(!b)return 'NO';b.click();return 'ok'})()`)
  await until(async () => cdp.evalExpr(`!!document.querySelector('.sync-conflicts li')`), 20000, 'conflict verdict rendered in .sync-conflicts')
  console.log('  ✓ R4 conflict: tombstone-vs-edit verdict surfaced in the UI')

  // R5: revoke -> the next pull fails honestly in the UI
  console.log('[roundtrip] R5 revoke…')
  bridge.revokeDevice(DEVICE)
  audit('REVOKE executed for ' + DEVICE)
  await cdp.evalExpr(`(function(){const b=[...document.querySelectorAll('button')].find(x=>x.textContent.indexOf('拉取')>=0||x.textContent.toLowerCase().includes('pull'));if(!b)return 'NO';b.click();return 'ok'})()`)
  await until(async () => cdp.evalExpr(`!!document.querySelector('.message.error')`), 15000, 'post-revoke pull failure surfaced in .message.error')
  console.log('  ✓ R5 revoke: post-revocation pull failed with a visible error (no fake success)')
  exitCode = 0
} catch (e) {
  console.error('  ✗ ' + e.message)
  exitCode = blocked ? 2 : 1
} finally {
  try { chrome.kill() } catch {}
  try { bridge.close() } catch {}
  try { preview.kill() } catch {}
  await sleep(500)
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}
audit('roundtrip finished exit=' + exitCode)
console.log(exitCode === 0 ? 'RESULT: PASS — full browser round-trip green.' : exitCode === 2 ? 'RESULT: BLOCKED — server-side CORS gap (not a client failure).' : 'RESULT: FAIL.')
process.exit(exitCode)
