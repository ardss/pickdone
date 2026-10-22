/* Round-2 Journey R2D: 10-minute soak — one focus run at the legal max-stepper-friendly 10:00.
   Every minute: bar clock vs wall-clock expected remaining (drift), float clock, native taskbar
   title (PowerShell), bar phase class. At completion: ledger row focusDuration=10, harvest +1,
   rest phase entered; then rest 1:00 completes back to idle. */
import { bootJourney } from '../../scripts/journey-driver.mjs'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = dirname(fileURLToPath(import.meta.url))
const log = []
const say = (k, v) => { log.push([k, v]); console.log('##', k, (JSON.stringify(v) ?? 'undefined').slice(0, 700)) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const nativeTitles = () => {
  try {
    return execSync('powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | ForEach-Object { $_.MainWindowTitle }"', { encoding: 'utf8', timeout: 20000 }).split(/\r?\n/).filter(Boolean)
  } catch { return ['probe-failed'] }
}

const j = await bootJourney({ cdpPort: 9382, seedConfig: { closeActionMinimize: false } })
let f = null
try {
  await sleep(2500)
  // durations: focus 10 via settings page (canonical), rest 1
  await j.eval(`(() => { const app = document.querySelector('#app').__vue_app__; app.config.globalProperties.$store.commit('ui/toggleSettings', true); return true })()`)
  await sleep(800)
  const fillNum = (label, v) => `(() => { const i = document.querySelector('input[aria-label="${label}"]'); if (!i) return 'no-input'; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '${v}'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return i.value })()`
  await j.eval(fillNum('专注时长（分钟）：', 10))
  await sleep(400)
  await j.eval(fillNum('休息时长（分钟）：', 1))
  await sleep(600)
  await j.eval(`(() => { const x = document.querySelector('.modal--settings-center .modal__close'); if (x) x.click(); return true })()`)
  await sleep(7000)
  try { f = await j.connectPage('__tomato-float'); await f.eval('window.moveTo(120, 120)') } catch { say('float', 'not-shown') }

  const startedAt = Date.now()
  say('soak-start', await j.click('.tomato-timer__play'))
  const startState = JSON.parse(await j.eval(`JSON.stringify(JSON.parse(localStorage.getItem('tomatoState')).startedAt)`))
  say('startedAt', startState)
  // sample at each whole minute of the run
  for (let m = 1; m <= 10; m++) {
    await sleep(Math.max(0, startedAt + m * 60000 + 800 - Date.now()))
    const st = JSON.parse(await j.eval(`(() => { const s = JSON.parse(localStorage.getItem('tomatoState')); return JSON.stringify({ status: s.status, startedAt: s.startedAt }) })()`))
    const expectedRemain = Math.round((startState + m * 60000 - Date.now()) / 1000)
    const sample = {
      minute: m,
      status: st.status,
      barClock: (await j.eval(`(document.querySelector('.tomato-timer__time')||{}).textContent`)),
      barClassWork: await j.eval(`(document.querySelector('.tomato-bar')||{}).classList && document.querySelector('.tomato-bar').classList.contains('tomato-timer--work')`),
      floatClock: f ? await f.eval(`(document.querySelector('.tomato__time')||{}).textContent`) : null,
      nativeTitle: nativeTitles()[0] || null,
      wallExpectedRemainSec: expectedRemain
    }
    say('soak-t' + m + 'm', sample)
    if (st.status !== 'startTomatoTime') { say('soak-left-focus-early', st); break }
  }
  // completion leg
  let rested = false
  for (let t = 0; t < 24 && !rested; t++) {
    await sleep(5000)
    if ((JSON.parse(await j.eval(`JSON.stringify(JSON.parse(localStorage.getItem('tomatoState')).status)`))) === 'startRestTime') { rested = true; say('rest-entered', { waitedS: (t + 1) * 5 }) }
  }
  say('at-rest', await j.eval(`(() => { const s = JSON.parse(localStorage.getItem('tomatoState')); return JSON.stringify({ status: s.status, todayTomatoCount: s.todayTomatoCount }) })()`))
  say('ledger', await j.eval(`window.todoAPI.dbCall('tomatoAll')`))
  say('native-title-rest', nativeTitles()[0] || null)
  await j.shot(OUT + 'shots/jR2D-01-rest.png')
  // rest 1:00 finishes
  for (let t = 0; t < 24; t++) {
    await sleep(5000)
    if ((JSON.parse(await j.eval(`JSON.stringify(JSON.parse(localStorage.getItem('tomatoState')).status)`))) === 'default') { say('back-to-idle', { waitedS: (t + 1) * 5 }); break }
  }
  say('final-bar', await j.eval(`(() => ({ clock: (document.querySelector('.tomato-timer__time')||{}).textContent, harvest: (document.querySelector('.tb-row--harvest b')||{}).textContent }))()`))
  await j.shot(OUT + 'shots/jR2D-02-idle.png')
} catch (e) {
  say('ERROR', String(e && e.stack || e).slice(0, 1500))
} finally {
  writeFileSync(join(OUT, 'journeyR2D-log.json'), JSON.stringify(log), 'utf8')
  await j.end()
}
console.log('JOURNEY-R2D DONE')
