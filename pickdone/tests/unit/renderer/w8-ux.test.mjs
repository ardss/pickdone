/**
 * W8 UX batch (renderer) — regression guards for the component/view wave.
 * Fixes covered:
 *   [W8-1] empty matrix view renders the shared empty-state, not four empty drop quadrants
 *   [W8-2] group-header gear opens settings aimed at the retention tab (ui/openSettingsAt)
 *   [W8-3] shared dd-menu util (arrow cycling + Esc close/refocus); TodayView project filter adopts it
 *   [W8-4] setTomatoNoti exemption: stays on tomato/patch (blob-owned key), documented inline
 *   [W8-5] EditPanel category listbox arrow cycling
 *   [W8-6] EditPanel remote-refresh/collapse chips ride roleButtonActivate
 *   [W8-7] settings search Esc two-step; three radio-groups carry :aria-label
 *   [W8-8] statistics tablist arrows; tl-band/tl-seg role=img + aria-label
 *   [W8-9] heatmap tip hidden on view/period/heatRange switches
 *   [W8-10] day-strip calendar cells announce localized dates; focus-visible rings
 *   [W8-11] side-nav collapsed search pill rides roleButtonActivate
 *   [W8-12] habit moment row Enter submits; not-due habits show a today-off note
 *   [W8-13] hardware-accel toggle toasts the restart requirement
 *   [W8-14] priority segmented buttons carry aria-pressed
 * Run: node --test tests/unit/renderer/w8-ux.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

/* ---------- [W8-1] matrix empty state ---------- */

test('[W8-1] TodayView matrix branch renders the shared empty-state when matrixTasks is empty', () => {
  const src = read('renderer/js/views/TodayView.vue')
  const i = src.indexOf('else-if="viewMode===\'matrix\'"')
  const branch = src.slice(i, src.indexOf('else-if="viewMode===\'deck\'"'))
  assert.ok(branch.includes('empty-state v-if="!matrixTasks.length"'), 'empty-state gates the matrix grid')
  assert.ok(branch.includes('{{ emptyText }}'), 'reuses the list-view emptyText computed')
  assert.ok(branch.includes('statsC.TodoBox.emptyCreate'), 'offers the quick-add create entry')
  assert.ok(branch.includes('pd-matrix-grid v-else'), 'MatrixGrid only mounts non-empty')
  // EmptyState must be a registered local component
  assert.ok(src.includes("components: { TodoGroups, DayDateStrip, EmptyState,"), 'EmptyState registered')
})

/* ---------- [W8-2] gear -> openSettingsAt ---------- */

