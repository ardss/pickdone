/* Journey A1b: (1) real-OS drag with prompt verification, (2) the J2 defect cycle —
   float ✕ close → bar toggle stale → first bar click swallowed → second click reopens. */
import { bootFocus } from './pomodoro-boot.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

const OUT = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const log = []
const say = (k, v) => { log.push([k, v]); console.log('##', k, (JSON.stringify(v) ?? 'undefined').slice(0, 2000)); }
const sleep = ms => new Promise(r => setTimeout(r, ms))

const j = await bootFocus({ cdpPort: 9382 })
let f = null
try {
  await mkdir(OUT + 'shots', { recursive: true })
  await sleep(2500)
  await j.eval(`(() => { const app = document.querySelector('#app').__vue_app__; app.config.globalProperties.$store.commit('ui/toggleSettings', true); return true })()`)
  await sleep(800)
  const fillNum = (label, v) => `(() => { const i = document.querySelector('input[aria-label="${label}"]'); if (!i) return 'no-input'; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '${v}'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return i.value })()`
  await j.eval(fillNum('专注时长（分钟）：', 5))
  await sleep(300)
  await j.eval(fillNum('休息时长（分钟）：', 1))
  await sleep(500)
  await j.eval(`(() => { const x = document.querySelector('.modal--settings-center .modal__close'); if (x) x.click(); return true })()`)
  await sleep(7000)
  f = await j.connectPage('__tomato-float')
  say('float-idle', await f.eval(`window.screenX + ',' + window.screenY + ' ' + (document.querySelector('.tomato__time')||{}).textContent`))
  // park top-left via renderer moveTo (Browser domain unavailable in this Electron CDP)
  await f.eval('window.moveTo(120, 120)')
  await sleep(400)
  say('parked', await f.eval('window.screenX + "," + window.screenY'))

  // start focus so the drag happens on a live card (worst case for the 16ms timer)
  await j.click('.tomato-timer__play')
  await sleep(1500)
  say('running', await f.eval(`(document.querySelector('.tomato__time')||{}).textContent`))
  console.log('## PAUSE_FOR_OS_DRAG park=(120,120)DIP physical-card=(180..540, 531..660) scale=1.5')
  {
    const flag = OUT + 'dragb-done.flag'
    const t0 = Date.now()
    while (!existsSync(flag) && Date.now() - t0 < 150000) await sleep(400)
  }
  say('bounds-after-drag', await f.eval('JSON.stringify({ x: window.screenX, y: window.screenY })'))
  await f.shot(OUT + 'shots/jA1b-01-after-drag.png')

  // give up from the float (knob → confirm → 放弃)
  await f.eval(`document.querySelector('.tomato__knob').click()`)
  await sleep(800)
  await f.eval(`document.querySelector('.tf-abandon .mini.danger').click()`)
  await sleep(1300)
  say('idle-again', await f.eval(`(document.querySelector('.tomato__time')||{}).textContent`))

  // ---- J2 defect cycle ----
  say('bar-btn-before-close', await j.eval(`(() => { const b = document.querySelector('.tb-float-toggle'); return { txt: b.textContent.trim(), on: b.classList.contains('on') } })()`))
  await f.eval(`document.querySelector('.corner-btn--muted').click()`) // ✕ while idle = close
  await sleep(1200)
  say('shown-after-x', await j.eval(`window.todoAPI.tomatoFloatShown()`))
  say('bar-btn-after-x-t1s', await j.eval(`(() => { const b = document.querySelector('.tb-float-toggle'); return { txt: b.textContent.trim(), on: b.classList.contains('on') } })()`))
  // user's first click after ✕-close (intent: reopen)
  await j.click('.tb-float-toggle')
  await sleep(1500)
  say('shown-after-click1', await j.eval(`window.todoAPI.tomatoFloatShown()`))
  say('bar-btn-after-click1', await j.eval(`(() => { const b = document.querySelector('.tb-float-toggle'); return { txt: b.textContent.trim(), on: b.classList.contains('on') } })()`))
  // second click
  await j.click('.tb-float-toggle')
  await sleep(2000)
  say('shown-after-click2', await j.eval(`window.todoAPI.tomatoFloatShown()`))
  say('bar-btn-after-click2', await j.eval(`(() => { const b = document.querySelector('.tb-float-toggle'); return { txt: b.textContent.trim(), on: b.classList.contains('on') } })()`))
  await j.shot(OUT + 'shots/jA1b-02-final.png')
} catch (e) {
  say('ERROR', String(e && e.stack || e).slice(0, 2500))
} finally {
  await writeFile(OUT + 'journeyA1b-log.json', JSON.stringify(log), 'utf8')
  await j.end()
}
console.log('JOURNEY-A1B DONE')
