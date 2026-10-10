/**
 * maint/d23 FIX-3b round (renderer) — regression guards.
 * Fixes covered:
 *   [T1] TomatoBar rest-abandon awaits giveUp; startFocus dispatches are observed and surface failure toasts
 *   [T2] TomatoBar todayDone derives the day key from the reactive tick (`ts`), not a bare dayjs()
 *   [T3] TomatoPanel todayRecords derives the day key from the reactive tick (`nowTs`)
 *   [T4] utils/dispatchObserved.observeDispatch logs and re-throws action failures (executing test)
 * Run: node --test tests/unit/renderer/d23-fix3b-renderer-fixes.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

if (!globalThis.window.location) globalThis.window.location = { hash: '' }

/* ---------- [T1] tomato dispatch honesty ---------- */

test('[T1] TomatoBar rest-abandon awaits giveUp and surfaces a failure toast', () => {
  const src = read('renderer/js/components/TomatoBar.vue')
  const i = src.indexOf('async onPlayClick () {')
  assert.ok(i > -1, 'onPlayClick found')
  const body = src.slice(i, src.indexOf('cancelAttach', i) > -1 ? i + 2200 : undefined)
  const iAwait = body.indexOf('await observeDispatch(store, \'tomato/giveUp\', { record: false })')
  assert.ok(iAwait > -1, 'the rest-abandon giveUp dispatch is awaited')
  assert.ok(body.slice(iAwait).includes('reportDispatchFail(e)'), 'a failed abandon surfaces the failure toast, the countdown cannot keep running silently')
  assert.ok(body.includes("observeDispatch(store, 'tomato/startFocus')"), 'startFocus is observed, not fire-and-forget')
  assert.ok(src.includes('statsH.main.actionFailedMsg'), 'failure toast reuses the existing actionFailedMsg key (no new i18n)')
})

test('[T1] TomatoFloatPage reset() rest-abandon and btnMain startFocus are observed dispatches', () => {
  const src = read('renderer/js/views/TomatoFloatPage.vue')
  assert.ok(/startRestTime'\) \{ observeDispatch\(this\.\$store, 'tomato\/giveUp', \{ record: false \}\)\.catch\(this\.reportDispatchFail\)/.test(src),
    'the rest path of reset() routes giveUp through observeDispatch with a failure toast')
  assert.ok(/status === 'default'\) \{ observeDispatch\(this\.\$store, 'tomato\/startFocus'\)\.catch\(this\.reportDispatchFail\)/.test(src),
    'btnMain routes startFocus through observeDispatch with a failure toast')
})

/* ---------- [T2/T3] reactive "today" day key ---------- */

test('[T2] TomatoBar.todayDone keys off the reactive 1s tick field, not a bare dayjs()', () => {
  const src = read('renderer/js/components/TomatoBar.vue')
  const i = src.indexOf('todayDone () {')
  assert.ok(i > -1, 'todayDone computed found')
  const body = src.slice(i, i + 400)
  assert.ok(!/const key = dayjs\(\)\.format\(FMT\.date\)/.test(body),
    'the zero-reactive-dependency dayjs() call is gone')
  assert.ok(/const key = dayjs\(this\.ts \|\| Date\.now\(\)\)\.format\(FMT\.date\)/.test(body),
    'the day key derives from the reactive `ts` data field (refreshed by the 1s interval)')
})

test('[T3] TomatoPanel.todayRecords keys off the reactive 500ms tick field, not a bare dayjs()', () => {
  const src = read('renderer/js/components/TomatoPanel.vue')
  const i = src.indexOf('todayRecords () {')
  assert.ok(i > -1, 'todayRecords computed found')
  const body = src.slice(i, i + 400)
  assert.ok(!/const key = dayjs\(\)\.format\(FMT\.date\)/.test(body),
    'the zero-reactive-dependency dayjs() call is gone')
  assert.ok(/const key = dayjs\(this\.nowTs \|\| Date\.now\(\)\)\.format\(FMT\.date\)/.test(body),
    'the day key derives from the reactive `nowTs` data field (refreshed by the 500ms interval)')
})

/* ---------- [T4] executing test: utils/dispatchObserved ---------- */

