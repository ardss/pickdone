/* Journey B4: J5 post-rebuild re-verify — panel sets 10: all surfaces move to 10 AND STAY past
   the ~1.5s echo mark (the old bounce), settings input/blob agree, reboot keeps 10. */
import { bootFocus } from './pomodoro-boot.mjs'
import { mkdir, writeFile, rm } from 'node:fs/promises'

const OUT = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const PERSIST = OUT + 'persist-dir-b4'
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
  const fillNum = (sel, v) => `(() => { const i = document.querySelector('${sel}'); if (!i) return 'no-input'; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '${v}'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return i.value })()`
  say('settings-fill-5', await j.eval(fillNum('input[aria-label="专注时长（分钟）："]', 5)))
  await sleep(2500) // let the settings echo fully settle
  await j.eval(`(() => { const btns = Array.from(document.querySelectorAll('button')); const b = btns.find(x => x.textContent.includes('打开番茄钟面板')); if (!b) return 'no-btn'; b.click(); return 'clicked' })()`)
  await sleep(900)
  say('panel-fill-10', await j.eval(fillNum('.tomato-panel .cfg-row input', 10)))
  for (const t of [500, 1600, 2500, 4000]) {
    await sleep(t === 500 ? 500 : t - [500, 1600, 2500, 4000][[500, 1600, 2500, 4000].indexOf(t) - 1])
    const sample = await j.eval(`(() => ({ blob: (JSON.parse(localStorage.getItem('tomatoState')) || {}).tomatoTime, settingsInput: (document.querySelector('input[aria-label="专注时长（分钟）："]') || {}).value, panelInput: (document.querySelector('.tomato-panel .cfg-row input') || {}).value, barClock: (document.querySelector('.tomato-timer__time') || {}).textContent }))()`)
    say('sample-t' + t + 'ms', sample)
  }
  await j.shot(OUT + 'shots/jB4-01-stays10.png')
} catch (e) {
  say('ERROR', String(e && e.stack || e).slice(0, 2000))
} finally {
  await j.end({ keepDir: true })
}

// boot 2: the reboot leg — 10 must survive (settings ledger carries it now)
const j2 = await bootFocus({ cdpPort: 9382, persistentDataDir: PERSIST })
try {
  await sleep(3000)
  say('boot2-clock', await j2.eval(`(document.querySelector('.tomato-timer__time') || {}).textContent`))
  say('boot2-blob', (await j2.eval(lsState) || {}).tomatoTime)
  await sleep(3000)
  say('boot2-clock-after-hydration', await j2.eval(`(document.querySelector('.tomato-timer__time') || {}).textContent`))
  say('boot2-blob-after-hydration', (await j2.eval(lsState) || {}).tomatoTime)
  await j2.eval(`(() => { const app = document.querySelector('#app').__vue_app__; app.config.globalProperties.$store.commit('ui/toggleSettings', true); return true })()`)
  await sleep(900)
  say('boot2-settings-input', await j2.eval(settingsInput))
  await j2.shot(OUT + 'shots/jB4-02-reboot-keeps10.png')
} catch (e) {
  say('ERROR2', String(e && e.stack || e).slice(0, 2000))
} finally {
  await j2.end({ keepDir: true })
  await rm(PERSIST, { recursive: true, force: true }).catch(() => {})
}
console.log('JOURNEY-B4 DONE')
