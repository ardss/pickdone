/**
 * d2-crosscutting-auditor — round-2 cross-cutting sweep, v3 (i18n en-US parity + keyboard + console + 404s).
 *
 * v3 changes (v2 lessons, 2026-10-22):
 *  - best-effort boot-onboarding close BEFORE seeding (v2's wizard likely covered quick-add),
 *    seeding via the inline QuickAdd's REAL input `.qa-input` + Enter keydown (#quick-add-input
 *    and `.btn-add` do not exist on this build), `.el-message` toasts captured.
 *  - settings walks ALL el-tabs__item dynamically (v2 hardcoded 5 of the 8 real tabs and missed
 *    shortcuts/sync/data), category/tag store paths discovered at runtime, phase-2 boot retries
 *  - NEW keyboard section: Tab-order trace on the main list, real CDP Enter in quick-add,
 *    Esc on the settings modal (focus inside vs body), ArrowDown roving row focus (D4).
 *
 * Output: d2-i18n-log.json + shots/d2-*.png. Review like a user (READ the shots).
 */
import { bootJourney } from '../../scripts/journey-driver.mjs'
import { bootFocus } from './pomodoro-boot.mjs'
import { writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, 'shots')
await mkdir(SHOTS, { recursive: true })

const CJK = /[\u4e00-\u9fff]/
const log = { boot: {}, surfaces: {}, console: [], net404: [], keyboard: {}, steps: [] }
const step = (name, data) => { log.steps.push({ t: Date.now(), name, data }); console.log('[d2]', name, data === undefined ? '' : JSON.stringify(data).slice(0, 300)) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const safe = async (name, fn) => { try { return await fn() } catch (e) { step('FAIL ' + name, String(e).slice(0, 220)) } }

async function attachMonitor (j, bucket) {
  const mon = await j.connectPage('index.html')
  const orig = mon.ws.onmessage
  mon.ws.onmessage = e => {
    try {
      const m = JSON.parse(e.data)
      if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
        bucket.console.push({ kind: 'console.' + m.params.type, text: (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 400), ts: Date.now() })
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails || {}
        bucket.console.push({ kind: 'exception', text: String(d.exception?.description || d.text || '').slice(0, 400), ts: Date.now() })
      } else if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) {
        bucket.console.push({ kind: 'log.' + m.params.entry.level, text: String(m.params.entry.text || '').slice(0, 300), url: m.params.entry.url, ts: Date.now() })
      } else if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) {
        bucket.net404.push({ status: m.params.response.status, url: String(m.params.response.url).slice(0, 220), ts: Date.now() })
      }
    } catch { /* keep the driver's own handler alive */ }
    orig(e)
  }
  for (const d of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) {
    try { await mon.send(d, {}) } catch { /* some domains self-enable */ }
  }
  return mon
}

/** One real CDP key event (trusted-path keydown/keyup at the focused element). */
const pressKey = (mon, key, { code, vk, mods = {} } = {}) => mon.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: code || key, windowsVirtualKeyCode: vk || 0, nativeVirtualKeyCode: vk || 0, modifiers: (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.shift ? 8 : 0) })
  .then(() => mon.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: code || key, windowsVirtualKeyCode: vk || 0, nativeVirtualKeyCode: vk || 0 }))

const DUMP_EXPR = `(() => {
  const vis = el => { try { return el && el.getClientRects().length > 0 } catch (e) { return false } }
  const texts = []
  document.querySelectorAll('body *').forEach(el => {
    if (!vis(el)) return
    for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) texts.push(n.textContent.trim())
  })
  const attrs = []
  document.querySelectorAll('input,textarea,[placeholder],[title],[aria-label]').forEach(el => {
    if (!vis(el)) return
    const p = el.getAttribute('placeholder') || '', t = el.getAttribute('title') || '', a = el.getAttribute('aria-label') || ''
    if (p || t || a) attrs.push((p ? 'P:' + p + ' ' : '') + (t ? 'T:' + t + ' ' : '') + (a ? 'A:' + a : ''))
  })
  return JSON.stringify({ hash: location.hash, title: document.title, texts: [...new Set(texts)], attrs: [...new Set(attrs)] })
})()`

async function dumpInto (j, bucket, name) {
  try {
    const parsed = JSON.parse(await j.eval(DUMP_EXPR))
    parsed.cjk = [...new Set([...parsed.texts, ...parsed.attrs].filter(s => CJK.test(s)))]
    bucket.surfaces[name] = parsed
    await j.shot(join(SHOTS, `d2-${name}.png`)).catch(e => step('shot-fail ' + name, String(e).slice(0, 120)))
    step('surface', { name, texts: parsed.texts.length, cjk: parsed.cjk.length })
    return parsed
  } catch (e) { step('dump-fail ' + name, String(e).slice(0, 200)); return null }
}

