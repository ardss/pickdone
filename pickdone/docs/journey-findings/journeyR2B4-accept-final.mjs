/* Round-2 Journey R2B4: the definitive accept leg.
   Procedure proven by R2B3's forensic run: the confirm dialog renders BEHIND the foreground
   window until its parent is raised — the auditor must App-switch the parent (拾事 [TEST]),
   click 放弃专注并退出, VERIFY the dialog text disappears, and only then release the flag.
   Ground truth = the process exits within 20s of release; boot2 then verifies the abandoned
   focus is unrecorded and the durable row is reconciled. */
import { bootJourney } from '../../scripts/journey-driver.mjs'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = dirname(fileURLToPath(import.meta.url))
const DIR = join(OUT, 'quit4-dir')
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
  say('harvest-at-start', await j.eval(`(document.querySelector('.tb-row--harvest b')||{}).textContent`))
  say('closeRequest', await j.eval(`window.todoAPI.closeRequest()`))
  await sleep(3500)
  say('alive-while-dialog', !j.child.exitCode)
  console.log('## PAUSE_FOR_ACCEPT — raise parent, click 放弃专注并退出, VERIFY dialog gone, create r2b4-accept.flag')
  const p = join(OUT, 'r2b4-accept.flag')
  const t0 = Date.now()
  while (!existsSync(p) && Date.now() - t0 < 600000) await sleep(500)
  try { rmSync(p) } catch { /* */ }
  say('flag-received', existsSync(p) ? 'timeout' : 'ok')
  const t1 = Date.now()
  let exited = null
  while (Date.now() - t1 < 20000) {
    if (j.child.exitCode !== null) { exited = { code: j.child.exitCode, afterMs: Date.now() - t1 }; break }
    await sleep(500)
  }
  say('process-exited-after-accept', exited)
  await sleep(2500)
} catch (e) {
  say('ERROR', String(e && e.stack || e).slice(0, 1200))
}
try { await j.end({ preserveDir: true }) } catch { /* dead */ }
say('post-end-exitCode', j.child.exitCode)

const j2 = await bootJourney({ cdpPort: 9382, dataDir: DIR })
try {
  await sleep(6000)
  say('boot2-session-row', await j2.eval(`window.todoAPI.dbCall('getMeta', 'tomatoRunningSession')`))
  say('boot2-ledger', await j2.eval(`window.todoAPI.dbCall('tomatoAll')`))
  say('boot2-harvest', await j2.eval(`(document.querySelector('.tb-row--harvest b')||{}).textContent`))
  say('boot2-bar', await j2.eval(`(() => ({ clock: (document.querySelector('.tomato-timer__time')||{}).textContent, phase: (document.querySelector('.tomato-bar')||{}).textContent && document.querySelector('.tomato-bar').textContent.replace(/\\s+/g,' ').slice(0,40) }))()`))
} catch (e) {
  say('ERROR2', String(e && e.stack || e).slice(0, 1200))
} finally {
  await j2.end({ preserveDir: false })
}
writeFileSync(join(OUT, 'journeyR2B4-log.json'), JSON.stringify(log), 'utf8')
console.log('JOURNEY-R2B4 DONE')