test('[T4] observeDispatch awaits the action, logs once, and re-throws for the caller to toast', async () => {
  const { observeDispatch } = await import(new URL('file://' + path.join(ROOT, 'renderer/js/utils/dispatchObserved.js').replace(/\\/g, '/')).href)
  const seen = []
  const store = {
    dispatch (action, payload) {
      seen.push([action, payload])
      if (action === 'tomato/giveUp') return Promise.reject(new Error('ipc down'))
      return Promise.resolve({ ok: true })
    }
  }
  const ok = await observeDispatch(store, 'tomato/startFocus')
  assert.deepEqual(ok, { ok: true })
  await assert.rejects(() => observeDispatch(store, 'tomato/giveUp', { record: false }), /ipc down/,
    'the failure is re-thrown so the component .catch can surface the toast')
  assert.deepEqual(seen[1], ['tomato/giveUp', { record: false }], 'payload is passed through verbatim')
})

/* ---------- [A1] a11y sweep: Space joins Enter on role="button"/"checkbox" controls ---------- */

test('[A1] EditPanel routes every listed role control through roleButtonActivate/roleCheckboxActivate', () => {
  const src = read('renderer/js/components/EditPanel.vue')
  assert.ok(src.includes("import { roleButtonActivate, roleCheckboxActivate } from '../utils/roleButtonKey.js'"), 'both helpers imported')
  // the inline Enter-only bindings are gone from the listed controls
  assert.ok(!/@keydown\.enter\.prevent="(retrySave|setDate\(|askRepeatEdit|openDeadlinePick|delTask|toggleComplete)/.test(src),
    'no Enter-only keydown bindings remain on the swept role controls')
  assert.ok(/onSaveRetryKey: roleButtonActivate/.test(src), 'save-retry via roleButtonActivate')
  assert.ok(/onDateChipKey \(which, e\) \{\s*roleButtonActivate/.test(src.replace(/\r/g, '')) || /onDateChipKey \(which, e\) \{[\s\S]{0,80}roleButtonActivate/.test(src), 'four date chips via roleButtonActivate')
  assert.ok(/onCatRowKey: roleButtonActivate/.test(src), 'category row via roleButtonActivate')
  assert.ok(/onDoneRowKey: roleCheckboxActivate/.test(src), 'done row (checkbox pattern) via roleCheckboxActivate')
  assert.ok(/onRepeatRowKey: roleButtonActivate/.test(src), 'repeat row via roleButtonActivate')
  assert.ok(/onDeadlineRowKey: roleButtonActivate/.test(src), 'deadline row via roleButtonActivate')
  assert.ok(/onDelTaskKey: roleButtonActivate/.test(src), 'delete tool via roleButtonActivate')
})

test('[A1] TomatoFloatPage knob + remote chip, TomatoPanel remote chip, SideNav brand/search-clear', () => {
  const float = read('renderer/js/views/TomatoFloatPage.vue')
  assert.ok(/onKnobKey: roleButtonActivate/.test(float), 'float ring knob: Space joins Enter')
  assert.ok(/onRemoteKey: roleButtonActivate\(function \(\) \{ this\.openRemoteTodo\(\) \}, \{ stop: true \}\)/.test(float), 'float remote chip: Space joins Enter, stopped so the drag host never sees it')
  assert.ok(!/@keydown\.enter\.prevent="btnMain"/.test(float) && !/@keydown\.enter\.prevent\.stop="openRemoteTodo"/.test(float), 'Enter-only bindings removed on the float page')
  const panel = read('renderer/js/components/TomatoPanel.vue')
  assert.ok(/onRemoteKey: roleButtonActivate/.test(panel) && !/@keydown\.enter\.prevent="openRemoteTodo"/.test(panel), 'panel remote chip swept')
  const nav = read('renderer/js/components/SideNav.vue')
  assert.ok(/onBrandKey: roleButtonActivate/.test(nav), 'brand collapse swept')
  assert.ok(/onSearchClearKey: roleButtonActivate/.test(nav), 'search-clear swept')
})

test('[A1] TaskAccountModal ledger rows + ContextMenuHost menuitems use the shared activation; roving list role-pinned', () => {
  const modal = read('renderer/js/components/TaskAccountModal.vue')
  assert.ok(/onRowKey \(r, e\) \{\s*roleButtonActivate/.test(modal.replace(/\r/g, '')) || /onRowKey \(r, e\) \{[\s\S]{0,80}roleButtonActivate/.test(modal), 'ledger rows swept')
  assert.ok(!/@keydown\.enter\.prevent="toggleEdit\(r\)"/.test(modal), 'Enter-only binding removed from ledger rows')
  const ctx = read('renderer/js/components/ContextMenuHost.vue')
  assert.ok(/onItemKey \(it, e\) \{[\s\S]{0,120}roleButtonActivate/.test(ctx), 'menuitems swept (ARIA menuitem: Enter AND Space)')
  assert.ok(!/@keydown\.enter\.prevent="exec\(it\)"/.test(ctx), 'Enter-only binding removed from menuitems')
  assert.ok(ctx.includes(".ctx-item[role=\"menuitem\"]"), 'roving list selects real menuitems only, never separators')
})

/* ---------- [A2] TaskAccountModal switch auto-commits the dirty draft ---------- */

test('[A2] toggleEdit commits the previous dirty draft through the same save path before switching', () => {
  const src = read('renderer/js/components/TaskAccountModal.vue')
  const i = src.indexOf('toggleEdit (r) {')
  assert.ok(i > -1, 'toggleEdit found')
  const body = src.slice(i, i + 600)
  const iCommit = body.indexOf('this.commitDraftIfDirty()')
  const iAssign = body.indexOf('this.editingId = r.tomatoId')
  assert.ok(iCommit > -1 && iCommit < iAssign, 'the dirty-draft commit runs BEFORE the switch')
  assert.ok(/commitDraftIfDirty \(\) \{[\s\S]{0,900}this\.saveEdit\(true\)/.test(src), 'the dirty draft is committed via saveEdit(auto) (the editor-confirm save path, quiet autoSaved toast)')
  assert.ok(/Math\.round\(orig\.startMin\) === d\.startMin && orig\.dur === d\.dur && orig\.rest === d\.rest && orig\.abandoned === d\.abandoned/.test(src),
    'dirty check compares all four editable fields against the record')
  assert.ok(/if \(!d \|\| d\.create\) return[\s\S]{0,200}const orig = this\.records\.find/.test(src.replace(/\r/g, '')) || /commitDraftIfDirty \(\) \{[\s\S]{0,200}d\.create[\s\S]{0,200}records\.find/.test(src),
    'manual-add drafts (create) are left alone (no record to compare)')
})

/* ---------- [A3] TomatoFloatPage panel close restores focus to the opener ---------- */

test('[A3] closeMenu/closeNoisePanel/closeAbandon accept refocus and restore the toggle', () => {
  const src = read('renderer/js/views/TomatoFloatPage.vue')
  assert.ok(/closeMenu \(refocus = true\) \{[\s\S]{0,200}this\.refocusToggle\('menuBtn'\)/.test(src), 'menu close restores the ⋮ toggle')
  assert.ok(/closeNoisePanel \(refocus = true\) \{[\s\S]{0,200}this\.refocusToggle\('noiseBtn'\)/.test(src), 'noise close restores the ♪ toggle')
  assert.ok(/closeAbandon \(refocus = true\) \{[\s\S]{0,200}this\.refocusToggle\('knobEl'\)/.test(src), 'abandon close restores the ring knob')
  assert.ok(/refocusToggle \(ref\) \{[\s\S]{0,300}\$nextTick[\s\S]{0,200}this\.\$refs\[ref\][\s\S]{0,200}\.focus\(\)/.test(src),
    'the restore is a nextTick ref-focus (waits for the v-if panel to unmount)')
  // every user-facing close path goes through the refocusing closers
  assert.ok(/confirmAbandon[\s\S]{0,600}this\.closeAbandon\(\)/.test(src), 'confirmAbandon success closes via closeAbandon')
  assert.ok(/cancelAbandon \(\) \{\s*this\.closeAbandon\(\)/.test(src.replace(/\r/g, '')), 'cancelAbandon closes via closeAbandon')
  assert.ok(/pickTask[\s\S]{0,200}this\.closeMenu\(\)/.test(src), 'pickTask closes via closeMenu')
  assert.ok(/footerAction[\s\S]{0,200}this\.closeMenu\(\)/.test(src), 'footerAction closes via closeMenu')
  assert.ok(/if \(this\.noiseOpen\) this\.closeNoisePanel\(\)/.test(src), 'Escape closes noise via closeNoisePanel')
})
