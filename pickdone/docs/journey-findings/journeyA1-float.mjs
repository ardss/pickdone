/* Journey A1: float deep-dive part 1 — idle content, live sync with bottom bar, real-OS drag,
   dblclick summon, in-card abandon confirm (continue + give up), ✕ behaviors, reopen. */
import { bootFocus } from './pomodoro-boot.mjs'
import { mkdir, writeFile } from 'node:fs/promises'

const OUT = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const log = []
const say = (k, v) => { log.push([k, v]); console.log('##', k, (JSON.stringify(v) ?? String(v) ?? 'undefined').slice(0, 2500)) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

const j = await bootFocus({ cdpPort: 9382 })
let f = null // float page cdp
try {
  await mkdir(OUT + 'shots', { recursive: true })
  await sleep(2500)
  // durations via real settings UI (same as journey2: modal input writes)
  await j.eval(`(() => { const app = document.querySelector('#app').__vue_app__; app.config.globalProperties.$store.commit('ui/toggleSettings', true); return true })()`)
  await sleep(800)
  const fillNum = (label, v) => `(() => { const i = document.querySelector('input[aria-label="${label}"]'); if (!i) return 'no-input'; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '${v}'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return i.value })()`
  await j.eval(fillNum('专注时长（分钟）：', 5))
  await sleep(300)
  await j.eval(fillNum('休息时长（分钟）：', 1))
  await sleep(500)
  await j.eval(`(() => { const x = document.querySelector('.modal--settings-center .modal__close'); if (x) x.click(); return true })()`)
  await sleep(7000) // float auto-shows ~6s after start (renderer main.js gate)
  say('targets', (await j.targets()).map(t => t.url))
  f = await j.connectPage('__tomato-float')
  const fstate = `(() => {
    const q = s => document.querySelector(s)
    const txt = s => { const e = q(s); return e ? e.textContent.trim() : null }
    return { clock: txt('.tomato__time'), phase: txt('.tomato__time small'), task: txt('.tomato__task'),
      beads: Array.from(document.querySelectorAll('.tomato__beads i')).map(i => i.className),
      knobIcon: txt('.tomato__knob-icon'), knobTitle: (q('.tomato__knob') || {}).title,
      badge: txt('.tomato__badge'), remote: txt('.tomato__remote') }
  })()`
  say('float-idle', await f.eval(fstate))
  await f.shot(OUT + 'shots/jA1-01-float-idle.png')

  // -- move MY instance's float to a unique spot (the user's real app also runs a float at the
  //    default bottom-right position; the OS drag below must hit THIS instance's card)
  const floatTargetId = async () => {
    const list = await (await fetch(j.cdpBase + '/json')).json()
    const t = list.find(x => x.type === 'page' && x.url.includes('__tomato-float'))
    return t && t.id
  }
  const boundsExpr = async c => {
    try {
      const tid = await floatTargetId()
      const w = await c.send('Browser.getWindowForTarget', tid ? { targetId: tid } : {}, 5000)
      const b = await c.send('Browser.getWindowBounds', { windowId: w.windowId }, 5000)
      if (b && b.bounds) return b.bounds
    } catch (e) { /* fall through to the renderer probe */ }
    // renderer probe: frameless window position in DIP (screen coords)
    return JSON.parse(await c.eval(`JSON.stringify({ left: window.screenX, top: window.screenY, width: window.outerWidth, height: window.outerHeight })`))
  }
  say('bounds-default', await boundsExpr(f))
  {
    const tid = await floatTargetId()
    const w = await f.send('Browser.getWindowForTarget', tid ? { targetId: tid } : {}, 5000)
    const r = await f.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { left: 120, top: 120, width: 240, height: 320 } }, 5000)
    await sleep(400)
    say('park-ipc', r && r.error ? ('ERROR ' + JSON.stringify(r.error)) : 'ok')
  }
  say('bounds-parked', await boundsExpr(f))

  // -- start focus from the BOTTOM BAR, watch the float sync
  say('start-from-bar', await j.click('.tomato-timer__play'))
  await sleep(1800)
  say('float-running', await f.eval(fstate))
  say('bar-running', await j.eval(`(() => ({ clock: (document.querySelector('.tomato-timer__time')||{}).textContent, status: (document.querySelector('.tomato-timer__status .tb-row')||{}).textContent }))()`))
  await f.shot(OUT + 'shots/jA1-02-float-running.png')

  // -- REAL OS drag (boundsExpr already declared above): this script pauses here; the auditor
  //    drags the card with the real mouse (windows_mcp) while the instance is alive, then
  //    touches drag-done.flag to resume.
  //    Parked bounds: left=120,top=120 DIP, scale 1.5 → card strip physical ≈ x 180..540, y 531..660.
  console.log('## PAUSE_FOR_OS_DRAG boundsBefore=' + JSON.stringify(await boundsExpr(f)))
  {
    const { existsSync } = await import('node:fs')
    const flag = OUT + 'drag-done.flag'
    const t0 = Date.now()
    while (!existsSync(flag) && Date.now() - t0 < 180000) await sleep(500)
    say('os-drag-flag', existsSync(flag) ? 'resumed' : 'timeout-continue')
  }
  say('bounds-after', await boundsExpr(f))

  // -- dblclick card summons main window (CDP-synthesized dblclick on the card body)
  say('float-dblclick', await f.eval(`(() => { const card = document.querySelector('.tomato'); const r = card.getBoundingClientRect(); const ev = new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + 20 }); card.dispatchEvent(ev); return 'dispatched' })()`))
  await sleep(1200)

  // -- float-side abandon confirm: click the ring knob
  say('click-knob', await f.eval(`(() => { document.querySelector('.tomato__knob').click(); return true })()`))
  await sleep(900)
  say('abandon-panel', await f.eval(`(() => { const p = document.querySelector('.tf-abandon'); return p ? { text: p.textContent.replace(/\\s+/g, ' ').trim(), giveUpBtn: !!p.querySelector('.mini.danger'), continueBtn: !!p.querySelector('.mini.primary') } : null })()`))
  await f.shot(OUT + 'shots/jA1-03-float-abandon.png')
  // abandon confirm open: the big digits switch to forward-counting 已专注
  say('abandon-clock', await f.eval(`(() => ({ clock: (document.querySelector('.tomato__time')||{}).textContent.trim(), giveupLabel: (document.querySelector('.tomato__giveup-label')||{}).textContent }))()`))
  // ✕ during abandon = cancel (title 关闭)
  say('x-title-abandoning', await f.eval(`document.querySelector('.corner-btn--muted').title`))
  say('click-x-cancel', await f.eval(`(() => { document.querySelector('.corner-btn--muted').click(); return true })()`))
  await sleep(600)
  say('after-x-cancel', await f.eval(`(() => ({ abandonPanel: !!document.querySelector('.tf-abandon'), clock: (document.querySelector('.tomato__time')||{}).textContent.trim() }))()`))

  // -- real give-up from the float
  say('click-knob2', await f.eval(`(() => { document.querySelector('.tomato__knob').click(); return true })()`))
  await sleep(700)
  say('click-giveup-float', await f.eval(`(() => { document.querySelector('.tf-abandon .mini.danger').click(); return true })()`))
  await sleep(1300)
  say('after-giveup-float-state', await f.eval(fstate))
  say('bar-after-float-giveup', await j.eval(`(() => ({ clock: (document.querySelector('.tomato-timer__time')||{}).textContent, play: (document.querySelector('.tomato-timer__play')||{}).textContent, harvest: (document.querySelector('.tb-row--harvest b')||{}).textContent }))()`))
  say('ledger-after-float-giveup', await j.eval(`window.todoAPI.dbCall('tomatoAll')`))
  say('session-row', await j.eval(`window.todoAPI.dbCall('getMeta', 'tomatoRunningSession')`))
  await f.shot(OUT + 'shots/jA1-04-float-after-giveup.png')

  // -- ✕ while idle closes the float
  say('float-idle-again', await f.eval(fstate))
  say('x-title-idle', await f.eval(`document.querySelector('.corner-btn--muted').title`))
  say('click-x-idle', await f.eval(`(() => { document.querySelector('.corner-btn--muted').click(); return true })()`))
  await sleep(1200)
  say('float-shown-after-x', await j.eval(`window.todoAPI.tomatoFloatShown()`))
  say('targets-after-x', (await j.targets()).map(t => t.url))
  say('bar-float-btn-after-x', await j.eval(`(() => ({ txt: (document.querySelector('.tb-float-toggle')||{}).textContent, cls: (document.querySelector('.tb-float-toggle')||{}).className }))()`))
  await j.shot(OUT + 'shots/jA1-05-after-x-idle.png')

  // -- reopen via the bottom bar 小窗
  say('click-float-toggle', await j.click('.tb-float-toggle'))
  await sleep(2500)
  say('float-shown-after-reopen', await j.eval(`window.todoAPI.tomatoFloatShown()`))
  f = await j.connectPage('__tomato-float')
  say('float-reopened', await f.eval(fstate))
  await f.shot(OUT + 'shots/jA1-06-float-reopened.png')
  say('bar-float-btn-after-reopen', await j.eval(`(() => ({ txt: (document.querySelector('.tb-float-toggle')||{}).textContent, cls: (document.querySelector('.tb-float-toggle')||{}).className }))()`))
} catch (e) {
  say('ERROR', String(e && e.stack || e).slice(0, 3000))
  try { if (f) await f.shot(OUT + 'shots/jA1-99-error.png') } catch { /* */ }
} finally {
  await writeFile(OUT + 'journeyA1-log.json', JSON.stringify(log), 'utf8')
  await j.end()
}
console.log('JOURNEY-A1 DONE')
