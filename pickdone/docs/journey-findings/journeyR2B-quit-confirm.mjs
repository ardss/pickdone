/* Round-2 Journey R2B: TQ-1 quit-confirm LIVE walk.
   closeActionMinimize:false → closeRequest (X equivalent) → quitFromTray → the DURABLE
   running-session gate → native confirm dialog (专注进行中 / 放弃专注并退出 / 取消退出).
   The dialog is native: this script verifies the VERIFIABLE live (process not exiting while it
   is up, durable row intact, focus still counting), pauses for the auditor to drive the REAL
   dialog with the OS mouse/keyboard (windows_mcp), then re-checks, and finally walks the ACCEPT
   path: quit → process exit → reboot → the running focus must be UNRECORDED (dialog copy
   promises 放弃…不会记入专注账本) and the durable row must NOT survive. */
import { bootJourney } from '../../scripts/journey-driver.mjs'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = dirname(fileURLToPath(import.meta.url))
const DIR = join(OUT, 'quit-dir')
const log = []
const say = (k, v) => { log.push([k, v]); console.log('##', k, (JSON.stringify(v) ?? 'undefined').slice(0, 500)) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const waitFlag = async name => {
  const p = join(OUT, name)
  const t0 = Date.now()
  while (!existsSync(p) && Date.now() - t0 < 240000) await sleep(500)
  try { rmSync(p) } catch { /* */ }
  return existsSync(p) || 'timeout'
}
const alive = async j => {
  try { await (await fetch(j.cdpBase + '/json')).json(); return !j.child.exitCode } catch { return false }
}
const row = j => j.eval(`window.todoAPI.dbCall('getMeta', 'tomatoRunningSession')`)

rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
const j = await bootJourney({ cdpPort: 9382, seedConfig: { closeActionMinimize: false }, dataDir: DIR })
try {
  await sleep(2500)
  say('start-focus', await j.click('.tomato-timer__play'))
  await sleep(2000)
  say('session-row-at-start', await row(j))
  say('clock-running', await j.eval(`(document.querySelector('.tomato-timer__time')||{}).textContent`))

  // closeRequest (the X / Alt+F4 equivalent under exit mode) → durable-session confirm
  say('closeRequest', await j.eval(`window.todoAPI.closeRequest()`))
  await sleep(4000)
  say('alive-while-dialog-up', await alive(j))
  say('session-row-while-dialog-up', await row(j))
  say('native-title-note', 'native dialog must be on screen now: 专注进行中 / [放弃专注并退出] [取消退出]')
  console.log('## PAUSE_FOR_CANCEL — press the CANCEL button (取消退出) on the native dialog, then create r2b-cancel.flag')
  say('cancel-flag', await waitFlag('r2b-cancel.flag'))
  await sleep(1500)
  say('alive-after-cancel', await alive(j))
  say('session-row-after-cancel', await row(j))
  say('clock-after-cancel', await j.eval(`(document.querySelector('.tomato-timer__time')||{}).textContent`))
  await j.shot(OUT + '\\shots\\jR2B-01-after-cancel.png')

  // accept path: 放弃专注并退出
  say('closeRequest-2', await j.eval(`window.todoAPI.closeRequest()`))
  await sleep(2500)
  say('alive-while-dialog-2', await alive(j))
  console.log('## PAUSE_FOR_ACCEPT — press 放弃专注并退出 on the native dialog, then create r2b-accept.flag')
  say('accept-flag', await waitFlag('r2b-accept.flag'))
  const t0 = Date.now()
  let exited = null
  while (Date.now() - t0 < 15000) {
    if (j.child.exitCode !== null) { exited = j.child.exitCode; break }
    let dead = false
    try { await (await fetch(j.cdpBase + '/json')).json() } catch { dead = true }
    if (dead) { exited = 'cdp-dead'; break }
    await sleep(700)
  }
  say('process-exited-after-accept', exited)
  await sleep(2000)
} catch (e) {
  say('ERROR', String(e && e.stack || e).slice(0, 1500))
}
try { await j.end({ preserveDir: true }) } catch { /* already dead */ }

// ---- boot 2: the abandoned focus must be UNRECORDED, row must not survive ----
const j2 = await bootJourney({ cdpPort: 9382, dataDir: DIR })
try {
  await sleep(6000)
  say('boot2-session-row', await row(j2))
  say('boot2-ledger', await j2.eval(`window.todoAPI.dbCall('tomatoAll')`))
  say('boot2-harvest', await j2.eval(`(document.querySelector('.tb-row--harvest b')||{}).textContent`))
  await j2.shot(OUT + 'shots/jR2B-02-boot2.png')
} catch (e) {
  say('ERROR2', String(e && e.stack || e).slice(0, 1500))
} finally {
  await j2.end({ preserveDir: false })
}
writeFileSync(join(OUT, 'journeyR2B-log.json'), JSON.stringify(log), 'utf8')
console.log('JOURNEY-R2B DONE')
