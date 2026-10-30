/* Round-2 Journey R2A3: MINIMAL instrumented repro of the R2A silent death.
   Boot1 fired reminder A (19:21) fine; the app then died silently between 19:22:03 and 19:24,
   around (but not proven at) reminder B's 19:23:00 fire. This repro isolates ONE question:
   does the app survive its own reminder fire(s)?
   Legs: seed G(+90s) via CLI while running → watch fire → alive at fire+10s/fire+30s?
         then seed H(+60s) → SECOND fire in the same session → alive?
         plus kill() instrumentation (was the earlier "dead" CDP real?). */
import { bootFocus } from './pomodoro-boot.mjs'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = dirname(fileURLToPath(import.meta.url))
const ROOT = join(OUT, '..', '..')
const DIR = join(OUT, 'rem3-dir')
const LOG = join(OUT, 'rem3-stdout.log')
const say = (k, v) => console.log('##', k, (JSON.stringify(v) ?? 'undefined').slice(0, 400))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const cliEnv = { ...process.env, TODO_DB_DIR: DIR }
const cli = a => execSync(`node cli/pickdone.js ${a}`, { encoding: 'utf8', timeout: 30000, env: cliEnv, cwd: ROOT })
const ts = d => { const x = new Date(d); const p = n => String(n).padStart(2, '0'); return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}` }
const readLog = () => { try { return existsSync(LOG) ? readFileSync(LOG, 'utf8') : '' } catch { return '' } }
const cdpAlive = async base => { try { await (await fetch(base + '/json')).json(); return true } catch { return false } }

rmSync(DIR, { recursive: true, force: true })
rmSync(LOG, { force: true })
mkdirSync(DIR, { recursive: true })

const j = await bootFocus({ cdpPort: 9382, persistentDataDir: DIR, logFile: LOG })
try {
  await sleep(10000)
  const idG = ((cli(`add "remG" --date "${ts(Date.now() + 90000)}" --reminder "${ts(Date.now() + 90000)}"`).match(/tid_\S+_\d+/)) || [])[0]
  say('seedG', idG)
  const tFire = Date.now() + 90000
  await sleep(tFire - Date.now() + 8000)
  say('log-around-G', readLog().split('\n').filter(l => /Reminder|error|Error|crash/i.test(l)).slice(-4).map(l => l.trim()))
  say('alive-G+8s', { cdp: await cdpAlive(j.cdpBase), exitCode: j.child.exitCode })

  // second fire in the same session
  const idH = ((cli(`add "remH" --date "${ts(Date.now() + 60000)}" --reminder "${ts(Date.now() + 60000)}"`).match(/tid_\S+_\d+/)) || [])[0]
  say('seedH', idH)
  await sleep(68000)
  say('log-around-H', readLog().split('\n').filter(l => /Reminder|error|Error|crash/i.test(l)).slice(-4).map(l => l.trim()))
  say('alive-H+8s', { cdp: await cdpAlive(j.cdpBase), exitCode: j.child.exitCode })
  await sleep(20000)
  say('alive-H+28s', { cdp: await cdpAlive(j.cdpBase), exitCode: j.child.exitCode })
} catch (e) {
  say('ERROR', String(e && e.stack || e).slice(0, 1200))
} finally {
  await j.end({ keepDir: false })
}
console.log('JOURNEY-R2A3 DONE')