const go = async (j, bucket, hash, name, settleMs = 1200) => {
  try { await j.eval(`location.hash = ${JSON.stringify(hash)}; true`) } catch (e) { step('nav-fail ' + name, String(e).slice(0, 120)) }
  await sleep(settleMs)
  const d = await dumpInto(j, bucket, name)
  if (!d) { // one retry — a transient CDP timeout must not amputate a whole surface
    await sleep(1500)
    return dumpInto(j, bucket, name)
  }
  return d
}

/** Real quick-add: fill the inline panel's input + ENTER KEYUP — the house test idiom
 *  (tests/ui-interactions.mjs:176, ui-coverage enterIn): QuickAdd listens on keyup.enter. */
const qaAdd = async (j, text) => {
  await j.eval(`(() => { const el = document.querySelector('.qa-input'); if (!el) throw new Error('no .qa-input; visible inputs: ' + [...document.querySelectorAll('input')].filter(i => i.getClientRects().length).map(i => i.className + '|' + (i.placeholder || '')).join(';')); el.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
  await j.eval(`(() => { const el = document.querySelector('.qa-input'); if (!el) throw new Error('no .qa-input'); const e = new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }); Object.defineProperty(e, 'isComposing', { value: false }); el.dispatchEvent(e); return true })()`)
  await sleep(900)
  const rows = await j.eval(`(window.appUI.$store.state.todo.list || []).length`)
  return j.eval(`JSON.stringify({ rows: ${rows}, toasts: [...document.querySelectorAll('.el-message')].map(m => m.innerText.slice(0, 120)) })`)
}

const describeActive = `(() => { const a = document.activeElement; return a ? (a.tagName + '.' + String(a.className).split(' ')[0] + '|' + (a.getAttribute && (a.getAttribute('aria-label') || a.getAttribute('placeholder')) || (a.textContent || '').trim().slice(0, 30))) : 'none' })()`

/* ================= PHASE 1: en-US main-shell sweep ================= */
let j = null
let mon = null
try {
  j = await bootJourney({ cdpPort: 9384, seedConfig: { appLocale: 'en-US' } })
  mon = await attachMonitor(j, log)
  await j.waitFor('window.appUI && window.appUI.$store && window.appUI.$store.state.todo && window.appUI.$store.state.settings')
  await sleep(1500)
  log.boot.locale = JSON.parse(await j.eval(`JSON.stringify({
    ls: localStorage.getItem('appLocale'), store: window.appUI.$store.state.settings.appLocale,
    htmlLang: document.documentElement.lang, i18n: window.appUI.$i18n ? window.appUI.$i18n.locale : null, nav: navigator.language })`))
  step('locale-at-boot (D2-LOC defect evidence)', log.boot.locale)

  await safe('boot-onboarding-close', async () => {
    // SCOPE the clicks to onboarding-container buttons only — v3's page-wide text match once
    // risked clicking unrelated visible buttons (e.g. the bar's start button).
    for (let i = 0; i < 8; i++) {
      const ok = await j.eval(`(() => { const scope = [...document.querySelectorAll('[class*=onboard],[class*=wizard],[class*=guide],[class*=tour]')].filter(x => x.getClientRects().length); for (const s of scope) { const b = [...s.querySelectorAll('button')].find(x => x.getClientRects().length && /Skip|Done|Got it|Finish|完成|跳过|开始/i.test(x.textContent || '')); if (b) { b.click(); return true } } return false })()`)
      await sleep(500)
      if (!ok) break
    }
    const wiz = await j.eval(`(() => { const cands = [...document.querySelectorAll('[class*=onboard],[class*=wizard],[class*=guide]')].filter(x => x.getClientRects().length); return cands.length })()`)
    step('onboarding-closed', { remainingOverlayNodes: wiz })
  })

  // Seed the LS boot cache + reload so the parity walk runs on a REAL English UI
  await safe('ls-seed-reload', async () => {
    await j.eval(`localStorage.setItem('appLocale', 'en-US'); location.reload(); true`)
    await sleep(4000)
    await j.waitFor('window.appUI && window.appUI.$store && window.appUI.$store.state.todo')
    await sleep(1200)
    log.boot.localeAfterSeed = JSON.parse(await j.eval(`JSON.stringify({ ls: localStorage.getItem('appLocale'), i18n: window.appUI.$i18n.locale, htmlLang: document.documentElement.lang })`))
    step('locale-after-ls-seed (D2-HTMLLANG evidence: htmlLang)', log.boot.localeAfterSeed)
  })

  // Seed data through the REAL quick-add path (Enter keydown), capturing the toasts
  await safe('seed-1', async () => { log.boot.toastAdd1 = JSON.parse(await qaAdd(j, 'Buy milk tomorrow 9am #errands')); step('toast-1', log.boot.toastAdd1); await dumpInto(j, log, 'toast-add-1') })
  await safe('seed-2', async () => { log.boot.toastAdd2 = JSON.parse(await qaAdd(j, 'Write audit report')); step('toast-2', log.boot.toastAdd2) })
  await safe('seed-3', async () => { log.boot.toastAdd3 = JSON.parse(await qaAdd(j, 'Plan week review')); step('toast-3', log.boot.toastAdd3) })

  // Complete one row (done dot) + soft-delete another (recycle-bin data)
  await safe('seed-complete+delete', async () => {
    await j.click('.todo-item .td-check')
    await sleep(700)
    const rows = JSON.parse(await j.eval(`JSON.stringify((window.appUI.$store.state.todo.list || []).slice(0, 8).map(t => ({ id: t.taskId || t.id, c: t.taskContent, done: !!t.complete })))`))
    step('rows-after-complete', rows)
    log.boot.rows = rows
    const full = JSON.parse(await j.eval(`JSON.stringify((window.appUI.$store.state.todo.list || []).find(t => (t.taskContent || '').includes('Plan week review')))`))
    if (full) { await j.eval(`window.appUI.$store.dispatch('todo/deleteTodo', ${JSON.stringify(full)})`); await sleep(700); step('deleted-to-recycle', full.taskContent) }
  })

  // Walk every route
  await go(j, log, '#/todo-list/today', 'today')
  await go(j, log, '#/todo-list/today-x', 'today-x')
  await go(j, log, '#/todo-list/calendar', 'calendar')
  await go(j, log, '#/todo-list/todo-box', 'todo-box')
  await go(j, log, '#/todo-list/completed', 'completed')
  await go(j, log, '#/todo-list/statistics', 'statistics')
  await safe('stats-lastweek', async () => {
    await j.eval(`location.hash = '#/todo-list/statistics?period=lastWeek'; true`)
    await sleep(1000)
    await dumpInto(j, log, 'statistics-lastweek')
  })
  await go(j, log, '#/todo-list/habit', 'habit')
  await go(j, log, '#/todo-list/projects', 'projects')
  await go(j, log, '#/todo-list/all-tags', 'all-tags')
  await safe('tag-view', async () => {
    const probe = await j.eval(`JSON.stringify({ keys: Object.keys(window.appUI.$store.state.todo), tags: (window.appUI.$store.state.todo.tags || window.appUI.$store.state.todo.tagList || window.appUI.$store.state.todo.tagAll || []).slice(0, 3) })`)
    step('todo-state-probe', probe)
    const tags = JSON.parse(probe).tags || []
    const t0 = tags[0]
    const tagId = t0 && typeof t0 === 'object' ? (t0.name || t0.id || t0.tagId) : t0
    if (tagId) await go(j, log, '#/todo-list/tag/' + encodeURIComponent(tagId), 'tag-view')
    else step('tag-id-empty', tags)
  })
  await go(j, log, '#/todo-list/recycle-bin', 'recycle-bin')
  await go(j, log, '#/todo-list/search', 'search-empty')
  await safe('search-results', async () => {
    await j.fill('.search-input, input[type="text"], input[type="search"]', 'report')
    await sleep(900)
    await dumpInto(j, log, 'search-results')
  })
  await safe('category-view', async () => {
    const cats = JSON.parse(await j.eval(`JSON.stringify((window.appUI.$store.state.category.list || window.appUI.$store.state.category.categoryList || []).map(c => ({ id: c.categoryId || c.id, n: c.categoryName || c.name })))`))
    step('categories', cats)
    log.boot.categories = cats
    if (cats.length) await go(j, log, '#/todo-list/category/' + encodeURIComponent(cats[0].id), 'category-view')
  })

  // Settings modal — EVERY tab (dynamic el-tabs walk)
  await safe('settings-sweep', async () => {
    await j.eval(`window.appUI.$store.commit('ui/toggleSettings', true)`)
    await sleep(900)
    const nTabs = await j.eval(`document.querySelectorAll('.setting_tabs .el-tabs__item').length`)
    step('settings-tab-count', nTabs)
    await dumpInto(j, log, 'settings-tab0')
    for (let i = 1; i < nTabs; i++) {
      await j.eval(`(() => { const els = [...document.querySelectorAll('.setting_tabs .el-tabs__item')]; if (els[${i}]) { els[${i}].click(); return true } return false })()`)
      await sleep(800)
      await dumpInto(j, log, 'settings-tab' + i)
    }
    // Esc keyboard-close (focus inside the modal first — the @keydown.esc contract)
    await j.eval(`(() => { const els = [...document.querySelectorAll('.setting_tabs .el-tabs__item')]; if (els[0]) els[0].click(); const inp = document.querySelector('.settings-search__input'); if (inp) inp.focus(); return !!inp })()`)
    await sleep(500)
    await pressKey(mon, 'Escape', { vk: 27 })
    await sleep(600)
    log.keyboard.settingsEscFromSearch = await j.eval(`window.appUI.$store.state.ui.showSettingsModal`)
    step('settings-esc-from-search (false = closed)', log.keyboard.settingsEscFromSearch)
  })

  // Onboarding replay popovers
  await safe('onboarding-replay', async () => {
    await j.eval(`window.appUI.$store.commit('ui/toggleSettings', true)`)
    await sleep(800)
    const clicked = await j.eval(`(() => { const b = [...document.querySelectorAll('button')].find(x => /Replay/i.test(x.textContent)); if (b) { b.click(); return true } return false })()`)
    step('replay-clicked', clicked)
    await sleep(1200)
    await dumpInto(j, log, 'onboarding-replay')
    for (const n of ['onboarding-step2', 'onboarding-step3']) {
      const ok = await j.eval(`(() => { const b = [...document.querySelectorAll('button')].find(x => /Next|Got it|Start|Done|完成/i.test(x.textContent)); if (b && b.getClientRects().length) { b.click(); return true } return false })()`)
      await sleep(900)
      await dumpInto(j, log, n)
      if (!ok) break
    }
    await j.eval(`(() => { const b = [...document.querySelectorAll('button')].find(x => /Skip|Done|完成|跳过/i.test(x.textContent)); if (b && b.getClientRects().length) b.click(); return true })()`)
    await sleep(400)
    await j.eval(`window.appUI.$store.commit('ui/toggleSettings', false)`)
    await sleep(300)
  })

  // TomatoBar running state (free focus) — then give up
  await safe('tomato-bar', async () => {
    await j.eval(`window.appUI.$store.dispatch('tomato/startFocus')`)
    await sleep(1800)
    await dumpInto(j, log, 'tomato-running-bar')
    await j.eval(`window.appUI.$store.dispatch('tomato/giveUp', { record: true, reason: 'audit' })`)
    await sleep(800)
  })

  // Edit panel (double-click a row)
  await safe('edit-panel', async () => {
    const ok = await j.eval(`(() => { const t = [...document.querySelectorAll('.todo-item')].find(x => x.getClientRects().length); if (!t) return false; const c = t.querySelector('[class*=content], [class*=title]') || t; c.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true })()`)
    step('editpanel-dblclick', ok)
    await sleep(1000)
    await dumpInto(j, log, 'edit-panel')
  })

  // ================= KEYBOARD NAVIGATION =================
  await safe('kb-tab-order', async () => {
    await j.eval(`document.activeElement && document.activeElement.blur(); document.body.focus(); true`)
    const seq = []
    for (let i = 0; i < 10; i++) {
      await pressKey(mon, 'Tab', { vk: 9 })
      await sleep(180)
      seq.push(await j.eval(describeActive))
    }
    log.keyboard.tabOrderMainList = seq
    step('kb-tab-order', seq)
    await j.shot(join(SHOTS, 'd2-kb-tab-order.png')).catch(() => {})
  })
  await safe('kb-arrow-rows', async () => {
    await go(j, log, '#/todo-list/today', 'kb-nav-back-today', 800)
    const focused = await j.eval(`(() => { const r = [...document.querySelectorAll('.todo-item')].find(x => x.getClientRects().length); if (!r) return 'no-row'; const t = r.querySelector('[tabindex]') || r; t.focus(); return document.activeElement.className.slice(0, 40) })()`)
    await pressKey(mon, 'ArrowDown', { vk: 40 })
    await sleep(300)
    const after = await j.eval(describeActive)
    log.keyboard.arrowDownFromRow = { focused, after }
    step('kb-arrow-down', log.keyboard.arrowDownFromRow)
  })
  await safe('kb-quickadd-enter', async () => {
    const before = await j.eval(`(window.appUI.$store.state.todo.list || []).length`)
    await j.eval(`(() => { const el = document.querySelector('.qa-input'); if (!el) throw new Error('no .qa-input'); el.focus() })()`)
    await j.fill('.qa-input', 'Keyboard enter task')
    await pressKey(mon, 'Enter', { vk: 13 })
    await sleep(900)
    const after = await j.eval(`(window.appUI.$store.state.todo.list || []).length`)
    log.keyboard.quickAddRealEnter = { before, after, created: after > before }
    step('kb-quickadd-enter', log.keyboard.quickAddRealEnter)
  })
} catch (e) {
  step('PHASE1-FATAL', String(e && e.stack || e).slice(0, 600))
} finally {
  if (j) await j.end().catch(() => {})
  if (mon) { try { mon.close() } catch { /* gone */ } }
}

/* ================= PHASE 2: float window (focus allowed) + zh flip-back ================= */
let f = null
for (let attempt = 1; attempt <= 2 && !f; attempt++) {
  try { f = await bootFocus({ cdpPort: 9384, seedConfig: { appLocale: 'en-US' } }) }
  catch (e) { step('bootFocus-attempt' + attempt + '-failed', String(e).slice(0, 160)); await sleep(3000) }
}
try {
  if (f) {
    const fmon = await attachMonitor(f, log)
    await sleep(2000)
    await safe('float-ls-seed', async () => {
      await f.eval(`localStorage.setItem('appLocale', 'en-US'); location.reload(); true`)
      await sleep(4000)
      await f.eval(`window.appUI && window.appUI.$store && window.appUI.$store.state.todo`)
      await sleep(800)
    })
    await safe('float-open', async () => {
      await f.eval(`window.appUI.$store.dispatch('tomato/startFocus')`)
      await sleep(1200)
      const opened = await f.eval(`(() => { const b = document.querySelector('.tb-float-toggle'); if (b) { b.click(); return 'bar-btn' } return 'no-btn' })()`)
      step('float-open-attempt', opened)
      await sleep(1500)
      const targets = await f.targets()
      step('targets-after-float', targets.map(t => t.url.split('/').pop()))
      if (targets.some(t => t.url.includes('__tomato-float'))) {
        const fc = await f.connectPage('__tomato-float')
        await sleep(1200)
        const parsed = JSON.parse(await fc.eval(DUMP_EXPR))
        parsed.cjk = [...new Set([...parsed.texts, ...parsed.attrs].filter(s => CJK.test(s)))]
        log.surfaces['float-window'] = parsed
        await fc.shot(join(SHOTS, 'd2-float-window.png')).catch(() => {})
        step('surface', { name: 'float-window', cjk: parsed.cjk.length })
        fc.close()
      } else {
        step('float-window-missing', 'no __tomato-float target — check toggle path')
      }
    })
    await safe('float-giveup', async () => {
      await f.eval(`window.appUI.$store.dispatch('tomato/giveUp', { record: true, reason: 'audit' })`)
      await sleep(600)
    })
    try { fmon.close() } catch { /* gone */ }

    // zh flip-back spot-check on this same instance (today + settings general)
    await safe('zh-flipback', async () => {
      await f.eval(`localStorage.setItem('appLocale', 'zh-CN'); location.reload(); true`)
      await sleep(4000)
      await f.eval(`window.appUI && window.appUI.$store && window.appUI.$store.state.todo`)
      await sleep(1000)
      await dumpInto(f, log, 'zh-back-today')
      await f.eval(`window.appUI.$store.commit('ui/toggleSettings', true)`)
      await sleep(900)
      await dumpInto(f, log, 'zh-back-settings')
      await f.eval(`window.appUI.$store.commit('ui/toggleSettings', false)`)
    })
  }
} catch (e) {
  step('PHASE2-FATAL', String(e && e.stack || e).slice(0, 600))
} finally {
  if (f) await f.end().catch(() => {})
}

await writeFile(join(HERE, 'd2-i18n-log.json'), JSON.stringify(log, null, 1), 'utf8')
console.log('=== CJK LEAKS PER SURFACE (en-US mode) ===')
for (const [k, v] of Object.entries(log.surfaces)) {
  if (!/^zh-back/.test(k)) console.log(k + ': ' + JSON.stringify(v.cjk).slice(0, 700))
}
console.log('=== KEYBOARD ===')
console.log(JSON.stringify(log.keyboard, null, 1).slice(0, 1600))
console.log('=== CONSOLE ISSUES: ' + log.console.length + ' | NET>=400: ' + log.net404.length + ' ===')
for (const c of log.console.slice(0, 30)) console.log('  [' + c.kind + '] ' + c.text.slice(0, 160))
for (const n of log.net404.slice(0, 20)) console.log('  [' + n.status + '] ' + n.url)
