/**
 * Core user-journey E2E regression — Habit lifecycle + moment (countdown) + multi-day state.
 * Value proposition: assert USER-VISIBLE outcomes (DOM text + DB meta rows), never code-internal
 * assumptions. Pins the 2026-10-26 W10 P1 fix: habit/moment delete + Undo used to be a SILENT
 * no-op (replaceAll's savedAt LWW guard rejected the pre-delete snapshot), losing the habit
 * together with its check-in history.
 *
 * Journeys:
 *   J5  habit full lifecycle: create -> check in today -> record visible -> delete -> undo toast
 *       appears -> click Undo -> habit back in list WITH its check-in record.
 *   J6  moment (countdown) create with a future date -> card visible with the correct remaining
 *       days -> delete -> Undo -> card restored.
 *   J7  habit with a check-in seeded for YESTERDAY only: the habit page must show "yesterday
 *       done, today not yet done" correctly (check circle unchecked, streak survives at 1 day,
 *       30-day grid yesterday-on/today-off, month calendar yesterday dot).
 *
 * Structure copied from tests/e2e.test.mjs (attach / isolation gate / fail-loud / watchdog /
 * exit cleanup). Run inside the shared pool:
 *   node tests/run-interactions-shared.mjs tests/e2e-journeys/j-habit-moment.test.mjs
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const CDP = process.env.TODO_CDP || 'http://127.0.0.1:9333'

// Isolation gate: the attached instance must use an isolated data dir (TODO_USER_DATA_DIR injected
// at boot, preload exposes isDataIsolated) — otherwise these journeys' writes land on a real user DB.
let available = false
let isolated = false
try {
  const list = await (await fetch(CDP + '/json', { signal: AbortSignal.timeout(1500) })).json()
  const page = list.find(t => t.type === 'page' && !t.url.includes('__tomato-float'))
  available = !!page
  if (page) {
    const ws2 = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws2.onopen = res; ws2.onerror = rej })
    const env = await new Promise(res => {
      ws2.onmessage = e => { const m = JSON.parse(e.data); if (m.id === 1) res(m.result?.result?.value) }
      ws2.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'JSON.stringify({iso: !!(window.todoAPI && window.todoAPI.isDataIsolated)})', returnByValue: true } }))
      setTimeout(() => res(null), 3000)
    })
    try { ws2.close() } catch {}
    try { isolated = JSON.parse(env).iso === true } catch { isolated = false }
  }
} catch { /* no debug port */ }

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Fail-loud inside the shared pool (skip=green is NOT acceptable evidence there)
{
  const inPool = process.env.TODO_SHARED_CDP || process.env.TODO_CDP
  if (inPool && (!available || !isolated)) {
    console.error(`[j-habit-moment] ran inside the shared pool but the precondition failed (available=${available}, isolated=${isolated}) — failing loud`)
    process.exitCode = 1
  }
}

// Watchdog: WS handles keep the event loop alive; force-exit after 120s no matter what
const watchdog = setTimeout(() => { console.error('E2E watchdog forced exit (counted as failure)'); try { ws?.close() } catch {} process.exit(1) }, 120000)
watchdog.unref?.()
process.on('exit', () => { try { ws?.close() } catch {} })

let ws = null
let id = 0
const pending = new Map()
const send = (method, params = {}) => new Promise(res => {
  const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }))
})
const evalJson = async expression => {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: `(async () => JSON.stringify(await (${expression})))()`, returnByValue: true, awaitPromise: true }),
    sleep(10000).then(() => null)
  ])
  return r ? JSON.parse(r.result?.result?.value ?? 'null') : null
}
// Await-style eval that SURFACES page exceptions (evalJson returns null on timeout and silently
// ignores exceptionDetails — exactly how a failed cleanup used to pass unnoticed).
const evalAwait = async expression => {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: `(${expression})`, returnByValue: true, awaitPromise: true }),
    sleep(10000).then(() => null)
  ])
  if (!r) return null
  if (r.exceptionDetails) throw new Error('page eval failed: ' + ((r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '').slice(0, 300))
  return r.result?.result?.value ?? null
}

// Vue store handle (Vue 3: window.appUI.$store is the official main.js seam; DOM fallbacks kept from ui-smoke)
const STORE_Q = `(()=>{if(window.appUI&&window.appUI.$store)return window.appUI.$store;const a=document.getElementById('app')&&document.getElementById('app').__vue_app__;const p=a&&a._instance&&a._instance.proxy;if(p&&p.$store)return p.$store;return null})()`

