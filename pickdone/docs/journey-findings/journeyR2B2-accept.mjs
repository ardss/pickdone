/* Round-2 Journey R2B2: the ACCEPT leg of the quit-confirm walk (R2B verified cancel live;
   a path bug skipped accept). Boot fresh → focus → closeRequest → REAL click on 放弃专注并退出
   → process must EXIT → boot again on the same dir: the running focus must be UNRECORDED
   (dialog copy: 放弃…不会记入专注账本) and the durable row must NOT survive. */
import { bootJourney } from '../../scripts/journey-driver.mjs'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = dirname(fileURLToPath(import.meta.url))
const DIR = join(OUT, 'quit2-dir')
const log = []
const say = (k, v) => { log.push([k, v]); console.log('##', k, (JSON.stringify(v) ?? 'undefined').slice(0, 500)) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
const j = await bootJourney({ cdpPort: 9382, seedConfig: { closeActionMinimize: false }, dataDir: DIR })
try {
  await sleep(2500)
  say('start-focus', await j.click('.tomato-timer__play'))
  await sleep(2000)
  say('row-at-start', await j.eval(`window.todoAPI.dbCall('getMeta', 'tomatoRunningSession')`))
  say('closeRequest', await j.eval(`window.todoAPI.closeRequest()`))
  await sleep(3500)
  console.log('## PAUSE_FOR_ACCEPT — REAL-click 放弃专注并退出, then create r2b2-accept.flag')
  const p = join(OUT, 'r2b2-accept.flag')
  const t0 = Date.now()
  while (!existsSync(p) && Date.now() - t0 < 240000) await sleep(500)
  try { rmSync(p) } catch { /* */ }
  const t1 = Date.now()
  let exited = null
  while (Date.now() - t1 < 15000) {
    if (j.child.exitCode !== null) { exited = j.child.exitCode; break }
    let dead = false
    try { await (await fetch(j.cdpBase + '/json')).json() } catch { dead = true }
    if (dead) { exited = 'cdp-dead'; break }
    await sleep(700)
  }
  say('process-exited-after-accept', exited)
  await sleep(2500)
} catch (e) {
  say('ERROR', String(e && e.stack || e).slice(0, 1200))
}
try { await j.end({ preserveDir: true }) } catch { /* dead */ }

const j2 = await bootJourney({ cdpPort: 9382, dataDir: DIR })
try {
  await sleep(6000)
  say('boot2-session-row', await j2.eval(`window.todoAPI.dbCall('getMeta', 'tomatoRunningSession')`))
  say('boot2-ledger', await j2.eval(`window.todoAPI.dbCall('tomatoAll')`))
  say('boot2-harvest', await j2.eval(`(document.querySelector('.tb-row--harvest b')||{}).textContent`))
  await j2.shot(OUT + '\\shots\\jR2B2-01-boot2.png')
} catch (e) {
  say('ERROR2', String(e && e.stack || e).slice(0, 1200))
} finally {
  await j2.end({ preserveDir: false })
}
writeFileSync(join(OUT, 'journeyR2B2-log.json'), JSON.stringify(log), 'utf8')
console.log('JOURNEY-R2B2 DONE')
