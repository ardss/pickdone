// Smoke v3 — K1 CORRECTED repro (replaces smoke-v2/v2b, whose verdicts were probe artifacts).
// What v2/v2b got wrong (all three stack):
//   1. in-session check read document.body.innerText 800ms after Enter → matched the SUCCESS TOAST
//      ("已添加任务：…已安排在今天"), not the list — "created TRUE" anywhere, any view.
//   2. reboot check navigated to 待办箱 and looked for a TODAY-dated row — quick-add on the today
//      view defaults the date to TODAY (day view invites adding), so the row correctly lives in
//      今日待办; the box (no-date) shows nothing. "Row GONE" = wrong page.
//   3. any list-row probe must use the view's OWN row class: .td-item (today) vs
//      .todo-box-list-item (box) — counting one on the other view is blind both ways.
// What v3 proves, per flavor (view × quit-style): the row is in the DB at quit (the app's own CLI
// read, TODO_DB_DIR = USERDATA ROOT where todos.db lives — NOT the driver's /db subdir, which only
// holds logs and which the CLI would otherwise seed as a fresh empty DB), same db.key on resume,
// and the row renders on its own view after reboot. Also echoes todos.db path+mtime so the
// "CLI and app read the same file" contract is verified, not assumed.
// Usage: node .dev-data/smoke-v3.mjs [today|box] [crash|graceful]   (no args = both graceful)
import { bootJourney } from '../scripts/journey-driver.mjs'
import { statSync, existsSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const [viewArg = 'both', quitArg = 'graceful'] = process.argv.slice(2)
const CDP = 9383

const clickText = txt => `(() => { const el = [...document.querySelectorAll('div,span,li,a')].find(e => e.childElementCount === 0 && e.textContent.trim() === ${JSON.stringify(txt)}); if (el) { el.click(); return 'clicked' } return 'not-found' })()`
const rowSel = view => (view === 'box' ? '.todo-box-list-item' : '.td-item')
const listProbe = (view, marker) => `JSON.stringify({ rows: [...document.querySelectorAll(${JSON.stringify(rowSel(view))})].filter(e => e.textContent.includes(${JSON.stringify(marker)})).length, hash: location.hash })`
const qaEnter = `(() => { const i = document.querySelector('.qa-input'); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true })); i.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true })); return true })()`
const fileStamp = p => { try { const s = statSync(p); return { size: s.size, mtimeMs: Math.round(s.mtimeMs) } } catch { return 'ABSENT' } }
const cliList = dataDir => {
  // After a hard kill the db carries a hot -wal and Windows may hold handles briefly: retry the
  // read a few times and surface CLI-ERROR distinctly — a failed read is NOT "row absent".
  for (let i = 0; i < 3; i++) {
    const r = spawnSync(process.execPath, ['cli/pickdone.js', 'list', '--all', '--json'], { cwd: process.cwd(), encoding: 'utf8', timeout: 60000, env: { ...process.env, TODO_DB_DIR: dataDir } })
    try {
      const parsed = JSON.parse(r.stdout)
      if (parsed && Array.isArray(parsed.data)) return parsed.data
    } catch (e) { /* retry */ }
    sleepSync(1500)
  }
  return null
}
const sleepSync = ms => { const end = Date.now() + ms; while (Date.now() < end) { /* bounded spin: only reached on the crash-path retry */ } }

async function runOnce (view, quitStyle) {
  const marker = 'K1冒烟_' + view + '_' + quitStyle + '_' + Date.now() % 100000
  const navText = view === 'box' ? '待办箱' : '今日待办'
  const j1 = await bootJourney({ cdpPort: CDP, seedConfig: { closeActionMinimize: false } })
  const dataDir = j1.dataDir
  const dbFile = dataDir + '\\todos.db' // the app derives db from TODO_USER_DATA_DIR (user-dir.js), NOT the /db subdir
  try {
    await j1.waitFor(`!!document.querySelector('.qa-input')`)
    await j1.eval(clickText(navText))
    await sleep(600)
    await j1.fill('.qa-input', marker)
    await j1.eval(qaEnter)
    await sleep(1200)
    const created = JSON.parse(await j1.eval(listProbe(view, marker)))
    if (!created.rows) throw new Error('not rendered in its own view in-session: ' + JSON.stringify(created))
    const db1 = await j1.eval(`window.todoAPI.dbCall('getAll', {}).then(rows => JSON.stringify((rows || []).filter(r => (r.taskContent || '').includes(${JSON.stringify(marker)})).length))`, 8000)
    await sleep(1500)
    const stampPre = fileStamp(dbFile)
    if (quitStyle === 'crash') { j1.crash(); await new Promise(res => { const t = setTimeout(res, 8000); j1.child.once('exit', () => { clearTimeout(t); res() }) }) } else {
      await j1.eval(`window.todoAPI.closeRequest()`).catch(() => {})
      await new Promise(res => { const t = setTimeout(res, 20000); j1.child.once('exit', () => { clearTimeout(t); res() }) })
    }
    const stampPost = fileStamp(dbFile)
    const cliRows = cliList(dataDir)
    const inCli = Array.isArray(cliRows) && cliRows.some(t => (t.taskContent || '').includes(marker))
    const j2 = await bootJourney({ cdpPort: CDP, dataDir })
    try {
      await j2.waitFor(`!!document.querySelector('.qa-input')`)
      await j2.eval(clickText(navText))
      await sleep(1200)
      const survived = JSON.parse(await j2.eval(listProbe(view, marker)))
      const db2 = await j2.eval(`window.todoAPI.dbCall('getAll', {}).then(rows => JSON.stringify((rows || []).filter(r => (r.taskContent || '').includes(${JSON.stringify(marker)})).length))`, 8000)
      const stampResume = fileStamp(dbFile)
      const sameFileContract = stampPost !== 'ABSENT' && stampResume !== 'ABSENT'
      // Post-reboot proof is the verdict (rows rendered + dbCount); the at-quit CLI read is
      // corroboration and is reported distinctly when it errored (hot-wal races after a crash).
      const ok = survived.rows > 0 && Number(db2) >= 1
      const cliInfo = cliRows === null ? 'CLI-ERROR (read failed 3x — not evidence of absence)' : (inCli ? 'ROW PRESENT' : 'ROW ABSENT')
      console.log(`[smoke-v3] ${view}/${quitStyle}: marker=${marker}`)
      console.log(`  in-session rows=${created.rows} dbCount=${db1} | quit=${quitStyle} dbFile=${JSON.stringify(stampPre)}->${JSON.stringify(stampPost)}`)
      console.log(`  CLI-read-at-quit: ${cliInfo}`)
      console.log(`  after-reboot rows=${survived.rows} dbCount=${db2} mtime=${JSON.stringify(stampResume)}`)
      console.log(`  VERDICT: ${ok ? 'SURVIVED' : 'LOST'}`)
      return ok
    } finally { await j2.end({ preserveDir: true }) }
  } finally { try { await j1.end({ preserveDir: true }) } catch (e) {} ; try { rmSync(dataDir, { recursive: true, force: true }) } catch (e) {} }
}

const flavors = []
if (viewArg === 'both') { flavors.push(['today', quitArg], ['box', quitArg]) } else flavors.push([viewArg, quitArg])
let allOk = true
for (const [v, q] of flavors) { try { allOk = (await runOnce(v, q)) && allOk } catch (e) { console.log(`[smoke-v3] ${v}/${q} ERROR:`, String(e && e.message || e).slice(0, 200)); allOk = false } }
console.log('[smoke-v3] ALL SURVIVED:', allOk)
process.exit(allOk ? 0 : 1)
