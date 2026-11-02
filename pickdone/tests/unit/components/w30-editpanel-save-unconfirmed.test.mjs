/**
 * [w30 P0] EditPanel "已入待保存队列 vs SQLite 已持久化" distinction.
 *
 * todo/updateTodoFields resolves once the row is IN the safeUpsert retry queue
 * (store/helpers/todoPendingUpserts.js) — the dispatch resolving is NOT proof SQLite holds the
 * row. store/todo.js is territory-frozen, so the fix lives on the consumer side: EditPanel's
 * verifyPersisted probe (2s after the save settles) checks the exported pendingUpserts() seam
 * and lights the weak "保存未确认" hint (NOT the hard save-failed banner).
 *
 * Run: node --test tests/unit/components/w30-editpanel-save-unconfirmed.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

// todoPendingUpserts hydrates from localStorage at load — stub the storage surface it touches.
globalThis.window = globalThis.window || { location: { hash: '' } }
globalThis.localStorage = globalThis.localStorage || {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {}
}

const { pendingUpserts } = await import(pathToFileURL(path.join(ROOT, 'renderer/js/store/helpers/todoPendingUpserts.js')).href)
const { createPersistProbe } = await import(pathToFileURL(path.join(ROOT, 'renderer/js/utils/editSave.js')).href)

/** Verbatim shape of EditPanel.verifyPersisted's predicate — the consumer-side probe contract. */
function rowStillQueued (taskId) {
  return pendingUpserts().some(en => en && en.params && en.params.taskId === taskId)
}

test('[w30.1] pendingUpserts seam: a queued row is visible to the consumer-side probe', () => {
  const q = pendingUpserts()
  const before = q.length
  const entry = { op: 'upsert', params: { taskId: 'w30-probe-task', title: 'x' } }
  q.push(entry)
  try {
    assert.equal(rowStillQueued('w30-probe-task'), true, 'entry present → NOT yet persisted → weak hint')
    assert.equal(rowStillQueued('other-task'), false)
    // safeUpsert's contract: the entry is removed only when the commit RESOLVES.
    q.splice(q.indexOf(entry), 1)
    assert.equal(rowStillQueued('w30-probe-task'), false, 'entry removed → persisted → hint stays off')
  } finally {
    if (q.length > before) q.splice(q.indexOf(entry), 1)
  }
})

test('[w30.1] createPersistProbe: queued row → verdict true; drained row → verdict false; cancel kills the timer', () => {
  const q = pendingUpserts()
  const entry = { op: 'upsert', params: { taskId: 'w30-probe-2', title: 'y' } }
  q.push(entry)
  const probe = createPersistProbe(pendingUpserts, { delayMs: 10 })
  let verdict = null
  probe.schedule('w30-probe-2', (still) => { verdict = still })
  return new Promise(resolve => setTimeout(() => {
    assert.equal(verdict, true, 'entry still queued after the settle window → unconfirmed')
    q.splice(q.indexOf(entry), 1)
    verdict = null
    probe.schedule('w30-probe-2', (still) => { verdict = still })
    setTimeout(() => {
      assert.equal(verdict, false, 'entry drained (commit resolved) → confirmed')
      // cancel: a scheduled probe that is cancelled never fires (unmounted panel)
      let fired = false
      probe.schedule('w30-probe-2', () => { fired = true })
      probe.cancel()
      setTimeout(() => { assert.equal(fired, false, 'cancelled probe stays silent'); resolve() }, 40)
    }, 40)
  }, 40))
})

test('[w30.1] EditPanel anchors: persist probe + weak hint child + i18n + lifecycle hygiene', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer/js/components/EditPanel.vue'), 'utf8')
  assert.ok(src.includes('pendingUpserts'), 'consumer imports the exported queue seam (store/todo.js untouched)')
  assert.ok(src.includes('createPersistProbe'), 'probe impl lives in utils/editSave.js (host line-budget safe)')
  assert.ok(src.includes('this._probe.schedule(this.e && this.e.taskId'), 'probe is scheduled per current task on save settle')
  assert.ok(src.includes('<ep-save-hint :show="saveUnconfirmed && !saveFailed"'), 'weak hint renders only when the hard banner is off (markup child)')
  assert.ok(src.includes("onFail: () => { this.saveFailed = true; this.saveUnconfirmed = false }"), 'hard failure suppresses the weak hint (no double banner)')
  assert.ok(src.includes('saveUnconfirmed = false // [w30 P0] the hint is per-task'), 'task switch re-hydrate clears the per-task hint')
  assert.ok(src.includes('if (this._probe) this._probe.cancel()'), 'beforeUnmount cancels the probe (no fire into unmounted panel)')
  const child = fs.readFileSync(path.join(ROOT, 'renderer/js/components/editpanel/EditPanelSaveHint.vue'), 'utf8')
  assert.ok(child.includes("class=\"ep-save-failed ep-save-unconfirmed\""), 'hint child carries the warning-tint class')
  assert.ok(child.includes('statsJ.EditPanel.saveUnconfirmed'), 'hint child renders the bilingual text')
  const css = fs.readFileSync(path.join(ROOT, 'renderer/js/components/edit-panel/editPanel.css'), 'utf8')
  assert.ok(css.includes('.ep-save-unconfirmed'), 'weak hint carries its own warning tint (distinct from the danger banner)')
})

test('[w30.1] i18n: bilingual saveUnconfirmed keys present in both locales', () => {
  const zh = fs.readFileSync(path.join(ROOT, 'renderer/js/i18n/locales/zh-CN-J.js'), 'utf8')
  const en = fs.readFileSync(path.join(ROOT, 'renderer/js/i18n/locales/en-US-J.js'), 'utf8')
  assert.ok(zh.includes("'statsJ.EditPanel.saveUnconfirmed'"), 'zh-CN key present')
  assert.ok(en.includes("'statsJ.EditPanel.saveUnconfirmed'"), 'en-US key present')
})