test('[W8-2] ui store has openSettingsAt/consumeSettingsTargetTab and TodoGroupBlock gear aims at general', () => {
  const ui = read('renderer/js/store/ui.js')
  assert.ok(/openSettingsAt \(s, tab\) \{[\s\S]{0,200}showSettingsModal = true/.test(ui), 'openSettingsAt opens the modal with a tab target')
  assert.ok(ui.includes('consumeSettingsTargetTab (s) { s.settingsModalTargetTab = null }'), 'one-shot target is consumable')
  const gear = read('renderer/js/components/TodoGroupBlock.vue')
  assert.ok(gear.includes("commit('ui/openSettingsAt', 'general')"), 'gear aims at the retention-range tab')
  assert.ok(!gear.includes("commit('ui/toggleSettings', true)"), 'gear no longer opens on the remembered tab')
  const sm = read('renderer/js/components/SettingsModal.vue')
  assert.ok(/const target = this\.\$store\.state\.ui\.settingsModalTargetTab[\s\S]{0,300}consumeSettingsTargetTab/.test(sm),
    'SettingsModal consumes the one-shot target on mount')
})

test('[W8-2b] plain toggleSettings never touches the target tab (remembered-tab memory preserved)', () => {
  const ui = read('renderer/js/store/ui.js')
  assert.ok(/toggleSettings \(s, v\) \{ s\.showSettingsModal = v == null \? !s\.showSettingsModal : v \}/.test(ui))
})

/* ---------- [W8-3] shared dd-menu util + TodayView adoption ---------- */

test('[W8-3] utils/dd-menu.js cycles option focus on ArrowDown/ArrowUp', async () => {
  const mod = await import(pathToFileURL(path.join(ROOT, 'renderer/js/utils/dd-menu.js')))
  assert.equal(typeof mod.ddMenuKey, 'function')
  const prev = globalThis.document
  // minimal DOM stand-in: three options, activeElement on the first
  const opts = ['a', 'b', 'c'].map(t => ({ text: t, focus () { globalThis.document.activeElement = this } }))
  globalThis.document = { activeElement: opts[0] }
  const menu = { querySelectorAll: sel => { assert.equal(sel, '[role="option"], li'); return opts } }
  const prevented = []
  const ev = key => ({ key, currentTarget: menu, preventDefault () { prevented.push(key) } })
  mod.ddMenuKey(ev('ArrowDown'), {})
  assert.equal(globalThis.document.activeElement, opts[1], 'ArrowDown moves focus forward')
  mod.ddMenuKey(ev('ArrowDown'), {})
  mod.ddMenuKey(ev('ArrowDown'), {})
  assert.equal(globalThis.document.activeElement, opts[0], 'arrows wrap at the end')
  mod.ddMenuKey(ev('ArrowUp'), {})
  assert.equal(globalThis.document.activeElement, opts[2], 'ArrowUp wraps backwards')
  assert.equal(prevented.length, 4, 'arrow handling preventDefaults scroll')
  // Escape only acts through onClose (stopPropagation + callback)
  let closed = 0
  let stopped = 0
  const escEv = { key: 'Escape', stopPropagation () { stopped++ } }
  mod.ddMenuKey(escEv, { onClose: () => { closed++ } })
  assert.equal(closed, 1); assert.equal(stopped, 1)
  mod.ddMenuKey({ key: 'Escape' }, {})
  assert.equal(closed, 1, 'no onClose = Escape untouched')
  globalThis.document = prev
})

test('[W8-3b] TodayView project filter: listbox/option roles + util wiring + close/refocus', () => {
  const src = read('renderer/js/views/TodoBoxView.vue')
  // TodoBoxView body itself must be untouched by the extraction (regression-averse)
  assert.ok(src.includes("ddMenuKey (e, popRef) {"), 'TodoBoxView keeps its local implementation')
  const tv = read('renderer/js/views/TodayView.vue')
  assert.ok(tv.includes('role="listbox"'), 'menu ul is a listbox')
  assert.ok(tv.includes('role="option"') && tv.includes(':aria-selected='), 'options carry aria-selected')
  assert.ok(tv.includes('ref="popProj"'), 'popover ref reachable for Esc close')
  assert.ok(tv.includes("ddMenuKey(e, { onClose: () => this.closeProjDd() })"), 'util handles the menu keys')
  const i = tv.indexOf('closeProjDd () {')
  const body = tv.slice(i, i + 500)
  assert.ok(body.includes('pop.hide()') && body.includes('.dropdown-select__label'), 'Esc hides the popover and refocuses the trigger')
  assert.ok(tv.includes("import { ddMenuKey } from '../utils/dd-menu.js'"), 'shared util imported')
})

/* ---------- [W8-4] tomato-noti exemption documented ---------- */

test('[W8-4] setTomatoNoti keeps tomato/patch with an inline exemption comment (blob-owned key)', () => {
  const src = read('renderer/js/components/SettingsModal.vue')
  const i = src.indexOf('async setTomatoNoti')
  const above = src.slice(Math.max(0, i - 800), i)
  assert.ok(above.includes('exemption'), 'exemption rationale documented above the writer')
  assert.ok(/setTomatoNoti \(v\) \{ this\.\$store\.commit\('tomato\/patch', \{ enableNotification: v \}\) \}/.test(src),
    'still routes through tomato/patch (the owning blob channel)')
  // the blob really persists: tomato patch mutation calls persistState
  const tomato = read('renderer/js/store/tomato.js')
  assert.ok(/patch \(s, p\) \{[\s\S]{0,900}persistState\(s\)/.test(tomato), 'tomato/patch persists the runtime blob')
  // and the key is not a settings-mirrored ledger key (that was the J4 drift class)
  const schema = read('renderer/js/store/settings-schema.js')
  assert.ok(schema.includes("TOMATO_LEDGER_KEYS = ['tomatoTime', 'restTime', 'dailyTomatoTarget']"),
    'enableNotification is not a mirrored settings ledger key')
})

/* ---------- [W8-5/6/14] EditPanel ---------- */

test('[W8-5] EditPanel category listbox wires the shared arrow-cycling util', () => {
  const src = read('renderer/js/components/EditPanel.vue')
  assert.ok(src.includes('class="ep-cat-pop" role="listbox" @keydown="onCatPopKey"'), 'listbox keydown bound')
  assert.ok(src.includes('onCatPopKey (e) { ddMenuKey(e) }'), 'no onClose: panel-level Esc stays the owner')
})

test('[W8-6] EditPanel remote-refresh/collapse chips ride roleButtonActivate (Enter-only + global Space)', () => {
  const src = read('renderer/js/components/EditPanel.vue')
  assert.ok(src.includes('@click="refreshFromStore" @keydown="onRemoteRefreshKey"'), 'refresh chip no longer Enter-only')
  assert.ok(src.includes('@click="collapse" @keydown="onCollapseKey"'), 'collapse chip no longer Enter-only')
  assert.ok(src.includes('onRemoteRefreshKey: roleButtonActivate(function () { this.refreshFromStore() })'))
  assert.ok(src.includes('onCollapseKey: roleButtonActivate(function () { this.collapse() })'))
  assert.ok(!src.includes('@keydown.enter.prevent="refreshFromStore"'), 'bare Enter binding removed')
  assert.ok(!src.includes('@keydown.enter.prevent="collapse"'), 'bare Enter binding removed')
})

test('[W8-14] priority segmented buttons carry aria-pressed', () => {
  const src = read('renderer/js/components/EditPanel.vue')
  const i = src.indexOf('ep-diff-btns ep-prio-btns')
  assert.ok(src.slice(i, i + 700).includes(":aria-pressed=\"((task&&task.priority)||0)===pr.v ? 'true' : 'false'\""))
})

/* ---------- [W8-7/13] SettingsModal ---------- */

test('[W8-7] settings search Esc clears a live query first; radio-groups carry :aria-label', () => {
  const src = read('renderer/js/components/SettingsModal.vue')
  assert.ok(src.includes('@keydown.esc.stop.prevent="onSearchEsc"'), 'search input owns Esc (stopped before the dialog handler)')
  const i = src.indexOf('onSearchEsc () {')
  const body = src.slice(i, i + 260)
  assert.ok(/if \(this\.searchQ\) \{ this\.clearSearch\(\); return \}/.test(body), 'step 1: clear the query')
  assert.ok(body.includes('this.close()'), 'step 2: close only when empty')
  for (const label of ['colorModeLabel', 'weekStartLabel', 'fontSizeLabel']) {
    assert.ok(new RegExp(`:aria-label="\\$t\\('statsE\\.SettingsModal\\.${label}'\\)"`).test(src), `radio-group aria-label via ${label}`)
  }
})

test('[W8-13] hardware-accel toggle announces the restart requirement via toast (zh/en key pair)', () => {
  const src = read('renderer/js/components/SettingsModal.vue')
  assert.ok(src.includes('@change="setHwAccel"'), 'switch routes through the toasting writer')
  const i = src.indexOf('setHwAccel (v) {')
  const body = src.slice(i, i + 300)
  assert.ok(body.includes('hwAccelRestartToast'), 'toast uses the new key')
  assert.ok(src.includes(`:title="$t('statsE.SettingsModal.hwAccelRestartTip')"`), 'hover hint retained (existing gate anchor)')
  const zh = read('renderer/js/i18n/locales/zh-CN-E.js')
  const en = read('renderer/js/i18n/locales/en-US-E.js')
  assert.ok(zh.includes('"hwAccelRestartToast"') && en.includes('"hwAccelRestartToast"'), 'zh/en keys paired')
})

/* ---------- [W8-8/9] StatisticsView ---------- */

test('[W8-8] statistics tablist arrows switch views; timeline bands/segments are labeled images', () => {
  const src = read('renderer/js/views/StatisticsView.vue')
  assert.ok(src.includes('@keydown="onStatTabKey"'), 'tablist keydown bound')
  const i = src.indexOf('onStatTabKey (e) {')
  const body = src.slice(i, i + 700)
  assert.ok(body.includes("'ArrowRight'") && body.includes("'ArrowLeft'"), 'left/right gesture')
  assert.ok(body.includes('% keys.length'), 'wraps across the view list')
  assert.ok(body.includes(".stat-view-tab.on"), 'focus follows the selected tab')
  assert.ok(src.includes('class="tl-band" role="img" :aria-label="b.title"'), 'bands labeled')
  assert.ok(src.includes('class="tl-seg unit" role="img" :aria-label="seg.title"'), 'unit segments labeled')
  assert.ok(src.includes('class="tl-seg rest" role="img" :aria-label="seg.title"'), 'rest segments labeled')
})

test('[W8-9] heatmap hover tip is hidden on view/period/heatRange switches', () => {
  const src = read('renderer/js/views/StatisticsView.vue')
  assert.ok(/view \(v\) \{ this\.syncQuery\(\); this\.hmTipHide\(\) \}/.test(src), 'view switch hides the tip')
  assert.ok(/period \(v\) \{ this\.syncQuery\(\); this\.hmTipHide\(\) \}/.test(src), 'period switch hides the tip')
  assert.ok(src.includes('heatRange () { this.hmTipHide() }'), 'heat-range switch hides the tip')
})

/* ---------- [W8-10] DayDateStrip ---------- */

test('[W8-10] calendar cells announce the localized date; popover controls have focus rings', () => {
  const src = read('renderer/js/components/DayDateStrip.vue')
  assert.ok(src.includes("import { dayjs, FMT } from '../utils/core.js'"), 'FMT imported')
  assert.ok(src.includes("calCellLabel (c) { return dayjs(c.key).format(FMT.cnDate) }"), 'localized label replaces ISO')
  assert.ok(src.includes('.ds-cal-cell:focus-visible') && src.includes('.ds-cal-head button:focus-visible'),
    'date cells and header nav buttons have visible focus')
})

/* ---------- [W8-11] SideNav ---------- */

test('[W8-11] collapsed search pill rides roleButtonActivate', () => {
  const src = read('renderer/js/components/SideNav.vue')
  assert.ok(src.includes('@keydown="onCollapsedSearchKey"'), 'bare Enter binding replaced')
  assert.ok(src.includes('onCollapsedSearchKey: roleButtonActivate(function () { this.expandAndFocusSearch() })'))
  assert.ok(!src.includes('@keydown.enter.prevent="expandAndFocusSearch"'))
})

/* ---------- [W8-12] HabitView ---------- */

test('[W8-12] moment row Enter submits; not-due habits show a today-off note (zh/en paired)', () => {
  const src = read('renderer/js/views/HabitView.vue')
  const iSec = src.indexOf('moment-add')
  const sec = src.slice(iSec, src.indexOf('</div>', iSec) + 2000)
  const nInputs = (sec.match(/@keydown\.enter\.prevent="e => \{ if \(e\.isComposing \|\| e\.keyCode === 229\) return; addMoment\(\) \}"/g) || []).length
  assert.ok(nInputs >= 2, 'name/date (and kind) inputs submit the moment row on Enter')
  const iElse = src.indexOf('v-else-if="!isDueToday(h)"')
  assert.ok(iElse > -1, 'not-due note keyed off isDueToday')
  assert.ok(src.slice(iElse, iElse + 200).includes('statsE.HabitView.notDueToday'))
  const zh = read('renderer/js/i18n/locales/zh-CN-E.js')
  const en = read('renderer/js/i18n/locales/en-US-E.js')
  assert.ok(zh.includes('"notDueToday": "今日不打卡"'), 'zh copy')
  assert.ok(en.includes('"notDueToday": "Not scheduled today"'), 'en copy')
})

/* ---------- i18n gate: new keys paired zh/en ---------- */

test('[W8-i18n] every W8-added key exists in BOTH zh-CN-E and en-US-E', () => {
  const zh = read('renderer/js/i18n/locales/zh-CN-E.js')
  const en = read('renderer/js/i18n/locales/en-US-E.js')
  for (const k of ['hwAccelRestartToast', 'notDueToday']) {
    assert.ok(zh.includes(`"${k}"`), `zh has ${k}`)
    assert.ok(en.includes(`"${k}"`), `en has ${k}`)
  }
})
