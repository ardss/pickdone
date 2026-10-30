/* Journey B2: the J4 revert leg — panel sets 专注=10 (divergence: tomato blob 10 vs settings 5),
   kill, reboot on the same dir → the settings-ledger restore mirrors 5 back over the panel's 10. */
import { bootFocus } from './pomodoro-boot.mjs'
import { mkdir, writeFile, rm } from 'node:fs/promises'

const OUT = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const PERSIST = OUT + 'persist-dir-b2'
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
  await sleep(400)
  await j.eval(`(() => { const btns = Array.from(document.querySelectorAll('button')); const b = btns.find(x => x.textContent.includes('打开番茄钟面板')); if (!b) return 'no-btn'; b.click(); return 'clicked' })()`)
  await sleep(900)
  say('panel-fill-10', await j.eval(`(() => { const i = document.querySelector('.tomato-panel .cfg-row input'); if (!i) return 'no-input'; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '10'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return i.value })()`))
  await sleep(800)
  say('divergence-blob', (await j.eval(lsState) || {}).tomatoTime)
  say('divergence-settings-input', await j.eval(settingsInput))
  await j.shot(OUT + 'shots/jB2-01-divergence.png')
} catch (e) {
  say('ERROR', String(e && e.stack || e).slice(0, 2000))
} finally {
  await j.end({ keepDir: true })
}

// boot 2 on the diverged dir
const j2 = await bootFocus({ cdpPort: 9382, persistentDataDir: PERSIST })
try {
  await sleep(2600)
  say('boot2-clock-immediate', await j2.eval(`(document.querySelector('.tomato-timer__time') || {}).textContent`))
  say('boot2-blob-immediate', (await j2.eval(lsState) || {}).tomatoTime)
  await sleep(4500)
  say('boot2-clock-after-hydration', await j2.eval(`(document.querySelector('.tomato-timer__time') || {}).textContent`))
  say('boot2-blob-after-hydration', (await j2.eval(lsState) || {}).tomatoTime)
  await j2.eval(`(() => { const app = document.querySelector('#app').__vue_app__; app.config.globalProperties.$store.commit('ui/toggleSettings', true); return true })()`)
  await sleep(900)
  say('boot2-settings-input', await j2.eval(settingsInput))
  await j2.shot(OUT + 'shots/jB2-02-after-reboot.png')
} catch (e) {
  say('ERROR2', String(e && e.stack || e).slice(0, 2000))
} finally {
  await j2.end({ keepDir: true })
  await rm(PERSIST, { recursive: true, force: true }).catch(() => {})
}
console.log('JOURNEY-B2 DONE')
