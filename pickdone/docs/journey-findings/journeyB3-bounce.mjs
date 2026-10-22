/* Journey B3: record the same-session BOUNCE — panel sets 10, then sample the three surfaces
   (tomato blob / settings input / bar clock) over 4s to catch the ledger echo reasserting 5. */
import { bootFocus } from './pomodoro-boot.mjs'
import { mkdir, writeFile, rm } from 'node:fs/promises'

const OUT = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const PERSIST = OUT + 'persist-dir-b3'
const log = []
const say = (k, v) => { log.push([k, v]); console.log('##', k, (JSON.stringify(v) ?? 'undefined').slice(0, 2000)) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const lsState = `(() => { try { return JSON.parse(localStorage.getItem('tomatoState')) } catch (e) { return null } })()`
const settingsInput = `(() => { const i = document.querySelector('input[aria-label="专注时长（分钟）："]'); return i ? i.value : 'no-input' })()`

await rm(PERSIST, { recursive: true, force: true }).catch(() => {})
const j = await bootFocus({ cdpPort: 9382, persistentDataDir: PERSIST })
try {
  await sleep(2500)
  await j.eval(`(() => { const app = document.querySelector('#app').__vue_app__; app.config.globalProperties.$store.commit('ui/toggleSettings', true); return true })()`)
  await sleep(800)
  const fillNum = (label, v) => `(() => { const i = document.querySelector('input[aria-label="${label}"]'); if (!i) return 'no-input'; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '${v}'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return i.value })()`
  await j.eval(fillNum('专注时长（分钟）：', 5))
  await sleep(2500) // let the settings write echo fully settle before the panel write
  await j.eval(`(() => { const btns = Array.from(document.querySelectorAll('button')); const b = btns.find(x => x.textContent.includes('打开番茄钟面板')); if (!b) return 'no-btn'; b.click(); return 'clicked' })()`)
  await sleep(900)
  say('panel-fill-10', await j.eval(`(() => { const i = document.querySelector('.tomato-panel .cfg-row input'); if (!i) return 'no-input'; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '10'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return i.value })()`))
  for (const t of [300, 800, 1500, 2500, 4000]) {
    await sleep(t === 300 ? 300 : t - [300, 800, 1500, 2500, 4000][[300, 800, 1500, 2500, 4000].indexOf(t) - 1])
    const sample = await j.eval(`(() => ({ blob: (JSON.parse(localStorage.getItem('tomatoState')) || {}).tomatoTime, settingsInput: (document.querySelector('input[aria-label="专注时长（分钟）："]') || {}).value, panelInput: (document.querySelector('.tomato-panel .cfg-row input') || {}).value, barClock: (document.querySelector('.tomato-timer__time') || {}).textContent }))()`)
    say('sample-t' + t + 'ms', sample)
  }
  await j.shot(OUT + 'shots/jB3-01-bounce.png')
} catch (e) {
  say('ERROR', String(e && e.stack || e).slice(0, 2000))
} finally {
  await writeFile(OUT + 'journeyB3-log.json', JSON.stringify(log), 'utf8')
  await j.end({ keepDir: true })
  await rm(PERSIST, { recursive: true, force: true }).catch(() => {})
}
console.log('JOURNEY-B3 DONE')
