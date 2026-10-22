/* Round-2 Journey R2E: harvest edges — the last-second give-up race.
   focus=5; wait until the bar clock reads ≤ 00:04, then click 放弃 and confirm — the shared tick's
   completeFocus and the give-up claim race. ANY of these outcomes is contract-legal IF coherent:
   (a) give-up won: exactly one succeed:false row, status default, harvest unchanged;
   (b) completion won: exactly one succeed:true row, rest phase entered, harvest +1, and the
       give-up dispatch must be a no-op (no second row, no crash).
   Then a clean completion on the next run for the row-shape comparison. */
import { bootJourney } from '../../scripts/journey-driver.mjs'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = dirname(fileURLToPath(import.meta.url))
const log = []
const say = (k, v) => { log.push([k, v]); console.log('##', k, (JSON.stringify(v) ?? 'undefined').slice(0, 800)) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

const state = `(() => ({
  status: (JSON.parse(localStorage.getItem('tomatoState')) || {}).status,
  harvest: (document.querySelector('.tb-row--harvest b') || {}).textContent,
  clock: (document.querySelector('.tomato-timer__time') || {}).textContent,
  play: (document.querySelector('.tomato-timer__play') || {}).textContent
}))()`

const j = await bootJourney({ cdpPort: 9382, seedConfig: { closeActionMinimize: false } })
try {
  await sleep(2500)
  // durations 5 / 1 via the settings page (canonical)
  await j.eval(`(() => { const app = document.querySelector('#app').__vue_app__; app.config.globalProperties.$store.commit('ui/toggleSettings', true); return true })()`)
  await sleep(800)
  const fillNum = (label, v) => `(() => { const i = document.querySelector('input[aria-label="${label}"]'); if (!i) return 'no-input'; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '${v}'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return i.value })()`
  await j.eval(fillNum('专注时长（分钟）：', 5))
  await sleep(400)
  await j.eval(fillNum('休息时长（分钟）：', 1))
  await sleep(600)
  await j.eval(`(() => { const x = document.querySelector('.modal--settings-center .modal__close'); if (x) x.click(); return true })()`)
  await sleep(600)

  // RUN 1: the last-second give-up race
  say('run1-start', await j.click('.tomato-timer__play'))
  say('run1-t0', await j.eval(state))
  // poll until the clock reads 00:0x (last 10 s)
  const t0 = Date.now()
  let clock = null
  while (Date.now() - t0 < 5.2 * 60000) {
    await sleep(2500)
    clock = await j.eval(`(document.querySelector('.tomato-timer__time')||{}).textContent`)
    if (/^00:0[0-9]$/.test(clock)) break
    if ((await j.eval(state)).status === 'startRestTime') break // completion won before we could click
  }
  say('run1-at-click-time', await j.eval(state))
  say('run1-click-giveup', await j.click('.tomato-timer__play'))
  await sleep(700)
  say('run1-modal', await j.eval(`(() => { const m = document.querySelector('.modal--abandon'); return m ? m.textContent.replace(/\\s+/g, ' ').slice(0, 80) : 'NO-MODAL' })()`))
  await j.click('.abandon-btn--giveup')
  await sleep(1500)
  say('run1-after-giveup', await j.eval(state))
  say('run1-ledger', await j.eval(`window.todoAPI.dbCall('tomatoAll')`))
  say('run1-session-row', await j.eval(`window.todoAPI.dbCall('getMeta', 'tomatoRunningSession')`))
  await j.shot(OUT + 'shots/jR2E-01-race-outcome.png')
  // settle: if rest is running let it finish (1 min) so run 2 starts clean
  for (let t = 0; t < 20; t++) {
    const s = await j.eval(state)
    if (s.status === 'default') break
    await sleep(4000)
  }
  say('run1-settled', await j.eval(state))

  // RUN 2: clean completion for the row-shape comparison
  say('run2-start', await j.click('.tomato-timer__play'))
  let rested2 = false
  for (let t = 0; t < 70 && !rested2; t++) {
    await sleep(5000)
    if ((await j.eval(state)).status === 'startRestTime') { rested2 = true; say('run2-rested', { waitedS: (t + 1) * 5 }) }
  }
  say('run2-after-complete', await j.eval(state))
  // abandon the rest (ElMessageBox confirm path — the rest give-up has a native-style confirm)
  say('run2-click-rest-giveup', await j.click('.tomato-timer__play'))
  await sleep(900)
  say('run2-rest-confirm', await j.eval(`(() => { const m = document.querySelector('.el-message-box') || document.querySelector('.modal--abandon'); return m ? m.textContent.replace(/\\s+/g, ' ').slice(0, 100) : 'NO-CONFIRM' })()`))
  const confirmBtn = await j.eval(`(() => { const b = Array.from(document.querySelectorAll('.el-message-box__btns button, .modal--abandon button')).find(x => /放弃|确 定|确定/.test(x.textContent)); if (b) { b.click(); return b.textContent.trim() } return 'NO-BTN' })()`)
  say('run2-rest-confirm-clicked', confirmBtn)
  await sleep(1500)
  say('run2-final', await j.eval(state))
  say('final-ledger', await j.eval(`window.todoAPI.dbCall('tomatoAll')`))
  say('final-harvest', await j.eval(state))
  await j.shot(OUT + 'shots/jR2E-02-final.png')
} catch (e) {
  say('ERROR', String(e && e.stack || e).slice(0, 1500))
} finally {
  writeFileSync(join(OUT, 'journeyR2E-log.json'), JSON.stringify(log), 'utf8')
  await j.end()
}
console.log('JOURNEY-R2E DONE')
