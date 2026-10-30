/* Journey V: post-rebuild live re-verify of J2 (float ✕ → bar toggle syncs instantly, next click
   reopens) and J3 (running knob glyph is the stop ■, not a pause ❚❚) on the current dist. */
import { bootFocus } from './pomodoro-boot.mjs'
import { mkdir, writeFile, rm } from 'node:fs/promises'

const OUT = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const PERSIST = OUT + 'persist-dir-v'
const log = []
const say = (k, v) => { log.push([k, v]); console.log('##', k, (JSON.stringify(v) ?? 'undefined').slice(0, 2000)) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

await rm(PERSIST, { recursive: true, force: true }).catch(() => {})
const j = await bootFocus({ cdpPort: 9382, persistentDataDir: PERSIST })
let f = null
try {
  await mkdir(OUT + 'shots', { recursive: true })
  await sleep(2500)
  await sleep(7000) // float auto-show
  f = await j.connectPage('__tomato-float')
  await f.eval('window.moveTo(120, 120)')
  await sleep(300)

  // J3: start focus from the BAR, check the knob glyph
  await j.click('.tomato-timer__play')
  await sleep(1800)
  say('j3-knob-running', await f.eval(`(() => ({ icon: (document.querySelector('.tomato__knob-icon') || {}).textContent, title: (document.querySelector('.tomato__knob') || {}).title }))()`))
  await f.shot(OUT + 'shots/jV-01-knob-stop-glyph.png')

  // give up via float (confirm → 放弃) to get back to idle
  await f.eval(`document.querySelector('.tomato__knob').click()`)
  await sleep(700)
  await f.eval(`document.querySelector('.tf-abandon .mini.danger').click()`)
  await sleep(1200)
  say('idle-again', await f.eval(`(document.querySelector('.tomato__time') || {}).textContent`))

  // J2: bar button shows on (float open) → ✕ close on the float → bar must flip OFF immediately
  say('bar-btn-before-x', await j.eval(`(() => { const b = document.querySelector('.tb-float-toggle'); return { txt: b.textContent.trim(), on: b.classList.contains('on') } })()`))
  await f.eval(`document.querySelector('.corner-btn--muted').click()`)
  await sleep(900)
  say('shown-after-x', await j.eval(`window.todoAPI.tomatoFloatShown()`))
  say('bar-btn-after-x-t0.9s', await j.eval(`(() => { const b = document.querySelector('.tb-float-toggle'); return { txt: b.textContent.trim(), on: b.classList.contains('on') } })()`))
  // next click must REOPEN (the old bug: swallowed)
  await j.click('.tb-float-toggle')
  await sleep(1800)
  say('shown-after-reopen-click', await j.eval(`window.todoAPI.tomatoFloatShown()`))
  say('bar-btn-after-reopen', await j.eval(`(() => { const b = document.querySelector('.tb-float-toggle'); return { txt: b.textContent.trim(), on: b.classList.contains('on') } })()`))
  await j.shot(OUT + 'shots/jV-02-reopened.png')
  // close again via the bar (round-trip hygiene)
  await j.click('.tb-float-toggle')
  await sleep(1200)
  say('shown-after-bar-close', await j.eval(`window.todoAPI.tomatoFloatShown()`))
} catch (e) {
  say('ERROR', String(e && e.stack || e).slice(0, 2000))
} finally {
  await writeFile(OUT + 'journeyV-log.json', JSON.stringify(log), 'utf8')
  await j.end({ keepDir: true })
  await rm(PERSIST, { recursive: true, force: true }).catch(() => {})
}
console.log('JOURNEY-V DONE')