// Poll an expression until truthy (toast latency / async persist under pool load)
const pollFor = async (expression, tries = 15, gap = 400) => {
  for (let i = 0; i < tries; i++) {
    const v = await evalJson(expression)
    if (v) return v
    await sleep(gap)
  }
  return null
}

// Set an input's value through the native setter + input event (Vue v-model picks it up)
const SET_VAL = `(el, v) => { const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }`

// Local YYYY-MM-DD day key derived from a timestamp (same shape as shared/date-key.mjs localDayKey)
const PAGE_DAYKEY = `(ts) => { const d = new Date(ts); const p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) }`

// W11 2026-10-26: verified cleanup. The journeys' finally blocks used to fire store-level
// delHabit/delMoment commits with NO verification — if the store handle is gone after a
// mid-test reload (evalJson's silent null) the habit/moment persists in db.habitsState for
// every later pool target. After each cleanup we poll the DURABLE blob (dbCall getMeta), and
// when the store path failed we fall back to a direct blob rewrite via the whitelisted
// setMeta op (src/main/handlers/todo.js: 'setMeta' — main-window-only, args [key, value]).
const blobArtifact = (blob, kind, name) =>
  kind === 'habit'
    ? !!(blob && (blob.habits || []).some(x => x.name === name))
    : !!(blob && (blob.moments || []).some(x => x.name === name))
const verifyBlobCleanup = async (kind, name) => {
  const readBlob = () => evalAwait(`window.todoAPI.dbCall('getMeta','db.habitsState').then(v => v ? JSON.parse(v) : null)`)
  let blob = null
  for (let i = 0; i < 10; i++) {
    blob = await readBlob().catch(() => null)
    if (blob && !blobArtifact(blob, kind, name)) return 'clean'
    await sleep(400)
  }
  if (!blob) console.error(`[j-habit-moment] cleanup verification could not read db.habitsState for "${name}" (blob unreadable) — attempting the direct setMeta fallback anyway`)
  // Fallback: rewrite the blob without the artifact (store handle may be gone after a reload)
  const stripped = blob ? { ...blob, [kind === 'habit' ? 'habits' : 'moments']: (blob[kind === 'habit' ? 'habits' : 'moments'] || []).filter(x => x.name !== name) } : null
  if (stripped) {
    const wrote = await evalAwait(`window.todoAPI.dbCall('setMeta',['db.habitsState', ${JSON.stringify(JSON.stringify(stripped))}]).then(() => 'ok')`).catch(() => null)
    if (wrote === 'ok') {
      const re = await readBlob().catch(() => null)
      if (re && !blobArtifact(re, kind, name)) return 'clean-via-setmeta-fallback'
    }
  }
  console.error(`[j-habit-moment] LEAKED ARTIFACT: habit/moment "${name}" (${kind}) is still present in db.habitsState after cleanup AND the setMeta blob-rewrite fallback — it will pollute every later pool target`)
  assert.fail(`cleanup failed: the created ${kind} "${name}" is still in db.habitsState after both the store-level delete and the direct setMeta fallback`)
}

