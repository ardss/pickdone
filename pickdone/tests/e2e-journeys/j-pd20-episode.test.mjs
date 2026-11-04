/**
 * pd20 work-episode live journey — j-pd20-episode.test.mjs
 * PRODUCT-grade acceptance of the pd20 'continue work' (work episode) vertical: the USER
 * drives the real UI in a real isolated Electron instance. No bus-door shortcut, no mock:
 *
 *   Session A (fresh isolated userData):
 *   T1 boot: dedicated spawnApp instance, en-US locale, onboarding dismissed (real store).
 *   T2 gate: workEpisode section absent (default OFF) → settings/update ON → section visible
 *      on the real EditPanel of a UI-created task.
 *   T3 episode CRUD through the REAL form (EditPanelWork): type goal/outcome/nextAction →
 *      click Save → the persisted state line shows only after the commit resolves → dbCall
 *      read-back carries the round-trip note → history row renders the goal. Then UI EDIT
 *      (row click → form prefill → Update keeps id + startedAt) and UI DELETE
 *      (row button → read-back gone).
 *   T4 source bind/unbind/delete through the REAL source form: provider select + external id
 *      + title → Link → read-back carries linkId + canonicalUri (+L0) → resources row
 *      renders; UI unlink tombstones the link (read-back empty); UI re-link REUSES the same
 *      source ref (pair-unique dedupe); UI delete removes the ref itself.
 *   T5 Copy Handoff: real .ep-work-copy button → clipboard markdown carries goal/outcome/
 *      nextAction lines, the task title, [L0] and the canonicalUri — never "[object Object]".
 *
 *   RESTART (the restart-grade promise, a REAL process restart, not a page reload):
 *   T6 stopApp (graceful before-quit flush) → spawnApp on the SAME userDataDir → the gate,
 *      the episode rows and the source link all come back; reopen the panel and see them.
 *
 * Self-spawns a dedicated instance (spawnApp refuses non-isolated userData dirs by design;
 * TODO_SHARED_CDP is deliberately ignored here — the restart leg must OWN its instance).
 * Run: cd pickdone && node --test tests/e2e-journeys/j-pd20-episode.test.mjs
 */
delete process.env.TODO_SHARED_CDP // the restart leg must own its instance lifecycle
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnApp, stopApp, connectCdp, evalJson, send, sleep } from '../lib/runtime.mjs'
const diag = msg => { try { fs.appendFileSync(path.join(os.tmpdir(), 'j-pd20-diag.log'), new Date().toISOString() + ' ' + msg + '\n') } catch {} }

let ctx = null
let userDataDir = null
const storeQ = `(()=>{if(window.appUI&&window.appUI.$store)return window.appUI.$store;const a=document.getElementById('app')&&document.getElementById('app').__vue_app__;return a&&a._instance&&a._instance.proxy?a._instance.proxy.$store:null})()`

