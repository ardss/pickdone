/* Journey B5: isolate the bounce — two quick writes THROUGH THE SETTINGS PAGE ONLY.
   If the settings page also bounces (5 → 10 → 5), the reassertion lives in the settings
   ledger echo/watch layer, independent of the tomato panel. */
import { bootFocus } from './pomodoro-boot.mjs'
import { mkdir, writeFile, rm } from 'node:fs/promises'

const OUT = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const PERSIST = OUT + 'persist-dir-b5'
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
  const fillNum = (v) => `(() => { const i = document.querySelector('input[aria-label="专注时长（分钟）："]'); if (!i) return 'no-input'; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '${v}'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return i.value })()`
  say('settings-fill-5', await j.eval(fillNum(5)))
  await sleep(2500)
  say('settings-fill-10', await j.eval(fillNum(10)))
  for (const t of [500, 1600, 2500, 4000]) {
    await sleep(t === 500 ? 500 : t - [500, 1600, 2500, 4000][[500, 1600, 2500, 4000].indexOf(t) - 1])
    const sample = await j.eval(`(() => ({ blob: (JSON.parse(localStorage.getItem('tomatoState')) || {}).tomatoTime, settingsInput: (document.querySelector('input[aria-label="专注时长（分钟）："]') || {}).value, barClock: (document.querySelector('.tomato-timer__time') || {}).textContent }))()`)
    say('settings-only-sample-t' + t + 'ms', sample)
  }
  await j.shot(OUT + 'shots/jB5-01.png')
} catch (e) {
  say('ERROR', String(e && e.stack || e).slice(0, 2000))
} finally {
  await j.end({ keepDir: true })
  await rm(PERSIST, { recursive: true, force: true }).catch(() => {})
}
console.log('JOURNEY-B5 DONE')