test('Precondition: connect CDP, pin locale, wait for the app to boot', { skip: !available ? 'no debug port on ' + CDP : (!isolated ? 'attached instance is NOT data-isolated; refusing writes on real user data' : false) }, async () => {
  const targets = await (await fetch(CDP + '/json')).json()
  const page = targets.find(t => t.type === 'page' && !t.url.includes('__tomato-float') && /#\/todo-list/.test(t.url)) ||
    targets.find(t => t.type === 'page' && t.url.includes('index.html') && !t.url.includes('__tomato-float'))
  assert.ok(page, 'no page target')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
  await send('Runtime.enable'); await send('Page.enable')
  // Locale pin: assertions target the en-US surface ('Undo', 'days left', '1-day streak')
  await send('Runtime.evaluate', { expression: "try{localStorage.setItem('appLocale','en-US');localStorage.setItem('onboardingToursSeen', JSON.stringify({today:1,editpanel:1}))}catch(e){}" })
  await send('Page.reload')
  let booted = false
  for (let i = 0; i < 30 && !booted; i++) {
    booted = (await evalJson('document.querySelectorAll(".sn-nav-item").length')) > 0 && !!(await evalJson(STORE_Q))
    if (!booted) await sleep(1000)
  }
  assert.ok(booted, 'the app did not finish booting within 30s')
  // error collectors: journey failures must carry the page-side exception, not just the DOM diff
  await evalJson(`(() => { window.__errs = []; window.addEventListener('error', e => window.__errs.push(String(e.message).slice(0, 200))); window.addEventListener('unhandledrejection', e => window.__errs.push('rej:' + String(e.reason && e.reason.message || e.reason).slice(0, 200))); return 'ok' })()`)
})

test('J5 habit lifecycle: create -> check in -> record visible -> delete -> Undo restores habit AND its record (W10 P1 pin)', { skip: !available || !isolated }, async () => {
  const name = 'E2E_J5_' + Math.random().toString(36).slice(2, 8)
  try {
    await evalJson(`location.hash='#/todo-list/habit'`)
    assert.ok(await pollFor(`!!document.querySelector('.habit-add-input:not(.habit-freq-select)')`, 15, 500), 'habit page did not mount')

    // --- create through the real form (input + New button click) ---
    await evalJson(`(() => { const el = document.querySelector('.habit-add:not(.moment-add) .habit-add-input'); (${SET_VAL})(el, ${JSON.stringify(name)}); return 'ok' })()`)
    await evalJson(`(() => { const b = document.querySelector('.habit-add:not(.moment-add) button.mini.primary'); if (!b) return 'no-btn'; b.click(); return 'ok' })()`)
    const created = await pollFor(`(() => {
      const card = [...document.querySelectorAll('.habit-card')].find(c => (c.querySelector('.habit-name')||{}).textContent === ${JSON.stringify(name)});
      if (!card) return null;
      const st = (${STORE_Q});
      const h = st && st.state.habits.habits.find(x => x.name === ${JSON.stringify(name)});
      return { dom: true, storeId: h ? h.id : null, checkCircle: !!card.querySelector('.habit-check') }
    })()`, 15, 400)
    assert.ok(created && created.dom, 'habit card did not appear in the list after create')
    assert.ok(created.storeId, 'habit not found in the store after create')
    assert.ok(created.checkCircle, 'daily habit card does not offer a today check circle')

    // --- check in today (real click on the circle) ---
    const todayKey = await evalJson(`(() => { const st = (${STORE_Q}); return (${PAGE_DAYKEY})(st.state.todo.todayTimestamp) })()`)
    await evalJson(`(() => { const card = [...document.querySelectorAll('.habit-card')].find(c => (c.querySelector('.habit-name')||{}).textContent === ${JSON.stringify(name)}); const c = card && card.querySelector('.habit-check'); if (!c) return 'no-circle'; c.click(); return 'ok' })()`)
    const checked = await pollFor(`(() => {
      const card = [...document.querySelectorAll('.habit-card')].find(c => (c.querySelector('.habit-name')||{}).textContent === ${JSON.stringify(name)});
      if (!card) return null;
      const circle = card.querySelector('.habit-check');
      const cells = card.querySelectorAll('.habit-grid__cell');
      const st = (${STORE_Q});
      const h = st && st.state.habits.habits.find(x => x.name === ${JSON.stringify(name)});
      return {
        circleOn: !!(circle && circle.classList.contains('on')),
        ariaChecked: circle && circle.getAttribute('aria-checked'),
        gridOnCells: card.querySelectorAll('.habit-grid__cell.on').length,
        lastCellOn: !!(cells[29] && cells[29].classList.contains('on')),
        storeRecord: !!(h && h.records && h.records[${JSON.stringify('TK')}])
      }
    })()`.replaceAll('"TK"', JSON.stringify(todayKey)), 15, 400)
    // user-visible check-in record: circle lit + 30-day grid last (today) cell lit + streak bumped
    assert.ok(checked && checked.circleOn && checked.ariaChecked === 'true', 'check circle did not turn on after the check-in click')
    assert.ok(checked.gridOnCells >= 1, 'no lit cell in the 30-day habit grid after check-in')
    assert.ok(checked.lastCellOn, 'the 30-day grid TODAY cell is not lit after check-in')
    const streak1 = await evalJson(`(() => { const card = [...document.querySelectorAll('.habit-card')].find(c => (c.querySelector('.habit-name')||{}).textContent === ${JSON.stringify(name)}); return ((card.querySelector('.habit-streak')||{}).textContent||'').trim() })()`)
    assert.ok(streak1.includes('1-day streak'), 'streak after first check-in should read 1-day streak, got: ' + streak1)
    // monthly calendar dot for today
    const calDot = await evalJson(`(() => { const t = document.querySelector('.habit-cal-day.today'); return !!t && (!t.classList.contains('checked') ? { dot: !!t.querySelector('.habit-cal-dot'), checked: false } : { dot: !!t.querySelector('.habit-cal-dot'), checked: true }) })()`)
    assert.ok(calDot && calDot.checked && calDot.dot, 'monthly calendar does not mark today as checked after check-in')
    // DB row (durable source of truth)
    const blob1 = await pollFor(`window.todoAPI.dbCall('getMeta', 'db.habitsState').then(v => { const b = v ? JSON.parse(v) : null; const h = b && (b.habits||[]).find(x => x.name === ${JSON.stringify(name)}); return h && h.records && h.records[${JSON.stringify('@T@')}] === true ? 'db-ok' : null })`.replace('@T@', todayKey), 15, 400)
    assert.equal(blob1, 'db-ok', 'check-in record not found in the durable DB meta row after check-in')

    // close the check-in toast so its own Undo link cannot be clicked by mistake later
    await evalJson(`(() => { document.querySelectorAll('.el-message__closeBtn').forEach(b => b.click()); return 'ok' })()`)
    await sleep(400)

    // --- delete through the real flow (Delete button -> confirm dialog) ---
    await evalJson(`(() => { const card = [...document.querySelectorAll('.habit-card')].find(c => (c.querySelector('.habit-name')||{}).textContent === ${JSON.stringify(name)}); const b = card && card.querySelector('.habit-del'); if (!b) return 'no-del'; b.click(); return 'ok' })()`)
    const confirmBox = await pollFor(`!!document.querySelector('.el-message-box')`, 10, 300)
    assert.ok(confirmBox, 'delete confirm dialog did not appear')
    const confirmText = await evalJson(`((document.querySelector('.el-message-box__message')||{}).textContent||'')`)
    assert.ok(confirmText.includes(name), 'confirm dialog does not name the habit being deleted: ' + confirmText)
    await evalJson(`(() => { const b = document.querySelector('.el-message-box__btns .el-button--primary'); if (!b) return 'no-btn'; b.click(); return 'ok' })()`)
    // habit gone from DOM + store
    const gone = await pollFor(`(() => {
      const domGone = ![...document.querySelectorAll('.habit-card')].some(c => (c.querySelector('.habit-name')||{}).textContent === ${JSON.stringify(name)});
      const st = (${STORE_Q});
      const storeGone = st && !st.state.habits.habits.some(x => x.name === ${JSON.stringify(name)});
      return domGone && storeGone ? 'gone' : null
    })()`, 15, 300)
    assert.equal(gone, 'gone', 'habit did not disappear from list/store after delete+confirm')
    const blobGone = await pollFor(`window.todoAPI.dbCall('getMeta', 'db.habitsState').then(v => { const b = v ? JSON.parse(v) : null; return b && !(b.habits||[]).some(x => x.name === ${JSON.stringify(name)}) ? 'db-gone' : null })`, 15, 300)
    assert.equal(blobGone, 'db-gone', 'deleted habit still present in the durable DB meta row')

    // --- undo toast must appear and carry a working Undo link (the W10 P1 pin) ---
    // find + click in ONE polled evaluation: the toast auto-dismisses after 5s, so a separate
    // assert-then-click round-trip can race the dismissal under pool load
    const undoClicked = await pollFor(`(() => {
      const toast = [...document.querySelectorAll('.el-message')].find(m => m.textContent.includes('deleted') && m.textContent.includes(${JSON.stringify(name)}));
      if (!toast) return null;
      const a = [...toast.querySelectorAll('a')].find(x => x.textContent.trim() === 'Undo');
      if (!a) return { noLink: true, toastText: toast.textContent.slice(0, 80) };
      a.click(); return 'clicked'
    })()`, 20, 450)
    assert.equal(undoClicked, 'clicked', 'undo toast with a clickable Undo link did not appear after habit delete: ' + JSON.stringify(undoClicked))
    // Mechanism probe for the pinned bug: delHabit (store/habits.js delHabit) records a STICKY
    // deletion tombstone, and replaceAll — even with the W10 force:true snapshot (HabitView.vue) —
    // re-filters the restored array through applyHabitTombstones(s.deleted, ...) (store/habits.js
    // replaceAll), so the habit the snapshot carries is dropped again. Verified at authoring time
    // (2026-10-27) with a direct store-level probe: commit('habits/replaceAll', {snap, force:true})
    // DOES apply (persist re-stamps savedAt) yet the tombstone filter removes the habit — the undo
    // can never restore, no matter whether the toast click fires. savedAt before/after + the store
    // snapshot below ride along in the failure message as the bug's evidence.
    const savedAtBeforeUndo = await evalJson(`(${STORE_Q}).state.habits.savedAt`)
    // habit back in the list, WITH its check-in record (this is exactly what the pre-fix silent
    // no-op destroyed: the habit came back or stayed gone, and records were lost)
    const restored = await pollFor(`(() => {
      const card = [...document.querySelectorAll('.habit-card')].find(c => (c.querySelector('.habit-name')||{}).textContent === ${JSON.stringify(name)});
      if (!card) return null;
      const circle = card.querySelector('.habit-check');
      const st = (${STORE_Q});
      const h = st && st.state.habits.habits.find(x => x.name === ${JSON.stringify(name)});
      return {
        circleOn: !!(circle && circle.classList.contains('on')),
        streak: ((card.querySelector('.habit-streak')||{}).textContent||'').trim(),
        storeRecord: !!(h && h.records && h.records[${JSON.stringify('@TODAY2@')}])
      }
    })()`.replace('@TODAY2@', todayKey), 15, 400)
    const undoDiag = await evalJson(`(() => { const st = (${STORE_Q}); return { savedAt: st.state.habits.savedAt, habits: st.state.habits.habits.map(h => h.name), tombstones: st.state.habits.deleted } })()`)
    assert.ok(restored, `habit did not come back after clicking Undo [bug probe: savedAt before=${savedAtBeforeUndo} after=${undoDiag && undoDiag.savedAt} (2026-10-27 live probe: the Undo click DOES reach commit('habits/replaceAll') and replaceAll's force path re-stamps savedAt via persist — after>before is normal; the failure signal is habits=[] while the restore snapshot carried the habit ⇒ the sticky tombstone merge (store/habits.js replaceAll: s.deleted=mergeHabitTombstones(...) then applyHabitTombstones(blob.habits, s.deleted)) re-filters the just-restored habit out), store habits=${JSON.stringify(undoDiag && undoDiag.habits)}, tombstones=${JSON.stringify(undoDiag && undoDiag.tombstones)}]`)
    assert.ok(restored.circleOn, 'undo restored the habit but the today check circle is no longer lit')
    assert.ok(restored.storeRecord, 'undo restored the habit but the check-in record was lost from the store')
    assert.ok(restored.streak.includes('1-day streak'), 'undo restored the habit but the streak record was lost, got: ' + restored.streak)
    const blobRestored = await pollFor(`window.todoAPI.dbCall('getMeta', 'db.habitsState').then(v => { const b = v ? JSON.parse(v) : null; const h = b && (b.habits||[]).find(x => x.name === ${JSON.stringify(name)}); return h && h.records && h.records[${JSON.stringify('@T2@')}] === true ? 'db-ok' : null })`.replace('@T2@', todayKey), 15, 400)
    assert.equal(blobRestored, 'db-ok', 'undo restored the habit but the check-in record was lost from the durable DB meta row')
  } finally {
    // self-cleanup: hard-remove the journey habit from store + DB, never pollute later targets
    await evalJson(`(() => { const st = (${STORE_Q}); if (!st) return 'no-store'; st.state.habits.habits.filter(x => x.name === ${JSON.stringify(name)}).forEach(x => st.commit('habits/delHabit', x.id)); return 'ok' })()`)
    await sleep(300)
    // W11: verify the DURABLE blob, not just the store commit (silent no-op = leak into later targets)
    await verifyBlobCleanup('habit', name).catch(e => { console.error('[j-habit-moment] J5 cleanup verification failed: ' + e.message); assert.fail(e.message) })
  }
})

test('J6 moment (countdown): create with a future date -> correct days-left -> delete -> Undo restores the card', { skip: !available || !isolated }, async () => {
  const name = 'E2E_J6_' + Math.random().toString(36).slice(2, 8)
  // target date = today + 10 calendar days, computed from the store's reactive today (same source the view uses)
  const info = await evalJson(`(() => { const st = (${STORE_Q}); const ts = st.state.todo.todayTimestamp; const d = new Date(ts); d.setDate(d.getDate() + 10); const p = n => String(n).padStart(2, '0'); return { key: d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()), diff: 10 } })()`)
  assert.ok(info && info.key, 'could not compute the future date key')
  const expectedDaysText = info.diff + ' days left' // en-US statsB.HabitView.countdownLeft for a countdown
  try {
    await evalJson(`location.hash='#/todo-list/habit'`)
    assert.ok(await pollFor(`!!document.querySelector('.moment-add')`, 15, 500), 'moment section did not mount')

    // --- create through the real form ---
    await evalJson(`(() => { const sec = document.querySelector('.moment-add'); const nameIn = sec.querySelector('input.habit-add-input:not([type=date])'); const dateIn = sec.querySelector('input[type=date]'); if (!nameIn || !dateIn) return 'no-inputs'; (${SET_VAL})(nameIn, ${JSON.stringify(name)}); (${SET_VAL})(dateIn, ${JSON.stringify(info.key)}); return 'ok' })()`)
    await evalJson(`(() => { const b = document.querySelector('.moment-add button.mini.primary'); if (!b) return 'no-btn'; b.click(); return 'ok' })()`)
    const card = await pollFor(`(() => {
      const item = [...document.querySelectorAll('.moment-item')].find(m => (m.querySelector('.moment-name')||{}).textContent === ${JSON.stringify(name)});
      if (!item) return null;
      const st = (${STORE_Q});
      const m = st && st.state.habits.moments.find(x => x.name === ${JSON.stringify(name)});
      return {
        date: ((item.querySelector('.moment-date')||{}).textContent||'').trim(),
        days: ((item.querySelector('.moment-days')||{}).textContent||'').trim(),
        storeDate: m ? m.date : null,
        storeKind: m ? m.kind : null
      }
    })()`, 15, 400)
    assert.ok(card, 'moment card did not appear after create')
    assert.equal(card.date, info.key, 'moment card does not show the chosen date, got: ' + card.date)
    assert.equal(card.days, expectedDaysText, 'moment card remaining-days text is wrong, got: ' + card.days + ' expected: ' + expectedDaysText)
    assert.equal(card.storeDate, info.key, 'moment not in the store with the chosen date')
    assert.equal(card.storeKind, 'countdown', 'moment kind is not countdown')
    const blobHas = await pollFor(`window.todoAPI.dbCall('getMeta', 'db.habitsState').then(v => { const b = v ? JSON.parse(v) : null; const m = b && (b.moments||[]).find(x => x.name === ${JSON.stringify(name)}); return m && m.date === ${JSON.stringify(info.key)} ? 'db-ok' : null })`, 15, 400)
    assert.equal(blobHas, 'db-ok', 'moment not found in the durable DB meta row after create')

    // --- delete through the real flow ---
    await evalJson(`(() => { const item = [...document.querySelectorAll('.moment-item')].find(m => (m.querySelector('.moment-name')||{}).textContent === ${JSON.stringify(name)}); const b = item && item.querySelector('button.mini.danger'); if (!b) return 'no-del'; b.click(); return 'ok' })()`)
    assert.ok(await pollFor(`!!document.querySelector('.el-message-box')`, 10, 300), 'moment delete confirm dialog did not appear')
    await evalJson(`(() => { const b = document.querySelector('.el-message-box__btns .el-button--primary'); if (!b) return 'no-btn'; b.click(); return 'ok' })()`)
    const gone = await pollFor(`(() => {
      const domGone = ![...document.querySelectorAll('.moment-item')].some(m => (m.querySelector('.moment-name')||{}).textContent === ${JSON.stringify(name)});
      const st = (${STORE_Q});
      const storeGone = st && !st.state.habits.moments.some(x => x.name === ${JSON.stringify(name)});
      return domGone && storeGone ? 'gone' : null
    })()`, 15, 300)
    assert.equal(gone, 'gone', 'moment did not disappear after delete+confirm')

    // --- undo toast appears; clicking Undo must restore the card (W10 P1 pin) ---
    // find + click in ONE polled evaluation (5s toast life vs poll round-trips under pool load)
    const undoClicked = await pollFor(`(() => {
      const toast = [...document.querySelectorAll('.el-message')].find(m => m.textContent.includes('Moment') && m.textContent.includes(${JSON.stringify(name)}) && m.textContent.includes('deleted'));
      if (!toast) return null;
      const a = [...toast.querySelectorAll('a')].find(x => x.textContent.trim() === 'Undo');
      if (!a) return { noLink: true, toastText: toast.textContent.slice(0, 80) };
      a.click(); return 'clicked'
    })()`, 20, 450)
    assert.equal(undoClicked, 'clicked', 'undo toast with a clickable Undo link did not appear after moment delete: ' + JSON.stringify(undoClicked))
    // same mechanism probe as J5 (delMoment's sticky deletedMoments tombstone vs the force restore)
    const savedAtBeforeUndo = await evalJson(`(${STORE_Q}).state.habits.savedAt`)
    const restored = await pollFor(`(() => {
      const item = [...document.querySelectorAll('.moment-item')].find(m => (m.querySelector('.moment-name')||{}).textContent === ${JSON.stringify(name)});
      if (!item) return null;
      return { days: ((item.querySelector('.moment-days')||{}).textContent||'').trim() }
    })()`, 15, 400)
    const undoDiag = await evalJson(`(() => { const st = (${STORE_Q}); return { savedAt: st.state.habits.savedAt, moments: st.state.habits.moments.map(m => m.name), tombstones: st.state.habits.deletedMoments } })()`)
    assert.ok(restored, `moment card did not come back after clicking Undo [bug probe: savedAt before=${savedAtBeforeUndo} after=${undoDiag && undoDiag.savedAt} (same mechanism as J5's 2026-10-27 live probe: the Undo click fires commit('habits/replaceAll') with force:true, persist re-stamps savedAt, and the sticky deletedMoments tombstone merge re-filters the restored moment out), store moments=${JSON.stringify(undoDiag && undoDiag.moments)}, tombstones=${JSON.stringify(undoDiag && undoDiag.tombstones)}]`)
    assert.equal(restored.days, expectedDaysText, 'restored moment card lost its remaining-days text, got: ' + restored.days)
    const blobRestored = await pollFor(`window.todoAPI.dbCall('getMeta', 'db.habitsState').then(v => { const b = v ? JSON.parse(v) : null; return b && (b.moments||[]).some(x => x.name === ${JSON.stringify(name)}) ? 'db-ok' : null })`, 15, 400)
    assert.equal(blobRestored, 'db-ok', 'undo restored the moment card but the durable DB meta row lost it')
  } finally {
    await evalJson(`(() => { const st = (${STORE_Q}); if (!st) return 'no-store'; st.state.habits.moments.filter(x => x.name === ${JSON.stringify(name)}).forEach(x => st.commit('habits/delMoment', x.id)); return 'ok' })()`)
    await sleep(300)
    // W11: verify the DURABLE blob, not just the store commit (silent no-op = leak into later targets)
    await verifyBlobCleanup('moment', name).catch(e => { console.error('[j-habit-moment] J6 cleanup verification failed: ' + e.message); assert.fail(e.message) })
  }
})

test('J7 multi-day habit state: checked YESTERDAY only -> page shows yesterday done, today still open', { skip: !available || !isolated }, async () => {
  const name = 'E2E_J7_' + Math.random().toString(36).slice(2, 8)
  // Expected semantics read from HabitView.vue + store/habits.js before writing assertions:
  //  - daily habit => due today => check circle rendered, UNCHECKED (aria-checked="false")
  //  - streakOf: today lenient (due-but-unchecked does not break), yesterday checked => 1-day streak
  //  - 30-day grid (last30 ends today): yesterday cell .on, today cell off
  //  - month calendar: yesterday cell .checked with a .habit-cal-dot, today cell unchecked
  let habitId = null
  try {
    // seed via store commit (allowed seeding path): create daily habit + check in yesterday only
    const seeded = await evalJson(`(() => {
      const st = (${STORE_Q}); if (!st) return null;
      st.commit('habits/addHabit', { name: ${JSON.stringify(name)}, frequency: { type: 'daily' } });
      const h = st.state.habits.habits.find(x => x.name === ${JSON.stringify(name)});
      if (!h) return null;
      const ts = st.state.todo.todayTimestamp;
      const d = new Date(ts); d.setDate(d.getDate() - 1);
      const p = n => String(n).padStart(2, '0');
      const yKey = d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate());
      st.commit('habits/toggleCheck', { id: h.id, day: yKey });
      return { id: h.id, yKey }
    })()`)
    assert.ok(seeded && seeded.id, 'seeding the yesterday-checked habit through the store failed')
    habitId = seeded.id

    await evalJson(`location.hash='#/todo-list/habit'`)
    const todayKey = await evalJson(`(() => { const st = (${STORE_Q}); return (${PAGE_DAYKEY})(st.state.todo.todayTimestamp) })()`)
    const v = await pollFor(`(() => {
      const card = [...document.querySelectorAll('.habit-card')].find(c => (c.querySelector('.habit-name')||{}).textContent === ${JSON.stringify(name)});
      if (!card) return null;
      const circle = card.querySelector('.habit-check');
      const cells = card.querySelectorAll('.habit-grid__cell');
      const today = document.querySelector('.habit-cal-day.today');
      const yCell = today && today.previousElementSibling;
      const st = (${STORE_Q});
      const h = st && st.state.habits.habits.find(x => x.name === ${JSON.stringify(name)});
      return {
        circlePresent: !!circle,
        circleOn: !!(circle && circle.classList.contains('on')),
        ariaChecked: circle ? circle.getAttribute('aria-checked') : null,
        cells: cells.length,
        todayCellOn: !!(cells[29] && cells[29].classList.contains('on')),
        yesterdayCellOn: !!(cells[28] && cells[28].classList.contains('on')),
        streak: ((card.querySelector('.habit-streak')||{}).textContent||'').trim(),
        todayCalChecked: !!(today && today.classList.contains('checked')),
        yesterdayCalChecked: !!(yCell && yCell.classList.contains('checked')),
        yesterdayCalDot: !!(yCell && yCell.querySelector('.habit-cal-dot')),
        storeToday: !!(h && h.records && h.records[${JSON.stringify('TK')}]),
        storeYesterday: !!(h && h.records && h.records[${JSON.stringify('YK')}])
      }
    })()`.replaceAll('"TK"', JSON.stringify(todayKey)).replaceAll('"YK"', JSON.stringify(seeded.yKey)), 15, 400)
    assert.ok(v, 'seeded habit card did not render on the habit page')
    assert.ok(v.circlePresent, 'daily habit (due today) does not render a check circle')
    assert.ok(!v.circleOn && v.ariaChecked === 'false', 'check circle must be UNCHECKED for a yesterday-only habit (aria-checked=' + v.ariaChecked + ')')
    assert.equal(v.cells, 30, 'the 30-day check-in grid should render 30 cells, got ' + v.cells)
    assert.ok(v.yesterdayCellOn, 'the 30-day grid does not light YESTERDAY although it was checked')
    assert.ok(!v.todayCellOn, 'the 30-day grid lights TODAY although today was never checked')
    assert.ok(v.streak.includes('1-day streak') && !v.streak.includes('0-day'), 'streak should survive at 1 day for yesterday-checked/today-open, got: ' + v.streak)
    assert.ok(!v.todayCalChecked, 'month calendar marks today checked although today has no check-in')
    assert.ok(v.yesterdayCalChecked && v.yesterdayCalDot, 'month calendar does not mark yesterday as checked (dot missing)')
    assert.ok(v.storeYesterday && !v.storeToday, 'store records map wrong: yesterday=' + v.storeYesterday + ' today=' + v.storeToday)
    // durable DB row agrees with what the page shows
    const blob = await pollFor(`window.todoAPI.dbCall('getMeta', 'db.habitsState').then(vv => { const b = vv ? JSON.parse(vv) : null; const h = b && (b.habits||[]).find(x => x.name === ${JSON.stringify(name)}); return h && h.records && h.records[${JSON.stringify('YK')}] === true && !h.records[${JSON.stringify('TK')}] ? 'db-ok' : null })`.replaceAll('"YK"', JSON.stringify(seeded.yKey)).replaceAll('"TK"', JSON.stringify(todayKey)), 15, 400)
    assert.equal(blob, 'db-ok', 'durable DB meta row does not hold yesterday-only check-in for the seeded habit')
  } finally {
    await evalJson(`(() => { const st = (${STORE_Q}); if (!st) return 'no-store'; if (${JSON.stringify(habitId)}) st.commit('habits/delHabit', ${JSON.stringify(habitId)}); return 'ok' })()`)
    await sleep(300)
    // W11: verify the DURABLE blob, not just the store commit (silent no-op = leak into later targets)
    await verifyBlobCleanup('habit', name).catch(e => { console.error('[j-habit-moment] J7 cleanup verification failed: ' + e.message); assert.fail(e.message) })
  }
})

after(() => { try { ws?.close() } catch {} })
