/* Round-2 Journey R2A6: isolate the past-due catch-up anomaly (v2 + v4b both showed
   "0 missed reminders re-fired" for a past-due task seeded via CLI while the app was closed).
   Leg 1: boot → CLI-add PAST-due task while RUNNING → does the write-path catch-up fire it?
   Leg 2: crash → CLI-add Q PAST-due while closed → boot2 → does the BOOT catch-up fire it?
   Also dumps queryTodos + the scheduler watermark meta at each step. */
import { bootFocus } from './pomodoro-boot.mjs'
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = dirname(fileURLToPath(import.meta.url))
const ROOT = join(OUT, '..', '..')
const DIR = join(OUT, 'rem6-dir')
const LOG = join(OUT, 'rem6-stdout.log')
const say = (k, v) => console.log('##', k, (JSON.stringify(v) ?? 'undefined').slice(0, 700))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const cliEnv = { ...process.env, TODO_DB_DIR: DIR }
const cli = a => execSync(`node cli/pickdone.js ${a}`, { encoding: 'utf8', timeout: 30000, env: cliEnv, cwd: ROOT })
const ts = d => { const x = new Date(d); const p = n => String(n).padStart(2, '0'); return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}` }
const readLog = () => { try { return existsSync(LOG) ? readFileSync(LOG, 'utf8') : '' } catch { return '' } }
const rebuild = () => (readLog().split('\n').filter(l => l.includes('scheduler rebuild done')).slice(-1)[0] || 'none').trim()
const fired = () => readLog().split('\n').filter(l => l.includes('[Reminder] fired:')).map(l => l.trim())

rmSync(DIR, { recursive: true, force: true })
rmSync(LOG, { force: true })
mkdirSync(DIR, { recursive: true })

const j = await bootFocus({ cdpPort: 9382, persistentDataDir: DIR, logFile: LOG })
try {
  await sleep(9000)
  say('boot-rebuild', rebuild())
  // Leg 1: past-due while RUNNING (write-path catch-up)
  say('seedP-past', cli(`add "remP" --date "${ts(Date.now() - 120000)}" --reminder "${ts(Date.now() - 120000)}"`).replace(/\s+/g, ' ').slice(0, 120))
  await sleep(60000) // watch poll is slow (~30-45s observed)
  say('after-P-rebuild', rebuild())
  say('after-P-fired', fired())
  say('after-P-rows', await j.eval(`(async () => JSON.stringify((await window.todoAPI.dbCall('queryTodos',{deleted:0})).map(r => ({ c:(r.taskContent||'').slice(0,6), rem: r.reminderTime || null }))))()`, 15000))
  say('watermark', await j.eval(`window.todoAPI.dbCall('getMeta', 'reminderLastSeenAt')`))
  // Leg 2: crash → past-due while CLOSED → boot2
  j.crash()
  await sleep(3000)
} catch (e) {
  say('ERROR', String(e && e.stack || e).slice(0, 1200))
}
try { await j.end({ preserveDir: true }) } catch { /* dead */ }

try {
  say('seedQ-past-closed', cli(`add "remQ" --date "${ts(Date.now() - 60000)}" --reminder "${ts(Date.now() - 60000)}"`).replace(/\s+/g, ' ').slice(0, 120))
  const j2 = await bootFocus({ cdpPort: 9382, persistentDataDir: DIR, logFile: LOG })
  try {
    await sleep(12000)
    say('boot2-rebuild', rebuild())
    say('boot2-fired', fired())
    say('boot2-rows', await j2.eval(`(async () => JSON.stringify((await window.todoAPI.dbCall('queryTodos',{deleted:0})).map(r => ({ c:(r.taskContent||'').slice(0,6), rem: r.reminderTime || null }))))()`, 15000))
    say('boot2-watermark', await j2.eval(`window.todoAPI.dbCall('getMeta', 'reminderLastSeenAt')`))
  } finally { await j2.end({ preserveDir: false }) }
} catch (e) {
  say('ERROR2', String(e && e.stack || e).slice(0, 1200))
}
console.log('JOURNEY-R2A6 DONE')
