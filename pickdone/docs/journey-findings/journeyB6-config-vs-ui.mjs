/* Journey B6: after the bounce — does config.json (get-settings) still hold the SECOND value
   while every UI surface shows the first? (UI-vs-disk contradiction = reboot flips back.) */
import { bootFocus } from './pomodoro-boot.mjs'
import { mkdir, writeFile, rm } from 'node:fs/promises'

const OUT = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const PERSIST = OUT + 'persist-dir-b6'
const log = []
const say = (k, v) => { log.push([k, v]); console.log('##', k, (JSON.stringify(v) ?? 'undefined').slice(0, 2000)) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const settingsInput = `(() => { const i = document.querySelector('input[aria-label="专注时长（分钟）："]'); return i ? i.value : 'no-input' })()`

await rm(PERSIST, { recursive: true, force: true }).catch(() => {})
const j = await bootFocus({ cdpPort: 9382, persistentDataDir: PERSIST })
try {
  await sleep(2500)
  await j.eval(`(() => { const app = document.querySelector('#app').__vue_app__; app.config.globalProperties.$store.commit('ui/toggleSettings', true); return true })()`)
  await sleep(800)
  const fillNum = (v) => `(() => { const i = document.querySelector('input[aria-label="专注时长（分钟）："]'); if (!i) return 'no-input'; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '${v}'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return i.value })()`
  await j.eval(fillNum(5))
  await sleep(2500)
  await j.eval(fillNum(10))
  await sleep(5000) // let the bounce happen
  say('after-bounce-settings-input', await j.eval(settingsInput))
  say('after-blob', await j.eval(`(JSON.parse(localStorage.getItem('tomatoState')) || {}).tomatoTime`))
  say('config-json-tomatoTime', await j.eval(`window.todoAPI.getSettings().then(c => c.tomatoTime)`))
  await j.shot(OUT + 'shots/jB6-01.png')
} catch (e) {
  say('ERROR', String(e && e.stack || e).slice(0, 2000))
} finally {
  await j.end({ keepDir: true })
}
// reboot: which value wins?
const j2 = await bootFocus({ cdpPort: 9382, persistentDataDir: PERSIST })
try {
  await sleep(3500)
  say('boot2-clock', await j2.eval(`(document.querySelector('.tomato-timer__time') || {}).textContent`))
  await j2.eval(`(() => { const app = document.querySelector('#app').__vue_app__; app.config.globalProperties.$store.commit('ui/toggleSettings', true); return true })()`)
  await sleep(900)
  say('boot2-settings-input', await j2.eval(settingsInput))
} catch (e) {
  say('ERROR2', String(e && e.stack || e).slice(0, 2000))
} finally {
  await j2.end({ keepDir: true })
  await rm(PERSIST, { recursive: true, force: true }).catch(() => {})
}
console.log('JOURNEY-B6 DONE')
