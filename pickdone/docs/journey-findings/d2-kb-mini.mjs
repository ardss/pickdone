/**
 * d2-crosscutting-auditor — keyboard-nav mini-journey (v4 follow-up).
 * v4's keyboard section read `state.todo.list` (wrong key — it's `todoList`) and clicked
 * `.todo-item` (wrong class — the row root is `.td-item`, TodoItem.vue:5). This run closes the
 * gaps with correct handles: store seeding, completion via updateTodoFields, ArrowDown roving
 * focus on .td-item, REAL CDP Enter in quick-add measured against todoList, edit-panel dblclick,
 * and the tag route on a real tag.
 */
import { bootJourney } from '../../scripts/journey-driver.mjs'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const log = {}
const step = (n, d) => { log[n] = d; console.log('[d2-kb]', n, JSON.stringify(d).slice(0, 300)) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

const j = await bootJourney({ cdpPort: 9384, seedConfig: { appLocale: 'en-US' } })
const mon = await j.connectPage('index.html')
const orig = mon.ws.onmessage
mon.ws.onmessage = e => { try { const m = JSON.parse(e.data); if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') console.log('[console.error]', (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 200)) } catch {} ; orig(e) }
await mon.send('Runtime.enable')
const pressKey = (key, vk) => mon.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: vk })
  .then(() => mon.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: vk }))

try {
  // Seed the LS boot cache (en UI) — the D2-LOC fix is not in the pre-built dist yet
  await j.waitFor('window.appUI && window.appUI.$store && window.appUI.$store.state.todo')
  await j.eval(`localStorage.setItem('appLocale', 'en-US'); location.reload(); true`)
  await sleep(4000)
  await j.waitFor('window.appUI && window.appUI.$store && window.appUI.$store.state.todo')

  // Store seeding (the action QuickAdd itself dispatches, minus NL parsing)
  // NOTE: the driver's eval unwraps returnByValue — the awaited promise resolves to the ARRAY itself.
  // todoDate=today-midnight so rows land on the TODAY view (undated store-adds go to the box).
  const rows = await j.eval(`(async () => {
    const s = window.appUI.$store
    const today = new Date().setHours(0, 0, 0, 0)
    await s.dispatch('todo/addTodo', { todoContent: 'Buy milk 9am #errands', todoDate: today })
    await s.dispatch('todo/addTodo', { todoContent: 'Write audit report', todoDate: today })
    await s.dispatch('todo/addTodo', { todoContent: 'Plan week review', todoDate: today })
    return (s.state.todo.todoList || []).map(t => ({ id: t.taskId, c: t.taskContent, d: t.dayStart }))
  })()`)
  step('seeded', rows)

  // Complete the first row via the canonical field-update action
  await j.eval(`window.appUI.$store.dispatch('todo/updateTodoFields', { taskId: ${JSON.stringify(rows[0].id)}, patch: { complete: true } })`)
  await sleep(900)
  step('completed-row', await j.eval(`JSON.stringify((window.appUI.$store.state.todo.todoList || []).map(t => ({ c: t.taskContent.slice(0, 12), done: !!t.complete })))`))
  // ArrowDown roving focus on the REAL row class
  const focusRes = await j.eval(`(() => { const r = [...document.querySelectorAll('.td-item')].find(x => x.getClientRects().length && !x.classList.contains('is-complete')); if (!r) return 'no-row'; r.focus(); return document.activeElement.className.split(' ')[0] })()`)
  await pressKey('ArrowDown', 40)
  await sleep(350)
  const after = await j.eval(`(() => { const a = document.activeElement; return a ? a.tagName + '.' + String(a.className).split(' ')[0] + '|' + (a.textContent || '').trim().slice(0, 24) : 'none' })()`)
  log.arrowRoving = { focusedFirstRow: focusRes, afterArrowDown: after }
  step('arrow-roving', log.arrowRoving)

  // REAL CDP Enter in quick-add, measured against todoList
  const before = await j.eval(`(window.appUI.$store.state.todo.todoList || []).length`)
  await j.eval(`(() => { const el = document.querySelector('.qa-input'); if (!el) throw new Error('no .qa-input'); el.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, 'Real enter task'); el.dispatchEvent(new Event('input', { bubbles: true })); return document.activeElement.className })()`)
  await pressKey('Enter', 13)
  await sleep(1000)
  const afterEnter = await j.eval(`(window.appUI.$store.state.todo.todoList || []).length`)
  log.realEnterCreates = { before, after: afterEnter, created: afterEnter > before }
  step('real-cdp-enter', log.realEnterCreates)

  // Edit panel via row double-click
  const dbl = await j.eval(`(() => { const t = [...document.querySelectorAll('.td-item')].find(x => x.getClientRects().length); if (!t) return false; const c = t.querySelector('[class*=content], [class*=title]') || t; c.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true })()`)
  await sleep(1100)
  const ep = JSON.parse(await j.eval(`(() => { const p = [...document.querySelectorAll('[class*=edit-panel],[class*=ep-panel],[class*=panel]')].filter(x => x.getClientRects().length); return JSON.stringify({ panelNodes: p.length, hash: location.hash, texts: document.body.innerText.slice(0, 80) }) })()`))
  step('edit-panel', { dblclick: dbl, ...ep })
  await j.eval(`(() => { const b = [...document.querySelectorAll('button, [class*=close]')].find(x => /close/i.test(x.className + ' ' + (x.title || '')) && x.getClientRects().length); if (b) b.click(); return true })()`)
  await sleep(400)

  // Tag route on the real tag from the seeded content
  await j.eval(`location.hash = '#/todo-list/tag/' + encodeURIComponent('errands'); true`)
  await sleep(1200)
  log.tagView = await j.eval(`JSON.stringify({ hash: location.hash, rows: [...document.querySelectorAll('.td-item')].filter(x => x.getClientRects().length).length, title: document.title })`)
  step('tag-view', log.tagView)
} finally {
  await j.end().catch(() => {})
  try { mon.close() } catch { /* gone */ }
}
await writeFile(join(HERE, 'd2-kb-mini-log.json'), JSON.stringify(log, null, 1), 'utf8')
console.log('KB-MINI RESULT:', JSON.stringify({ arrowRoving: log.arrowRoving, realEnterCreates: log.realEnterCreates, tagView: log.tagView }))
