/* Journey 2 (v2): full completion circuit — durations via REAL settings UI, 5:00 focus auto-complete,
   rest phase, rest auto-finish, native taskbar title sampling, slim-bar on the calendar view. */
import { bootJourney } from '../../scripts/journey-driver.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { execSync } from 'node:child_process'

const OUT = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const log = []
const say = (k, v) => { log.push([k, v]); console.log('##', k, JSON.stringify(v).slice(0, 2500)) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

const nativeTitles = () => {
  try {
    const out = execSync('powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | ForEach-Object { $_.MainWindowTitle }"', { encoding: 'utf8', timeout: 15000 })
    return out.split(/\r?\n/).filter(Boolean)
  } catch (e) { return ['NATIVE-TITLE-PROBE-FAILED: ' + String(e).slice(0, 100)] }
}

const bar = `(() => {
  const q = s => document.querySelector(s)
  const txt = s => { const e = q(s); return e ? e.textContent.trim() : null }
  return {
    status: txt('.tomato-timer__status .tb-row:not(.tb-row--harvest)'),
    harvest: txt('.tb-row--harvest b'),
    clock: txt('.tomato-timer__time'),
    play: txt('.tomato-timer__play'),
    slim: !!q('.tomato-bar--slim'),
    route: location.hash
  }
})()`
const lsState = `(() => { try { return JSON.parse(localStorage.getItem('tomatoState')) } catch (e) { return null } })()`

const j = await bootJourney({ cdpPort: 9382, seedConfig: { closeActionMinimize: false } })
try {
  await mkdir(OUT + 'shots', { recursive: true })
  await sleep(2500)

  // -- Real settings UI: open modal, switch to 番茄钟 tab, write durations through the real inputs
  say('open-settings', await j.eval(`(() => { const app = document.querySelector('#app').__vue_app__; app.config.globalProperties.$store.commit('ui/toggleSettings', true); return true })()`))
  await sleep(900)
  say('click-tomato-tab', await j.eval(`(() => { const items = Array.from(document.querySelectorAll('.modal--settings-center .setting_tabs li')); const t = items.find(e => /番茄钟/.test(e.textContent.trim())); if (!t) return 'no-tomato-tab'; t.click(); return t.textContent.trim() })()`))
  await sleep(600)
  const fillNum = label => `(() => { const i = document.querySelector('input[aria-label="${label}"]'); if (!i) return 'no-input'; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '${label === '专注时长（分钟）：' ? '5' : '1'}'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return i.value })()`
  say('fill-focus-len', await j.eval(fillNum('专注时长（分钟）：')))
  await sleep(400)
  say('fill-rest-len', await j.eval(fillNum('休息时长（分钟）：')))
  await sleep(800)
  say('close-settings', await j.eval(`(() => { const x = document.querySelector('.modal--settings-center .modal__close'); if (x) { x.click(); return 'clicked' } return 'no-close-btn' })()`))
  await sleep(600)
  say('bar-after-settings', await j.eval(bar))
  say('ls-after-settings', await j.eval(lsState))
  await j.shot(OUT + 'shots/j2-02-idle-5min.png')

  // -- Start focus from the bottom bar
  say('start', await j.click('.tomato-timer__play'))
  await sleep(1500)
  say('run-bar', await j.eval(bar))
  say('native-title-run', nativeTitles())
  await j.shot(OUT + 'shots/j2-03-running.png')

  // -- slim bar on the calendar view mid-focus
  say('goto-calendar', await j.eval(`(() => { const app = document.querySelector('#app').__vue_app__; app.config.globalProperties.$router.push({ name: 'todo-list-calendar' }).catch(e => String(e)); return location.hash })()`))
  await sleep(900)
  say('slim-bar', await j.eval(bar))
  await j.shot(OUT + 'shots/j2-04-slim-running.png')
  say('back-today', await j.eval(`(() => { const app = document.querySelector('#app').__vue_app__; app.config.globalProperties.$router.push({ name: 'todo-list-today' }).catch(() => {}); return true })()`))
  await sleep(600)

  // -- Wait out the 5:00 focus (auto-completion via the shared tick)
  let rested = false
  for (let t = 0; t < 70 && !rested; t++) {
    await sleep(5000)
    const st = await j.eval(lsState)
    if (st && st.status === 'startRestTime') { rested = true; say('rest-detected', { waitedS: (t + 1) * 5, st }) }
    else if (t === 5 || t === 20 || t === 40) say('mid-run-sample', { t: (t + 1) * 5, bar: await j.eval(bar), title: nativeTitles() })
    else if (st && st.status === 'default') { say('unexpected-default', st); break }
  }
  say('rest-bar', await j.eval(bar))
  say('rest-ls', await j.eval(lsState))
  say('native-title-rest', nativeTitles())
  await j.shot(OUT + 'shots/j2-05-rest.png')
  say('ledger-after-complete', await j.eval(`window.todoAPI.dbCall('tomatoAll')`))
  say('session-row-at-rest', await j.eval(`window.todoAPI.dbCall('getMeta', 'tomatoRunningSession')`))

  // -- Wait out the 1:00 rest
  let idle = false
  for (let t = 0; t < 30 && !idle; t++) {
    await sleep(4000)
    const st = await j.eval(lsState)
    if (st && st.status === 'default') { idle = true; say('idle-after-rest', { waitedS: (t + 1) * 4, st }) }
  }
  say('idle-bar-final', await j.eval(bar))
  say('native-title-idle', nativeTitles())
  await j.shot(OUT + 'shots/j2-06-after-rest.png')
  say('ledger-final', await j.eval(`window.todoAPI.dbCall('tomatoAll')`))
  say('session-row-final', await j.eval(`window.todoAPI.dbCall('getMeta', 'tomatoRunningSession')`))
} catch (e) {
  say('ERROR', String(e && e.stack || e).slice(0, 3000))
  try { await j.shot(OUT + 'shots/j2-99-error.png') } catch { /* */ }
} finally {
  await writeFile(OUT + 'journey2-log.json', JSON.stringify(log), 'utf8')
  await j.end()
}
console.log('JOURNEY2 DONE')