const untilJson = async (expr, tries = 12, gap = 500) => {
  for (let i = 0; i < tries; i++) {
    const v = await evalJson(ctx, expr)
    if (v) return v
    await sleep(gap)
  }
  return null
}
const pageCtx = async () => evalJson(ctx, `(() => {
  const panel = document.querySelector('.edit-panel')
  const sec = document.querySelector('.ep-work-section')
  return JSON.stringify({
    panels: document.querySelectorAll('.edit-panel').length,
    sections: document.querySelectorAll('.ep-work-section').length,
    sectionInPanel: !!document.querySelector('.edit-panel .ep-work-section'),
    buttons: sec ? [...sec.querySelectorAll('button')].map(b => b.className).join('|') : '',
    saveDirect: !!document.querySelector('.edit-panel .ep-work-section .ep-work-save-episode'),
    saveViaSec: sec ? !!sec.querySelector('.ep-work-save-episode') : null,
    secParent: sec ? (sec.closest('.edit-panel') ? 'in-panel' : sec.parentElement.className.slice(0, 60)) : '',
    saveCount: document.querySelectorAll('.ep-work-save-episode').length,
    title: (document.querySelector('.ep-title') || {}).textContent || ''
  })
})()`)
const clickEl = async predicateSrc => {
  // Vue re-renders can transiently detach the target node between the caller's readiness
  // assert and the click eval (observed live on the ep-work form actions). Poll briefly and
  // click when the element is actually present — the same as a user clicking a visible button.
  for (let i = 0; i < 12; i++) {
    const r = await evalJson(ctx, `(() => { const el = (${predicateSrc}); if (!el) return 'not-found'; el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); return 'clicked' })()`)
    if (r === 'clicked') return true
    if (r !== 'not-found') diag('click eval odd result<' + r + '> on expr<' + predicateSrc + '>')
    await sleep(300)
  }
  diag('click target never appeared | page context: ' + await pageCtx())
  return false
}
// clickSec: the ep-work buttons are addressed by PLAIN selector (clickEl wants an expression)
const clickSec = async sel => clickEl(`document.querySelector('${section(sel)}')`)
const typeInto = async (sel, text) => {
  const ok = await evalJson(ctx, `(() => {
    const el = document.querySelector('${sel}')
    if (!el) return false
    el.focus()
    const set = Object.getOwnPropertyDescriptor(el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set
    set.call(el, ${JSON.stringify(text)})
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
    return true
  })()`)
  if (!ok) diag('input missing: ' + sel + ' | page context: ' + await pageCtx())
  assert.ok(ok, 'input not found on the live page: ' + sel)
}
const boot = async () => {
  assert.ok(await untilJson(`document.querySelectorAll('.sn-nav-item').length > 0`, 40, 1000), 'the app did not finish booting within 40s')
  await send(ctx, 'Runtime.evaluate', { expression: "try{localStorage.setItem('appLocale','en-US')}catch(e){}" })
  // onboarding is a settings-schema key: dismiss through the AUTHORITATIVE store channel,
  // wait out the 2s settings dbMirror debounce, then reload so the tours stay dismissed
  await evalJson(ctx, `(()=>{const s=${storeQ};return s?s.dispatch('settings/update',{onboardingToursSeen:{today:1,editpanel:1,pips:1}}).then(()=>'ok'):'no-store'})()`)
  await sleep(2500)
  await send(ctx, 'Page.reload')
  assert.ok(await untilJson(`document.querySelectorAll('.sn-nav-item').length > 0`, 40, 1000), 'the app did not come back after the settings reload')
}
const gotoToday = async () => {
  await evalJson(ctx, `location.hash='#/todo-list/today'; 'ok'`)
  assert.ok(await untilJson(`!!document.querySelector('.qa-input')`, 15, 800), 'the today list (quick-add input) never appeared')
}
const quickAdd = async name => {
  await gotoToday()
  await evalJson(ctx, `(() => {
    const i = document.querySelector('.qa-input'); if (!i) return false; i.focus()
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(i, ${JSON.stringify(name)}); i.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(400)
  await evalJson(ctx, `(() => { const i = document.querySelector('.qa-input'); if (!i) return false; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true })); return true })()`)
  const row = await untilJson(`(async () => { const rows = await window.todoAPI.dbCall('queryTodos', { deleted: 0 }); return rows.find(r => r.taskContent === ${JSON.stringify(name)}) || null })()`, 12, 500)
  assert.ok(row && row.taskId, 'the quick-add Enter did not create the task row')
  return row.taskId
}
const openEditPanel = async name => {
  await gotoToday()
  if (await evalJson(ctx, `!!document.querySelector('.edit-panel')`)) {
    assert.ok(await closeEditPanel(), 'a leftover edit panel could not be closed before reopening')
  }
  const rowSel = `[...document.querySelectorAll('.td-item')].find(el => el.textContent.includes(${JSON.stringify(name)}))`
  assert.ok(await untilJson(`!!(${rowSel})`, 10, 400), `the seeded row "${name}" is not visible on the today list`)
  assert.ok(await clickEl(rowSel), 'clicking the task row did not open anything')
  // the row click is a toggle: if a close transition raced us the first click closed the
  // panel instead — retry once before failing
  let opened = await untilJson(`!!document.querySelector('.edit-panel')`, 5, 400)
  if (!opened) {
    assert.ok(await clickEl(rowSel), 'the retry row click failed')
    opened = await untilJson(`!!document.querySelector('.edit-panel')`, 6, 500)
  }
  assert.ok(opened, 'the edit panel did not open after clicking the row')
}
const closeEditPanel = async () => {
  // Deterministic close: the panel's own Esc path is a window keydown listener that races
  // transitions; the store commit the handler dispatches is the same door, minus the race.
  await send(ctx, 'Runtime.evaluate', {
    expression: `(async () => { const s = ${storeQ}; if (s) { await s.dispatch('ui/closeEditCleanup'); return 'closed' } return 'no-store' })()`,
    returnByValue: true, awaitPromise: true
  })
  for (let i = 0; i < 12; i++) {
    await sleep(500)
    if (!await evalJson(ctx, `!!document.querySelector('.edit-panel')`)) return true
  }
  return false
}
const section = sel => `.edit-panel .ep-work-section ${sel}`

test('T1 boot: dedicated isolated instance, en-US, onboarding dismissed', async () => {
  ctx = await spawnApp({ name: 'j-pd20-episode' })
  userDataDir = ctx.userDataDir
  assert.ok(userDataDir, 'spawnApp returned no userDataDir')
  await connectCdp(ctx)
  await boot()
})

test('T2 gate: section absent (default OFF) → settings ON (store chain + LS persist) → section visible', async () => {
  const name = 'pd20 T2 gate journey ' + Math.random().toString(36).slice(2, 6)
  await quickAdd(name)
  await openEditPanel(name)
  assert.ok(!await evalJson(ctx, `!!document.querySelector('${section('')}')`),
    'the work-episode section rendered while workEpisode.enabled is unset (the experiment gate is broken open)')
  const upd = await evalJson(ctx, `(async () => { const s = ${storeQ}; return s ? s.dispatch('settings/update', { workEpisode: { enabled: true } }) : null })()`)
  assert.ok(upd && upd.ok !== false, 'settings/update dispatch failed: ' + JSON.stringify(upd))
  assert.ok(await untilJson(`(() => { try { const v = JSON.parse(localStorage.getItem('settingsState') || '{}'); return !!(v.workEpisode && v.workEpisode.enabled) } catch { return false } })()`, 12, 500),
    'the switch did not persist to localStorage settingsState (it would die on the next boot)')
  assert.ok(await untilJson(`!!document.querySelector('${section('')}')`, 8, 500),
    'the work-episode section did not appear after workEpisode.enabled=true')
})

test('T3 episode CRUD through the REAL form: create → state line → read-back → edit keeps id/startedAt → delete', async () => {
  const name = 'pd20 T3 episode journey ' + Math.random().toString(36).slice(2, 6)
  const goal1 = 'Ship the pd20 vertical slice'
  const outcome1 = 'Slice merged and gated'
  const next1 = 'Run the live journey suite'
  const goal1b = 'Ship the pd20 vertical slice (revised)'
  const goal2 = 'A plain goal-only round'
  const taskId = await quickAdd(name)
  await evalJson(ctx, `(async () => { const s = ${storeQ}; if (s) await s.dispatch('settings/update', { workEpisode: { enabled: true } }); return true })()`)
  await openEditPanel(name)
  assert.ok(await untilJson(`!!document.querySelector('${section('[data-block="episode-form"]')}')`, 8, 500), 'the episode form block never rendered')

  // CREATE with all three fields
  await typeInto(section('[data-input="new-goal"]'), goal1)
  await typeInto(section('[data-input="outcome"]'), outcome1)
  await typeInto(section('[data-input="next-action"]'), next1)
  assert.ok(await clickSec('.ep-work-save-episode'), 'the Save button click failed')
  const state1 = await untilJson(`(() => { const el = document.querySelector('${section('[data-state="episode"]')}'); return el ? el.textContent.trim() : null })()`, 10, 400)
  assert.ok(state1 === 'Saved', `the persisted state line is not the success message, got ${JSON.stringify(state1)}`)
  // storage read-back: the note round-trips as field lines
  const eps1 = await untilJson(`(async () => { const e = await window.todoAPI.dbCall('queryEpisodesByTask', ${JSON.stringify(taskId)}); return (e && e.length) ? e : null })()`, 10, 500)
  assert.ok(eps1 && eps1.length === 1, 'the created episode did not land in storage')
  assert.ok(eps1[0].summary.includes('goal: ' + goal1), 'the stored note does not carry the goal line: ' + JSON.stringify(eps1[0].summary))
  assert.ok(eps1[0].summary.includes('outcome: ' + outcome1), 'the stored note does not carry the outcome line')
  assert.ok(eps1[0].summary.includes('nextAction: ' + next1), 'the stored note does not carry the nextAction line')
  const id1 = eps1[0].episodeId
  const started1 = eps1[0].startedAt
  // USER-VISIBLE: history row + current-status block render the goal
  assert.ok(await untilJson(`[...document.querySelectorAll('${section('[data-block="history"] .ep-work-row')}')].some(el => el.textContent.includes(${JSON.stringify(goal1)}))`, 10, 500),
    'the created episode never became visible in the work-history block')
  assert.ok(await untilJson(`(() => { const b = document.querySelector('${section('[data-block="current"] .ep-work-text')}'); return b && b.textContent.includes(${JSON.stringify(goal1)}) })()`, 6, 500),
    'the current-status block does not show the latest episode goal')

  // EDIT: row click prefills the form; Update keeps id and startedAt
  assert.ok(await clickSec('[data-episode-id="' + id1 + '"] .ep-work-edit'), 'the Edit button click failed')
  assert.ok(await untilJson(`(() => { const el = document.querySelector('${section('[data-input="edit-goal"]')}'); return el && el.value === ${JSON.stringify(goal1)} })()`, 8, 400),
    'the form was not prefilled with the row goal on edit')
  await typeInto(section('[data-input="edit-goal"]'), goal1b)
  await typeInto(section('[data-input="outcome"]'), outcome1)
  await typeInto(section('[data-input="next-action"]'), next1)
  assert.ok(await clickSec('.ep-work-save-episode'), 'the Update button click failed')
  const eps2 = await untilJson(`(async () => { const e = await window.todoAPI.dbCall('queryEpisodesByTask', ${JSON.stringify(taskId)}); return (e && e.length) ? e : null })()`, 10, 500)
  assert.ok(eps2 && eps2.length === 1, 'the edit must update in place, not mint a second row')
  assert.equal(eps2[0].episodeId, id1, 'the edit lost the episode id')
  assert.equal(eps2[0].startedAt, started1, 'the edit did not preserve startedAt')
  assert.ok(eps2[0].summary.includes('goal: ' + goal1b), 'the edit did not persist the revised goal')
  assert.ok(await untilJson(`[...document.querySelectorAll('${section('[data-block="history"] .ep-work-row')}')].some(el => el.textContent.includes(${JSON.stringify(goal1b)}))`, 10, 500),
    'the revised goal never became visible in the history row')

  // DELETE: create a second plain episode, then delete it via the row button
  await typeInto(section('[data-input="new-goal"]'), goal2)
  assert.ok(await clickSec('.ep-work-save-episode'), 'the second Save click failed')
  const eps3 = await untilJson(`(async () => { const e = await window.todoAPI.dbCall('queryEpisodesByTask', ${JSON.stringify(taskId)}); return (e && e.length === 2) ? e : null })()`, 10, 500)
  assert.ok(eps3, 'the second episode did not land in storage')
  const id2 = eps3.find(e => e.episodeId !== id1).episodeId
  assert.ok(await clickSec('[data-episode-id="' + id2 + '"] .ep-work-del'), 'the Delete button click failed')
  assert.ok(await untilJson(`(async () => { const e = await window.todoAPI.dbCall('queryEpisodesByTask', ${JSON.stringify(taskId)}); return (e && e.length === 1) ? true : null })()`, 10, 500),
    'the deleted episode is still in storage after the row Delete')
})

test('T4 source bind/unbind/delete through the REAL form: link → L0 read-back → unlink → re-link reuses ref → delete', async () => {
  const name = 'pd20 T4 source journey ' + Math.random().toString(36).slice(2, 6)
  const extId = 'docs/journey-' + Math.random().toString(36).slice(2, 8) + '.md'
  const title = 'Journey design notes'
  const taskId = await quickAdd(name)
  await evalJson(ctx, `(async () => { const s = ${storeQ}; if (s) await s.dispatch('settings/update', { workEpisode: { enabled: true } }); return true })()`)
  await openEditPanel(name)
  // LINK: provider select + external id + title (trust is L0-only in this slice)
  await typeInto(section('[data-input="provider"]'), 'github')
  await typeInto(section('[data-input="external-id"]'), extId)
  await typeInto(section('[data-input="source-title"]'), title)
  assert.ok(await clickSec('.ep-work-save-source'), 'the Link button click failed')
  const state = await untilJson(`(() => { const el = document.querySelector('${section('[data-state="source"]')}'); return el ? el.textContent.trim() : null })()`, 10, 400)
  assert.ok(state === 'Saved', `the source state line is not the success message, got ${JSON.stringify(state)}`)
  const srcs1 = await untilJson(`(async () => { const s = await window.todoAPI.dbCall('querySourcesByTask', ${JSON.stringify(taskId)}); return (s && s.length) ? s : null })()`, 10, 500)
  assert.ok(srcs1 && srcs1.length === 1, 'the linked source did not land in the task read-back')
  assert.equal(srcs1[0].canonicalUri, 'github://' + extId, 'the read-back canonicalUri does not compose provider://externalId')
  assert.equal(srcs1[0].level, 'L0', 'the read-back source must carry the L0 provenance level')
  assert.equal(srcs1[0].title, title, 'the read-back source lost its title')
  assert.ok(srcs1[0].linkId, 'the read-back lost the linkId (the unlink leg would be blind)')
  assert.ok(srcs1[0].sourceRefId, 'the read-back lost the sourceRefId (the delete leg would be blind)')
  assert.ok(await untilJson(`[...document.querySelectorAll('${section('[data-block="resources"] .ep-work-row')}')].some(el => el.textContent.includes(${JSON.stringify(title)}))`, 10, 500),
    'the linked source never became visible in the resources block')

  // UNLINK: tombstones the link only — a re-link of the SAME external id must reuse the ref
  assert.ok(await clickSec('.ep-work-unbind'), 'the Unlink button click failed')
  assert.ok(await untilJson(`(async () => { const s = await window.todoAPI.dbCall('querySourcesByTask', ${JSON.stringify(taskId)}); return (s && s.length === 0) ? true : null })()`, 10, 500),
    'the link is still in the read-back after the Unlink')
  const refId = srcs1[0].sourceRefId
  await typeInto(section('[data-input="provider"]'), 'github')
  await typeInto(section('[data-input="external-id"]'), extId)
  await typeInto(section('[data-input="source-title"]'), title)
  assert.ok(await clickSec('.ep-work-save-source'), 'the re-Link click failed')
  const srcs2 = await untilJson(`(async () => { const s = await window.todoAPI.dbCall('querySourcesByTask', ${JSON.stringify(taskId)}); return (s && s.length === 1) ? s : null })()`, 10, 500)
  if (!srcs2) diag('T4 re-link raw: srcs=' + (await evalJson(ctx, `(async () => JSON.stringify(await window.todoAPI.dbCall('querySourcesByTask', ${JSON.stringify(taskId)})))()`)) + ' state=' + (await evalJson(ctx, `(() => { const el = document.querySelector('${section('[data-state="source"]')}'); return el ? el.textContent.trim() : 'none' })()`)))
  assert.ok(srcs2, 'the re-linked source is not in the read-back')
  assert.equal(srcs2[0].sourceRefId, refId, 're-linking the same (providerId, externalId) must REUSE the existing source ref, not mint a duplicate')

  // DELETE: remove the ref itself → the joined read disappears
  assert.ok(await clickSec('.ep-work-src-del'), 'the source Delete button click failed')
  assert.ok(await untilJson(`(async () => { const s = await window.todoAPI.dbCall('querySourcesByTask', ${JSON.stringify(taskId)}); return (s && s.length === 0) ? true : null })()`, 10, 500),
    'the deleted source ref is still in the read-back after the row Delete')
})

test('T5 Copy Handoff: real button → clipboard markdown with goal/outcome/nextAction, [L0], canonicalUri; never "[object Object]"', async () => {
  const name = 'pd20 T5 handoff journey ' + Math.random().toString(36).slice(2, 6)
  const goal = 'Hand the pd20 slice to the next session'
  const outcome = 'All legs green'
  const next = 'Merge and publish'
  const extId = 'docs/handoff-' + Math.random().toString(36).slice(2, 8) + '.md'
  await quickAdd(name)
  await evalJson(ctx, `(async () => { const s = ${storeQ}; if (s) await s.dispatch('settings/update', { workEpisode: { enabled: true } }); return true })()`)
  await openEditPanel(name)
  // UI-driven data build: one full episode + one linked source
  await typeInto(section('[data-input="new-goal"]'), goal)
  await typeInto(section('[data-input="outcome"]'), outcome)
  await typeInto(section('[data-input="next-action"]'), next)
  assert.ok(await clickSec('.ep-work-save-episode'), 'the episode Save click failed')
  assert.ok(await untilJson(`(() => { const el = document.querySelector('${section('[data-state="episode"]')}'); return el && el.textContent.includes('Saved') })()`, 10, 400), 'the episode did not save')
  await typeInto(section('[data-input="provider"]'), 'manual')
  await typeInto(section('[data-input="external-id"]'), extId)
  assert.ok(await clickSec('.ep-work-save-source'), 'the source Link click failed')
  assert.ok(await untilJson(`(() => { const el = document.querySelector('${section('[data-state="source"]')}'); return el && el.textContent.includes('Saved') })()`, 10, 400), 'the source did not link')
  // the copy button only renders when the buildHandoff provider was injected (hasHandoff)
  await send(ctx, 'Page.bringToFront').catch(() => {}) // clipboard needs a focused page
  assert.ok(await untilJson(`!!document.querySelector('${section('.ep-work-copy')}')`, 10, 500),
    'the Copy Handoff button is not visible (the buildHandoff provide/inject chain broke — the S2 seam regressed)')
  assert.ok(await clickSec('.ep-work-copy'), 'the Copy Handoff button click failed')
  const state = await untilJson(`(() => { const el = document.querySelector('${section('.ep-work-copy-state')}'); return el ? el.textContent.trim() : null })()`, 8, 400)
  assert.ok(state === 'Copied to clipboard', `the copy feedback state is not the success message, got ${JSON.stringify(state)}`)
  const clip = await evalJson(ctx, `navigator.clipboard.readText()`)
  assert.ok(clip && typeof clip === 'string' && clip.length > 0, 'the clipboard is empty after Copy Handoff')
  assert.ok(!clip.includes('[object Object]'), 'the clipboard carries "[object Object]" — the exact regression this button shipped to kill')
  assert.ok(clip.includes('# Handoff'), 'the clipboard text is not the buildHandoff markdown (missing the "# Handoff" header)')
  assert.ok(clip.includes(name), 'the clipboard handoff does not name the real task title')
  assert.ok(clip.includes('goal: ' + goal), "the clipboard handoff's episode block does not carry the goal line")
  assert.ok(clip.includes('outcome: ' + outcome), "the clipboard handoff's episode block lost the filled outcome line")
  assert.ok(clip.includes('nextAction: ' + next), "the clipboard handoff's episode block lost the filled nextAction line")
  assert.ok(clip.includes('[L0]'), 'the clipboard handoff does not tag the source with its L0 provenance level')
  assert.ok(clip.includes('manual://' + extId), 'the clipboard handoff does not carry the linked source canonicalUri')
})

test('T6 RESTART: real process stop → respawn on the SAME userDataDir → gate + episode + source link all back', async () => {
  const name = 'pd20 T6 restart journey ' + Math.random().toString(36).slice(2, 6)
  const goal = 'This episode must outlive a real app restart'
  const extId = 'docs/restart-' + Math.random().toString(36).slice(2, 8) + '.md'
  const taskId = await quickAdd(name)
  await evalJson(ctx, `(async () => { const s = ${storeQ}; if (s) await s.dispatch('settings/update', { workEpisode: { enabled: true } }); return true })()`)
  await openEditPanel(name)
  await typeInto(section('[data-input="new-goal"]'), goal)
  assert.ok(await clickSec('.ep-work-save-episode'), 'the episode Save click failed')
  assert.ok(await untilJson(`(() => { const el = document.querySelector('${section('[data-state="episode"]')}'); return el && el.textContent.includes('Saved') })()`, 10, 400), 'the episode did not save')
  await typeInto(section('[data-input="provider"]'), 'manual')
  await typeInto(section('[data-input="external-id"]'), extId)
  assert.ok(await clickSec('.ep-work-save-source'), 'the source Link click failed')
  assert.ok(await untilJson(`(() => { const el = document.querySelector('${section('[data-state="source"]')}'); return el && el.textContent.includes('Saved') })()`, 10, 400), 'the source did not link')
  assert.ok(await closeEditPanel(), 'the edit panel could not be closed before the restart')

  // REAL restart: graceful stop (before-quit flush) → respawn on the SAME userDataDir
  await stopApp(ctx)
  ctx = await spawnApp({ name: 'j-pd20-episode-restart', userDataDir })
  await connectCdp(ctx)
  await boot()
  // the gate survived
  const gate = await evalJson(ctx, `(() => { const s = ${storeQ}; return !!(s && s.state && s.state.settings && s.state.settings.workEpisode && s.state.settings.workEpisode.enabled) })()`)
  assert.ok(gate, 'workEpisode.enabled did not survive the restart (the settings write-through is broken)')
  // storage reads survived
  const eps = await untilJson(`(async () => { const e = await window.todoAPI.dbCall('queryEpisodesByTask', ${JSON.stringify(taskId)}); return (e && e.length) ? e : null })()`, 10, 500)
  if (!eps || !eps.some(e => e.summary.includes(goal))) diag('T6 raw: taskId=' + taskId + ' eps=' + (await evalJson(ctx, `(async () => JSON.stringify(await window.todoAPI.dbCall('queryEpisodesByTask', ${JSON.stringify(taskId)})))()`)) + ' tasks=' + (await evalJson(ctx, `(async () => { const r = await window.todoAPI.dbCall('queryTodos', { deleted: 0 }); return JSON.stringify(r.map(x => x.taskId)) })()`)))
  // a goal-only save stores the PLAIN note (no field lines) — the goal text is the round-trip contract
  assert.ok(eps && eps.some(e => e.summary.includes(goal)), 'the episode did not survive the restart')
  const srcs = await untilJson(`(async () => { const s = await window.todoAPI.dbCall('querySourcesByTask', ${JSON.stringify(taskId)}); return (s && s.length) ? s : null })()`, 10, 500)
  assert.ok(srcs && srcs.some(s => s.canonicalUri === 'manual://' + extId && s.level === 'L0'), 'the source link did not survive the restart')
  // USER-VISIBLE: reopen the panel on the RESTARTED process — everything renders again
  await openEditPanel(name)
  assert.ok(await untilJson(`!!document.querySelector('${section('')}')`, 8, 500), 'the work-episode section did not re-appear after the restart')
  assert.ok(await untilJson(`[...document.querySelectorAll('${section('[data-block="history"] .ep-work-row')}')].some(el => el.textContent.includes(${JSON.stringify(goal)}))`, 8, 500),
    'the episode history row is not visible after the restart')
  assert.ok(await untilJson(`[...document.querySelectorAll('${section('[data-block="resources"] .ep-work-row')}')].some(el => el.textContent.includes(${JSON.stringify('manual://' + extId)})) || [...document.querySelectorAll('${section('[data-block="resources"] .ep-work-row')}')].some(el => el.textContent.includes('docs/restart-'))`, 8, 500),
    'the linked resource row is not visible after the restart')
})

after(async () => { try { if (ctx) await stopApp(ctx) } catch { /* already stopped */ } })
