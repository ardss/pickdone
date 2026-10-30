/* Round-2 Journey R2A4: pin the silent death to a TIMESTAMP.
   R2A3 showed the app die around the first watch-rebuild-armed reminder fire (exit 0xFFFFFFFF,
   zero diagnostics). This run records a 2s heartbeat (process alive / log tail) and enables
   ELECTRON_ENABLE_LOGGING so a native crash prints its stack into the captured stdout.
   Verdict rule: death within ±6s of the fire ⇒ fire-correlated; else record the real time. */
process.env.ELECTRON_ENABLE_LOGGING = '1'
import { bootFocus } from './pomodoro-boot.mjs'
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = dirname(fileURLToPath(import.meta.url))
const ROOT = join(OUT, '..', '..')
const DIR = join(OUT, 'rem4-dir')
const LOG = join(OUT, 'rem4-stdout.log')
const say = (k, v) => console.log('##', k, (JSON.stringify(v) ?? 'undefined').slice(0, 700))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const cliEnv = { ...process.env, TODO_DB_DIR: DIR }
const cli = a => execSync(`node cli/pickdone.js ${a}`, { encoding: 'utf8', timeout: 30000, env: cliEnv, cwd: ROOT })
const ts = d => { const x = new Date(d); const p = n => String(n).padStart(2, '0'); return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}` }
const readLog = () => { try { return existsSync(LOG) ? readFileSync(LOG, 'utf8') : '' } catch { return '' } }

rmSync(DIR, { recursive: true, force: true })
rmSync(LOG, { force: true })
mkdirSync(DIR, { recursive: true })

const j = await bootFocus({ cdpPort: 9382, persistentDataDir: DIR, logFile: LOG })
try {
  await sleep(9000)
  const seedOut = cli(`add "remG" --date "${ts(Date.now() + 75000)}" --reminder "${ts(Date.now() + 75000)}"`)
  const idG = (seedOut.match(/tid_\S+_\d+/) || [])[0]
  const tFire = Date.now() + 75000
  say('seeded', { idG, dueAt: new Date(tFire).toLocaleTimeString('en-GB'), pid: j.child.pid })

  const heart = []
  let dead = false
  const hb = setInterval(() => {
    const s = readLog().split('\n').filter(Boolean)
    heart.push({ t: new Date().toLocaleTimeString('en-GB'), alive: j.child.exitCode === null, lines: s.length, last: (s[s.length - 1] || '').slice(0, 90) })
    if (j.child.exitCode !== null) { dead = true; clearInterval(hb) }
  }, 2000)
  const t0 = Date.now()
  while (Date.now() - t0 < 110000 && !dead) await sleep(1000)
  clearInterval(hb)
  const dieIdx = heart.map(h => h.alive).lastIndexOf(true)
  say('death-window', { lastAlive: heart[dieIdx], firstDead: heart[dieIdx + 1] || null, fireAt: new Date(tFire).toLocaleTimeString('en-GB') })
  say('log-tail', readLog().split('\n').filter(l => /Reminder|error|Exception|crash|FATAL/i.test(l)).slice(-5).map(l => l.trim()))
  say('exitCode', j.child.exitCode)
} catch (e) {
  say('ERROR', String(e && e.stack || e).slice(0, 1200))
} finally {
  await j.end({ keepDir: false })
}
console.log('JOURNEY-R2A4 DONE')
