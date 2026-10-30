/* Journey B: TomatoPanel duration desync (panel writes tomato/patch only — where does the value
   NOT update?) + harvest counter persistence across reboot (persistent data dir). */
import { bootFocus } from './pomodoro-boot.mjs'
import { mkdir, writeFile, rm } from 'node:fs/promises'

const OUT = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const PERSIST = OUT + 'persist-dir'
const log = []
const say = (k, v) => { log.push([k, v]); console.log('##', k, (JSON.stringify(v) ?? 'undefined').slice(0, 2200)) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

const lsState = `(() => { try { return JSON.parse(localStorage.getItem('tomatoState')) } catch (e) { return null } })()`
const settingsInput = `(() => { const i = document.querySelector('input[aria-label="专注时长（分钟）："]'); return i ? i.value : 'no-input' })()`

await rm(PERSIST, { recursive: true, force: true }).catch(() => {})
const j = await bootFocus({ cdpPort: 9382, persistentDataDir: PERSIST })
try {
  await mkdir(OUT + 'shots', { recursive: true })
  await sleep(2500)
  // durations 5/1 via the settings page (the mirroring path)
  await j.eval(`(() => { const app = document.querySelector('#app').__vue_app__; app.config.globalProperties.$store.commit('ui/toggleSettings', true); return true })()`)
  await sleep(800)
  const fillNum = (label, v) => `(() => { const i = document.querySelector('input[aria-label="${label}"]'); if (!i) return 'no-input'; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '${v}'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return i.value })()`
  await j.eval(fillNum('专注时长（分钟）：', 5))
  await sleep(300)
  await j.eval(fillNum('休息时长（分钟）：', 1))
  await sleep(500)
  say('baseline-settings-input', await j.eval(settingsInput))
  say('baseline-ls', (await j.eval(lsState) || {}).tomatoTime)

  // ---- PANEL DESYNC PROBE: change 专注时长 via the TomatoPanel stepper ----
  say('open-panel-btn', await j.eval(`(() => { const btns = Array.from(document.querySelectorAll('button')); const b = btns.find(x => x.textContent.includes('打开番茄钟面板')); if (!b) return 'no-btn'; b.click(); return 'clicked' })()`))
  await sleep(900)
  say('panel-visible', await j.eval(`(() => { const p = document.querySelector('.tomato-panel'); return p ? p.textContent.slice(0, 120) : null })()`))
  await j.shot(OUT + 'shots/jB-01-panel.png')
  say('panel-fill-10', await j.eval(`(() => { const i = document.querySelector('.tomato-panel .cfg-row input'); if (!i) return 'no-input'; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '10'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return i.value })()`))
  await sleep(900)
  say('probe-ls-blob', (await j.eval(lsState) || {}).tomatoTime)
  say('probe-settings-input', await j.eval(settingsInput))
  say('probe-settings-rows', await j.eval(`window.todoAPI.dbCall('settingsRowsAll').then(rows => (rows || []).filter(r => JSON.stringify(r).includes('tomatoTime')).map(r => JSON.stringify(r)).slice(0, 3))`))
  await j.shot(OUT + 'shots/jB-02-panel-10-settings.png')

  // restore panel to 5, then complete one real 5:00 focus for the harvest-persistence leg
  say('panel-fill-5', await j.eval(`(() => { const i = document.querySelector('.tomato-panel .cfg-row input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '5'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return i.value })()`))
  await sleep(600)
  say('close-panel', await j.eval(`(() => { const x = document.querySelector('.tomato-panel .close-x'); if (x) { x.click(); return true } return false })()`))
  await sleep(400)
  say('close-settings', await j.eval(`(() => { const x = document.querySelector('.modal--settings-center .modal__close'); if (x) x.click(); return true })()`))
  await sleep(600)
  await j.click('.tomato-timer__play')
  let rested = false
  for (let t = 0; t < 70 && !rested; t++) {
    await sleep(5000)
    const st = await j.eval(lsState)
    if (st && st.status === 'startRestTime') { rested = true; say('completed-at', { waitedS: (t + 1) * 5 }) }
  }
  say('harvest-after-complete', await j.eval(`(document.querySelector('.tb-row--harvest b') || {}).textContent`))
  // quick give-up (abandon row) — counter must stay 1
  await j.click('.tomato-timer__play')
  await sleep(800)
  await j.click('.abandon-btn--giveup')
  await sleep(1200)
  say('harvest-after-giveup', await j.eval(`(document.querySelector('.tb-row--harvest b') || {}).textContent`))
  say('ledger-before-reboot', await j.eval(`window.todoAPI.dbCall('tomatoAll')`))
  // final divergence: panel→10 with settings ledger at 5, then kill
  await j.eval(`(() => { const app = document.querySelector('#app').__vue_app__; app.config.globalProperties.$store.commit('ui/toggleSettings', true); return true })()`)
  await sleep(700)
  say('reopen-panel-btn', await j.eval(`(() => { const btns = Array.from(document.querySelectorAll('button')); const b = btns.find(x => x.textContent.includes('打开番茄钟面板')); if (!b) return 'no-btn'; b.click(); return 'clicked' })()`))
  await sleep(800)
  say('final-panel-fill-10', await j.eval(`(() => { const i = document.querySelector('.tomato-panel .cfg-row input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '10'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return i.value })()`))
  await sleep(700)
  say('final-ls-blob', (await j.eval(lsState) || {}).tomatoTime)
  say('final-settings-input', await j.eval(settingsInput))
} catch (e) {
  say('ERROR', String(e && e.stack || e).slice(0, 2500))
} finally {
  await writeFile(OUT + 'journeyB-log.json', JSON.stringify(log), 'utf8')
  await j.end({ keepDir: true })
}

// ---- BOOT 2: same data dir — what survived? ----
const j2 = await bootFocus({ cdpPort: 9382, persistentDataDir: PERSIST })
try {
  await sleep(3000)
  say('boot2-bar', await j2.eval(`(() => ({ clock: (document.querySelector('.tomato-timer__time') || {}).textContent, harvest: (document.querySelector('.tb-row--harvest b') || {}).textContent, label: (document.querySelector('.tomato-timer__status .tb-row') || {}).textContent }))()`))
  say('boot2-ls-immediate', await j2.eval(lsState))
  await sleep(4000) // let the settings ledger hydrate from the DB
  say('boot2-ls-after-settings-hydration', await j2.eval(lsState))
  say('boot2-bar-after-hydration', await j2.eval(`(() => ({ clock: (document.querySelector('.tomato-timer__time') || {}).textContent, harvest: (document.querySelector('.tb-row--harvest b') || {}).textContent }))()`))
  await j2.eval(`(() => { const app = document.querySelector('#app').__vue_app__; app.config.globalProperties.$store.commit('ui/toggleSettings', true); return true })()`)
  await sleep(900)
  say('boot2-settings-input', await j2.eval(settingsInput))
  await j2.shot(OUT + 'shots/jB-03-boot2.png')
} catch (e) {
  say('ERROR2', String(e && e.stack || e).slice(0, 2500))
} finally {
  await j2.end({ keepDir: true })
  await rm(PERSIST, { recursive: true, force: true }).catch(() => {})
}
console.log('JOURNEY-B DONE')
