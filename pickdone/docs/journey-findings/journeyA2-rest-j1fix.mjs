/* Journey A2 (fresh dist, carries ce477e45): J1 visual re-verify (bar label 专注中 while focusing,
   休息中 during rest), completion started from the FLOAT knob, rest phase visuals. */
import { bootFocus } from './pomodoro-boot.mjs'
import { mkdir, writeFile } from 'node:fs/promises'

const OUT = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const log = []
const say = (k, v) => { log.push([k, v]); console.log('##', k, (JSON.stringify(v) ?? 'undefined').slice(0, 2200)) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

const j = await bootFocus({ cdpPort: 9382 })
let f = null
try {
  await mkdir(OUT + 'shots', { recursive: true })
  await sleep(2500)
  say('dist-fresh-check', await j.eval(`(() => ({ barLabel: (document.querySelector('.tomato-timer__status .tb-row') || {}).textContent }))()`))
  const fillNum = (label, v) => `(() => { const i = document.querySelector('input[aria-label="${label}"]'); if (!i) return 'no-input'; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '${v}'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return i.value })()`
  await j.eval(`(() => { const app = document.querySelector('#app').__vue_app__; app.config.globalProperties.$store.commit('ui/toggleSettings', true); return true })()`)
  await sleep(800)
  await j.eval(fillNum('专注时长（分钟）：', 5))
  await sleep(300)
  await j.eval(fillNum('休息时长（分钟）：', 1))
  await sleep(500)
  await j.eval(`(() => { const x = document.querySelector('.modal--settings-center .modal__close'); if (x) x.click(); return true })()`)
  await sleep(7000)
  f = await j.connectPage('__tomato-float')
  await f.eval('window.moveTo(120, 120)')

  // -- START THE FOCUS FROM THE FLOAT KNOB
  say('knob-start', await f.eval(`(() => { document.querySelector('.tomato__knob').click(); return true })()`))
  await sleep(2500)
  say('bar-during-focus-J1', await j.eval(`(() => { const bar = document.querySelector('.tomato-bar'); return { label: (document.querySelector('.tomato-timer__status .tb-row') || {}).textContent, clock: (document.querySelector('.tomato-timer__time') || {}).textContent, play: (document.querySelector('.tomato-timer__play') || {}).textContent, workClass: bar.classList.contains('tomato-timer--work') } })()`))
  await j.shot(OUT + 'shots/jA2-01-bar-focus-J1fix.png')
  await f.shot(OUT + 'shots/jA2-02-float-focus.png')

  // -- wait out the 5:00 focus
  let rested = false
  for (let t = 0; t < 70 && !rested; t++) {
    await sleep(5000)
    const st = await j.eval(`(() => { try { return JSON.parse(localStorage.getItem('tomatoState')) } catch (e) { return null } })()`)
    if (st && st.status === 'startRestTime') { rested = true; say('rest-at', { waitedS: (t + 1) * 5 }) }
  }
  // -- REST phase: J1 rest branch + float badge
  say('bar-during-rest-J1', await j.eval(`(() => { const bar = document.querySelector('.tomato-bar'); return { label: (document.querySelector('.tomato-timer__status .tb-row') || {}).textContent, clock: (document.querySelector('.tomato-timer__time') || {}).textContent, play: (document.querySelector('.tomato-timer__play') || {}).textContent, restClass: bar.classList.contains('tomato-timer--rest'), harvest: (document.querySelector('.tb-row--harvest b') || {}).textContent } })()`))
  say('float-during-rest', await f.eval(`(() => ({ time: (document.querySelector('.tomato__time')||{}).textContent, badge: (document.querySelector('.tomato__badge')||{}).textContent, knob: (document.querySelector('.tomato__knob')||{}).title }))()`))
  await j.shot(OUT + 'shots/jA2-03-bar-rest-J1fix.png')
  await f.shot(OUT + 'shots/jA2-04-float-rest.png')

  // -- wait out the 1:00 rest
  let idle = false
  for (let t = 0; t < 30 && !idle; t++) {
    await sleep(4000)
    const st = await j.eval(`(() => { try { return JSON.parse(localStorage.getItem('tomatoState')) } catch (e) { return null } })()`)
    if (st && st.status === 'default') { idle = true; say('idle-at', { waitedS: (t + 1) * 4 }) }
  }
  say('bar-idle-final', await j.eval(`(() => ({ label: (document.querySelector('.tomato-timer__status .tb-row') || {}).textContent, harvest: (document.querySelector('.tb-row--harvest b') || {}).textContent, play: (document.querySelector('.tomato-timer__play') || {}).textContent }))()`))
  say('ledger-final', await j.eval(`window.todoAPI.dbCall('tomatoAll')`))
  await j.shot(OUT + 'shots/jA2-05-idle.png')
} catch (e) {
  say('ERROR', String(e && e.stack || e).slice(0, 2500))
} finally {
  await writeFile(OUT + 'journeyA2-log.json', JSON.stringify(log), 'utf8')
  await j.end()
}
console.log('JOURNEY-A2 DONE')
