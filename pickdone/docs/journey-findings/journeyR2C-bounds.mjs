/* Round-2 Journey R2C: duration boundaries via the TomatoPanel (canonical writer path).
   Focus stepper: 1 and 999; rest stepper: 0 and 999 — what lands in the settings input, the
   tomato blob, and the bottom-bar idle clock. Plus the shortest legal circuit completion note
   (focus min 5:00 + rest min 1:00 — the 5:00 completion is proven by R2D's soak). */
import { bootJourney } from '../../scripts/journey-driver.mjs'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = dirname(fileURLToPath(import.meta.url))
const log = []
const say = (k, v) => { log.push([k, v]); console.log('##', k, (JSON.stringify(v) ?? 'undefined').slice(0, 500)) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

const panelAndSettings = `(() => ({
  panelFocus: (document.querySelector('.tomato-panel .cfg-row:nth-of-type(1) input') || document.querySelectorAll('.tomato-panel .cfg-row input')[0] || {}).value,
  panelRest: (document.querySelectorAll('.tomato-panel .cfg-row input')[1] || {}).value,
  settingsFocus: (document.querySelector('input[aria-label="专注时长（分钟）："]') || {}).value,
  settingsRest: (document.querySelector('input[aria-label="休息时长（分钟）："]') || {}).value,
  blob: (() => { try { const s = JSON.parse(localStorage.getItem('tomatoState')); return { tomatoTime: s.tomatoTime, restTime: s.restTime } } catch (e) { return null } })(),
  barClock: (document.querySelector('.tomato-timer__time') || {}).textContent
}))()`
const fill = (sel, v) => `(() => { const i = document.querySelector(${JSON.stringify(sel)}); if (!i) return 'no-input'; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '${v}'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return i.value })()`

const j = await bootJourney({ cdpPort: 9382, seedConfig: { closeActionMinimize: false } })
try {
  await sleep(2500)
  await j.eval(`(() => { const app = document.querySelector('#app').__vue_app__; app.config.globalProperties.$store.commit('ui/toggleSettings', true); return true })()`)
  await sleep(800)
  say('open-panel-btn', await j.eval(`(() => { const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('打开番茄钟面板')); if (!b) return 'no-btn'; b.click(); return 'ok' })()`))
  await sleep(900)
  say('baseline', await j.eval(panelAndSettings))

  // focus stepper: below-min and above-max
  say('focus-fill-1', await j.eval(fill('.tomato-panel .cfg-row input', 1)))
  await sleep(1000)
  say('after-focus-1', await j.eval(panelAndSettings))
  say('focus-fill-999', await j.eval(fill('.tomato-panel .cfg-row input', 999)))
  await sleep(1000)
  say('after-focus-999', await j.eval(panelAndSettings))

  // rest stepper: below-min and above-max
  say('rest-fill-0', await j.eval(fill('.tomato-panel .cfg-row:nth-of-type(2) input', 0)) === 'no-input' ? 'sel-miss' : await j.eval(fill('.tomato-panel .cfg-row:nth-of-type(2) input', 0)))
  await sleep(1000)
  say('after-rest-0', await j.eval(panelAndSettings))
  say('rest-fill-999', await j.eval(fill('.tomato-panel .cfg-row:nth-of-type(2) input', 999)))
  await sleep(1000)
  say('after-rest-999', await j.eval(panelAndSettings))
  await j.shot(OUT + 'shots/jR2C-01-bounds.png')

  // restore legal minimums for the record: focus 5 / rest 1
  say('restore-focus-5', await j.eval(fill('.tomato-panel .cfg-row input', 5)))
  await sleep(600)
  say('restore-rest-1', await j.eval(fill('.tomato-panel .cfg-row:nth-of-type(2) input', 1)))
  await sleep(800)
  say('final', await j.eval(panelAndSettings))
} catch (e) {
  say('ERROR', String(e && e.stack || e).slice(0, 1500))
} finally {
  writeFileSync(join(OUT, 'journeyR2C-log.json'), JSON.stringify(log), 'utf8')
  await j.end()
}
console.log('JOURNEY-R2C DONE')
