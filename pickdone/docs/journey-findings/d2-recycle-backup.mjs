/**
 * d2-crosscutting-auditor — round-2 backup + recycle-retention live proof.
 *
 * [D2-RECYCLE] recycle-bin auto-purge: CLI-seed two tasks into an ISOLATED db dir, soft-delete
 * both, backdate ONE row's deletedAt 40 days through the app's own db layer (upsert, no raw
 * SQL), then boot a real instance: purgeExpiredRecycle (store/todo.js, runs on computeViews,
 * cutoff = today-midnight − settings.recycleBinAutoDeleteDays, default 30) must hard-delete the
 * stale row and keep the fresh one.
 * [D2-BACKUP] auto-backup: trigger the REAL renderer backup path (dispatch 'todo/writeAutoBackup'
 * — the exact action SettingsDataTab.runAutoBackupNow uses) and verify auto-*.json lands in
 * <userData>/backups (backup-roots.cjs default candidate #1). Restore path is code-cited, NOT
 * executed (nothing is restored over any data).
 */
import { bootJourney } from '../../scripts/journey-driver.mjs'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, 'shots')
const require = createRequire(import.meta.url)
const APP = join(HERE, '..', '..') // pickdone app root (docs/journey-findings → pickdone)
const out = { steps: [] }
const step = (n, d) => { out.steps.push({ n, d }); console.log('[d2-rb]', n, d === undefined ? '' : JSON.stringify(d).slice(0, 400)) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---- 1. isolated dir + CLI seeding ----
// Path contract (the lead's driver-fix finding): the CLI resolves the db via TODO_DB_DIR (the dir
// that CONTAINS todos.db) while the APP derives it from TODO_USER_DATA_DIR (<userData>/todos.db,
// src/main/index.js:338 dbm.init(app.getPath('userData'))). Seeding with TODO_DB_DIR=<base> and
// booting with resumeDir=<base> makes BOTH sides open base/todos.db.
const base = await mkdtemp(join(tmpdir(), 'd2-recycle-'))
const cliEnv = { ...process.env, TODO_DB_DIR: base, TODO_USER_DATA_DIR: base }
delete cliEnv.ELECTRON_RUN_AS_NODE
const cli = (args) => {
  const r = spawnSync(process.execPath, [join(APP, 'cli', 'pickdone.js'), ...args], { env: cliEnv, encoding: 'utf8', cwd: APP })
  if (r.status !== 0) throw new Error('cli ' + args.join(' ') + ' failed: ' + (r.stdout || '') + (r.stderr || ''))
  return r.stdout
}
cli(['add', 'Stale recycled task'])
cli(['add', 'Fresh recycled task'])
const listOut = JSON.parse(cli(['list', '--all', '--json'])) // default range is 'today'; box rows need --all
const rows = listOut.data || listOut.rows || [] // pickdone.js --json wraps: { ok, command, data }
const findId = c => (rows.find(r => (r.taskContent || r.content || '').includes(c)) || {}).taskId
const idStale = findId('Stale recycled task')
const idFresh = findId('Fresh recycled task')
step('cli-seeded', { idStale, idFresh, totalRows: rows.length })
if (!idStale || !idFresh) throw new Error('could not resolve seeded ids')

cli(['delete', idStale])
cli(['delete', idFresh])

// ---- 2. backdate the stale row through the app's OWN db layer ----
const backdate = `
process.env.TODO_DB_DIR = ${JSON.stringify(base)}
process.env.TODO_USER_DATA_DIR = ${JSON.stringify(base)}
const { userDataDir } = require(${JSON.stringify(join(APP, 'src', 'main', 'user-dir.js'))})
const dbm = require(${JSON.stringify(join(APP, 'src', 'main', 'db.js'))})
dbm.init(userDataDir())
const rows = dbm.call('getAll', {}) // getAll returns ALL rows incl. soft-deleted (the renderer init source); queryTodos filters deleted out
const victim = rows.find(r => (r.taskContent || '').includes('Stale recycled task'))
if (!victim) throw new Error('victim not found; rows=' + rows.length)
const stale = Date.now() - 40 * 86400000
const r = dbm.call('upsert', Object.assign({}, victim, { deletedAt: stale, delete: true, status: 'delete' }))
const after = dbm.call('getAll', {}).find(x => x.taskId === victim.taskId)
console.log(JSON.stringify({ patched: !!r || r === undefined ? true : r, deletedAtNow: after && after.deletedAt, staleTarget: stale }))
`
const bd = spawnSync(process.execPath, ['-e', backdate], { env: cliEnv, encoding: 'utf8', cwd: APP })
if (bd.status !== 0) throw new Error('backdate failed: ' + (bd.stderr || bd.stdout))
const bdOut = JSON.parse((bd.stdout.match(/\{.*\}/) || ['{}'])[0])
step('backdated-stale-row', bdOut)
if (!bdOut.deletedAtNow || bdOut.deletedAtNow > Date.now() - 39 * 86400000) throw new Error('backdate did not stick (stamp is not >=39d old): ' + JSON.stringify(bdOut))

// ---- 3. boot the real instance on the SAME db file (app userData = base) ----
// NOTE: the driver's option key is `dataDir` (the header's "resumeDir" is the concept, not the key)
const j = await bootJourney({ cdpPort: 9384, dataDir: base })
try {
  await j.waitFor('window.appUI && window.appUI.$store && window.appUI.$store.state.todo')
  await sleep(3500) // computeViews → purgeExpiredRecycle (once/local-day; fresh LS = runs now)
  const st = JSON.parse(await j.eval(`(async () => {
    const s = window.appUI.$store
    let all = null; let allErr = null
    try { all = (await window.todoAPI.dbCall('getAll', {})).length } catch (e) { allErr = String(e).slice(0, 120) }
    return JSON.stringify({
      recycle: (s.state.todo.recycleList || []).map(t => ({ c: t.taskContent, deletedAt: t.deletedAt })),
      live: (s.state.todo.todoList || []).map(t => t.taskContent),
      settingsDays: s.state.settings.recycleBinAutoDeleteDays,
      initError: s.state.todo.initError || null,
      getAllCount: all, getAllErr: allErr })
  })()`))
  step('after-boot-state', st)
  out.recycle = st
  const staleGone = !st.recycle.some(t => /Stale recycled task/.test(t.c)) && !st.live.some(c => /Stale recycled task/.test(c)) && st.getAllCount === st.recycle.length + st.live.length
  const freshKept = st.recycle.some(t => /Fresh recycled task/.test(t.c))
  out.recycleVerdict = { staleGone, freshKept }
  step('D2-RECYCLE verdict', out.recycleVerdict)
  await j.eval(`location.hash = '#/todo-list/recycle-bin'; true`)
  await sleep(1200)
  await j.shot(join(SHOTS, 'd2-recycle-after-purge.png')).catch(() => {})

  // ---- 4. live auto-backup through the REAL renderer action ----
  const bk = await j.eval(`window.appUI.$store.dispatch('todo/writeAutoBackup').then(r => JSON.stringify({ ok: r }))`)
  step('writeAutoBackup dispatched', bk)
  await sleep(2000)
  const bdir = join(j.dataDir, 'backups')
  if (existsSync(bdir)) {
    const files = await readdir(bdir)
    out.backup = { dir: bdir, files: files.slice(0, 10), autoCount: files.filter(f => /^auto-/.test(f)).length }
    const newest = files.filter(f => /^auto-/.test(f)).sort().pop()
    if (newest) {
      const head = await readFile(join(bdir, newest), 'utf8')
      out.backup.newestHead = head.slice(0, 220)
    }
  } else {
    // fallback candidates (backup-roots.cjs order)
    out.backup = { dirMissing: bdir, userDataListed: existsSync(j.dataDir) ? (await readdir(j.dataDir)).slice(0, 20) : null }
  }
  step('D2-BACKUP result', out.backup)
} finally {
  await j.end().catch(() => {})
}

await writeFile(join(HERE, 'd2-recycle-backup-log.json'), JSON.stringify(out, null, 1), 'utf8')
console.log('D2-RECYCLE:', JSON.stringify(out.recycleVerdict))
console.log('D2-BACKUP:', JSON.stringify(out.backup).slice(0, 500))
