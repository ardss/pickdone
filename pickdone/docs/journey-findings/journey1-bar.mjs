/* Journey 1: bottom-bar circuit — idle baseline, start focus, label/clock behavior, abandon via modal. */
import { bootJourney } from '../../scripts/journey-driver.mjs'
import { mkdir, writeFile } from 'node:fs/promises'

const OUT = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const log = []
const say = (k, v) => { log.push([k, v]); console.log('##', k, JSON.stringify(v).slice(0, 2000)) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

const bar = `(() => {
  const q = s => document.querySelector(s)
  const txt = s => { const e = q(s); return e ? e.textContent.trim() : null }
  return {
    status: txt('.tomato-timer__status .tb-row:not(.tb-row--harvest)'),
    harvest: txt('.tb-row--harvest b'),
    clock: txt('.tomato-timer__time'),
    play: txt('.tomato-timer__play'),
    floatBtn: txt('.tb-float-toggle'),
    barClasses: (q('.tomato-bar') || {}).className,
    route: location.hash,
    title: document.title
  }
})()`
const lsState = `(() => { try { return JSON.parse(localStorage.getItem('tomatoState')) } catch (e) { return null } })()`

const j = await bootJourney({ cdpPort: 9382, seedConfig: { closeActionMinimize: false } })
try {
  await mkdir(OUT + 'shots', { recursive: true })
  await sleep(2500)
  say('idle-bar', await j.eval(bar))
  await j.shot(OUT + 'shots/j1-01-idle.png')
  say('idle-ls', await j.eval(lsState))

  // short durations via the REAL settings store surface (TomatoPanel/SettingsModal write the
  // same keys; min 5/1 enforced by the shared manifest clamp)
  say('set-durations', await j.eval(`(async () => { const r = await window.todoAPI.updateSettings({ tomatoTime: 5, restTime: 1 }); return r })()`))
  await sleep(800)
  say('after-set-bar', await j.eval(bar))
  say('after-set-ls', await j.eval(lsState))

  // Start focus
  say('click-start', await j.click('.tomato-timer__play'))
  await sleep(1500)
  say('run-bar-t1', await j.eval(bar))
  await j.shot(OUT + 'shots/j1-02-running.png')
  await sleep(6000)
  say('run-bar-t7', await j.eval(bar))
  say('run-ls-t7', await j.eval(lsState))
  await j.shot(OUT + 'shots/j1-03-running7s.png')

  // Give up via the play button (abandon modal path)
  say('click-giveup', await j.click('.tomato-timer__play'))
  await sleep(900)
  say('modal-visible', await j.eval(`(() => { const m = document.querySelector('.modal--abandon'); const card = document.querySelector('.abandon-card'); return { modal: !!m, cardText: card ? card.textContent.replace(/\\s+/g, ' ').trim().slice(0, 200) : null, focusedMin: (document.querySelector('.abandon-hint') || {}).textContent || null } })()`))
  await j.shot(OUT + 'shots/j1-04-abandon-modal.png')

  // Continue first (cancel path), then re-open and really give up
  say('click-continue', await j.click('.abandon-btn'))
  await sleep(600)
  say('after-continue-bar', await j.eval(bar))

  say('click-giveup2', await j.click('.tomato-timer__play'))
  await sleep(700)
  await j.fill('.abandon-reason-input', 'journey-audit test')
  await sleep(300)
  say('click-giveup-confirm', await j.click('.abandon-btn--giveup'))
  await sleep(1200)
  say('after-giveup-bar', await j.eval(bar))
  await j.shot(OUT + 'shots/j1-05-after-giveup.png')
  say('after-giveup-ls', await j.eval(lsState))
  say('ledger', await j.eval(`window.todoAPI.dbCall('tomatoAll')`))
  say('running-session-row', await j.eval(`window.todoAPI.dbCall('getMeta', 'tomatoRunningSession')`))
} catch (e) {
  say('ERROR', String(e && e.stack || e).slice(0, 3000))
  try { await j.shot(OUT + 'shots/j1-99-error.png') } catch { /* */ }
} finally {
  await writeFile(OUT + 'journey1-log.json', JSON.stringify(log), 'utf8')
  await j.end()
}
console.log('JOURNEY1 DONE')
