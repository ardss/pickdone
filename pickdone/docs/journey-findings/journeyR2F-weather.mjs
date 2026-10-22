/* Round-2 Journey R2F: weather widget — enable via the real settings switch, observe the
   SideNav widget appear (or its offline/error state), toggle back off. Network may be absent:
   the contract under test is graceful degradation, not forecast accuracy. */
import { bootJourney } from '../../scripts/journey-driver.mjs'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = dirname(fileURLToPath(import.meta.url))
const log = []
const say = (k, v) => { log.push([k, v]); console.log('##', k, (JSON.stringify(v) ?? 'undefined').slice(0, 700)) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

const j = await bootJourney({ cdpPort: 9382, seedConfig: { closeActionMinimize: false } })
try {
  await sleep(2500)
  say('widget-before', await j.eval(`(() => { const w = document.querySelector('.weather, [class*=weather]'); return w ? w.className : null })()`))
  // settings → enable 天气显示 (switch bound to set({weatherEnabled:v}))
  await j.eval(`(() => { const app = document.querySelector('#app').__vue_app__; app.config.globalProperties.$store.commit('ui/toggleSettings', true); return true })()`)
  await sleep(800)
  // the weather switch lives on one of the modal's tabs — walk them until it appears
  say('weather-switch-click', await j.eval(`(async () => {
    const findSw = () => { const items = Array.from(document.querySelectorAll('.form-item')); const it = items.find(e => e.textContent.includes('天气')); return it ? it.querySelector('.el-switch') : null }
    let sw = findSw()
    const tabs = Array.from(document.querySelectorAll('.settings-tabs > *, .settings-nav > *, [class*=tab]')).filter(t => t.offsetWidth > 0)
    for (const t of tabs) { if (sw) break; try { t.click() } catch (e) {} await new Promise(r => setTimeout(r, 350)); sw = findSw() }
    if (!sw) return 'no-item-after-tabs(' + tabs.length + ')'
    sw.click(); return 'clicked'
  })()`, 15000))
  await sleep(700)
  await j.eval(`(() => { const x = document.querySelector('.modal--settings-center .modal__close'); if (x) x.click(); return true })()`)
  await sleep(4000) // widget fetch window
  say('widget-after', await j.eval(`(() => { const w = document.querySelector('.weather, [class*=weather]'); return w ? { cls: w.className, text: w.textContent.replace(/\\s+/g, ' ').slice(0, 120) } : null })()`))
  await j.shot(OUT + 'shots/jR2F-01-weather.png')
  // toggle back off
  await j.eval(`(() => { const app = document.querySelector('#app').__vue_app__; app.config.globalProperties.$store.commit('ui/toggleSettings', true); return true })()`)
  await sleep(700)
  await j.eval(`(async () => { const findSw = () => { const items = Array.from(document.querySelectorAll('.form-item')); const it = items.find(e => e.textContent.includes('天气')); return it ? it.querySelector('.el-switch') : null }; let sw = findSw(); const tabs = Array.from(document.querySelectorAll('.settings-tabs > *, .settings-nav > *, [class*=tab]')).filter(t => t.offsetWidth > 0); for (const t of tabs) { if (sw) break; try { t.click() } catch (e) {} await new Promise(r => setTimeout(r, 350)); sw = findSw() }; if (sw) sw.click(); return true })()`, 15000)
  await sleep(800)
  await j.eval(`(() => { const x = document.querySelector('.modal--settings-center .modal__close'); if (x) x.click(); return true })()`)
  await sleep(2500)
  say('widget-after-off', await j.eval(`(() => { const w = document.querySelector('.weather, [class*=weather]'); return w ? w.className : null })()`))
} catch (e) {
  say('ERROR', String(e && e.stack || e).slice(0, 1500))
} finally {
  writeFileSync(join(OUT, 'journeyR2F-log.json'), JSON.stringify(log), 'utf8')
  await j.end()
}
console.log('JOURNEY-R2F DONE')
