/**
 * D18-DOM3 renderer fixes — regression guards (source-anchor + extracted-behavior idiom).
 * Fixes covered:
 *   [F1] TodoGroupBlock gear locale copy is honest ("open view settings", not group-scoped)
 *   [F2] CalendarView time-grid task rows are keyboard-operable (role=button + roleButtonActivate)
 *   [F3] DepView predecessor chips keyboard-operable; complete checkbox on roleCheckboxActivate
 *   [F4] Space-dead-site sweep: roleButtonActivate at every role=button that was Enter-only
 *   [F5] workload bar tier helper (estimateTier): 0=unset/no bar, 1-2/3-4/5+ tiering
 *   [F6] StatisticsView custom range: empty draft shows the inline warn (no silent return UI)
 *   [F7] TaskAccountModal dialog aria-label from the task name
 *   [F8] cal-more-pop: Esc closes, focus moves into the dialog on open
 *   [F9] ContextMenuHost separator: invalid aria-disabled removed
 *   [F10] FilterModal duplicate smart-list name guard (pure filterNameTaken single source)
 *   [F11] ProjectOverviewView proj-card: role=button + aria-label + Space activation
 *   [F12] TodoBoxView listbox options select on Space too
 * Run: node --test tests/unit/renderer/d18-dom3-fixes.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')
const importMod = p => import(pathToFileURL(path.join(ROOT, p)).href)

/* ---------- [F1] honest gear copy ---------- */

test('[F1] TodoGroupBlock gear copy no longer claims a group-scoped settings surface', () => {
  assert.match(read('renderer/js/i18n/locales/en-US-E.js'), /"groupSettingsAria": "Open view settings"/)
  assert.match(read('renderer/js/i18n/locales/zh-CN-E.js'), /"groupSettingsAria": "打开视图设置"/)
  assert.ok(!/this group's view settings|本组视图设置/.test(read('renderer/js/i18n/locales/en-US-E.js') + read('renderer/js/i18n/locales/zh-CN-E.js')),
    'the misleading group-scoped copy is gone')
})

/* ---------- [F2] CalendarView time-grid tasks ---------- */

test('[F2] cal-tb__task rows are role=button with Space/Enter activation opening the same editor', () => {
  const src = read('renderer/js/views/CalendarView.vue')
  assert.match(src, /class="cal-tb__task"[\s\S]*?role="button" tabindex="0"/, 'task rows are focusable buttons')
  assert.match(src, /@keydown\.stop="onTbTaskKey\(t, \$event\)"/, 'activation bound (stopped vs cell create)')
  assert.match(src, /onTbTaskKey \(t, e\) \{[\s\S]{0,160}?roleButtonActivate\(function \(\) \{ this\.openTaskEditById\(t\.taskId\) \}, \{ stop: true \}\)[\s\S]{0,60}?\.call\(this, e\)/,
    'routes through the shared ARIA button helper')
  assert.match(src, /import \{ roleButtonActivate \} from '\.\.\/utils\/roleButtonKey\.js'/)
})

/* ---------- [F3] DepView chips + checkbox ---------- */

test('[F3] depv-miss predecessor chips are keyboard-operable buttons', () => {
  const src = read('renderer/js/components/DepView.vue')
  assert.match(src, /class="depv-miss" :title="m\.name"\s*\n\s*role="button" tabindex="0"/, 'chips are focusable buttons')
  assert.match(src, /@keydown\.stop="onMissKey\(m, \$event\)"/)
  assert.match(src, /onMissKey \(m, e\) \{[\s\S]{0,160}?roleButtonActivate\(function \(\) \{ this\.jumpTo\(m\.id\) \}, \{ stop: true \}\)[\s\S]{0,60}?\.call\(this, e\)/)
})

test('[F3] td-check complete toggle uses roleCheckboxActivate (Enter+Space, stopped)', () => {
  const src = read('renderer/js/components/DepView.vue')
  assert.match(src, /@click\.stop="completeTask\(t\)" @keydown="onCompleteKey\(t, \$event\)"/)
  assert.match(src, /onCompleteKey \(t, e\) \{[\s\S]{0,160}?roleCheckboxActivate\(function \(\) \{ this\.completeTask\(t\) \}\)[\s\S]{0,60}?\.call\(this, e\)/)
  assert.match(src, /import \{ roleButtonActivate, roleCheckboxActivate \} from '\.\.\/utils\/roleButtonKey\.js'/)
})

/* ---------- [F4] Space dead-site sweep ---------- */

const spaceSites = [
  ['renderer/js/components/TodoGroupBlock.vue', /@click="toggle" @keydown="onToggleKey"/, 'collapse header'],
  ['renderer/js/components/TodoGroupBlock.vue', /onToggleKey: roleButtonActivate\(function \(\) \{ this\.toggle\(\) \}\)/, 'collapse helper'],
  ['renderer/js/components/TodoGroupBlock.vue', /@click\.stop="gear" @keydown="onGearKey"/, 'gear button'],
  ['renderer/js/components/TodoGroupBlock.vue', /onGearKey: roleButtonActivate\(function \(\) \{ this\.gear\(\) \}, \{ stop: true \}\)/, 'gear helper'],
  ['renderer/js/components/TodoGroupBlock.vue', /@click\.stop="recomplete" @keydown="onRecompleteKey"/, 'reschedule button'],
  ['renderer/js/views/HabitView.vue', /class="habit-name" role="button" tabindex="0"[\s\S]*?@keydown="onRenameKey\(h, \$event\)"/, 'habit rename button'],
  ['renderer/js/views/HabitView.vue', /onRenameKey \(h, e\) \{[\s\S]{0,160}?roleButtonActivate\(function \(\) \{ this\.startRename\(h\) \}\)[\s\S]{0,60}?\.call\(this, e\)/, 'rename helper'],
  ['renderer/js/components/DayRail.vue', /@click="onRailClick" @keydown="onRailKey">/, 'rail expand'],
  ['renderer/js/components/DayRail.vue', /onRailKey \(e\) \{[\s\S]{0,160}?roleButtonActivate\(function \(\) \{ this\.toggleRail\(\) \}\)[\s\S]{0,60}?\.call\(this, e\)/, 'rail expand helper'],
  ['renderer/js/components/TomatoBar.vue', /aria-haspopup="dialog"\s*\n\s*@click="showRecordList" @keydown="onRecordsKey">/, 'records button (+aria-haspopup)'],
  ['renderer/js/components/TomatoBar.vue', /onRecordsKey: roleButtonActivate\(function \(\) \{ this\.showRecordList\(\) \}\)/, 'records helper'],
  ['renderer/js/views/CalendarView.vue', /@click="openEvent\(e\.id\)" @keydown="onPopEventKey\(e\.id, \$event\)"/, 'more-pop event rows'],
  ['renderer/js/components/MilestoneEditModal.vue', /@click="close" @keydown="onCloseKey"><\/div>/, 'dialog close'],
  ['renderer/js/components/MilestoneEditModal.vue', /onCloseKey: roleButtonActivate\(function \(\) \{ this\.close\(\) \}\)/, 'dialog close helper'],
  ['renderer/js/components/edit-panel/EpAttachments.vue', /@click="\$emit\('pick', 'img'\)" @keydown="onPickKey\('img', \$event\)"/, 'image picker'],
  ['renderer/js/components/edit-panel/EpAttachments.vue', /@click="\$emit\('pick', 'file'\)" @keydown="onPickKey\('file', \$event\)"/, 'file picker'],
  ['renderer/js/components/edit-panel/EpAttachments.vue', /@click\.stop="\$emit\('remove', 'imgList', i\)" @keydown="onRemoveKey\('imgList', i, \$event\)"/, 'image remove'],
  ['renderer/js/components/edit-panel/EpAttachments.vue', /@click\.prevent\.stop="openFileUrl\(f\)" @keydown="onOpenFileKey\(f, \$event\)"/, 'file open link'],
  ['renderer/js/components/edit-panel/EpAttachments.vue', /@click\.stop="\$emit\('remove', 'fileList', i\)" @keydown="onRemoveKey\('fileList', i, \$event\)"/, 'file remove'],
  ['renderer/js/components/edit-panel/EpAttachments.vue', /import \{ roleButtonActivate \} from '\.\.\/\.\.\/utils\/roleButtonKey\.js'/, 'helper import']
]
for (const [file, re, what] of spaceSites) {
  test(`[F4] ${path.basename(file)}: ${what} routes through roleButtonActivate (Enter+Space)`, () => {
    assert.match(read(file), re)
  })
}

test('[F4] row __content buttons (TodoBoxView/FilterView) activate on Space without double-firing the row', () => {
  const box = read('renderer/js/views/TodoBoxView.vue')
  const filter = read('renderer/js/views/FilterView.vue')
  assert.match(box, /todo-box-list-item__content" role="button" tabindex="0" :aria-label="t\.taskContent" @keydown="onContentKey\(t, \$event\)"/)
  assert.match(filter, /todo-box-list-item__content" role="button" tabindex="0" :aria-label="t\.taskContent" @keydown="onContentKey\(t, \$event\)"/)
  for (const src of [box, filter]) {
    assert.match(src, /onContentKey \(t, e\) \{ roleButtonActivate\(function \(\) \{ this\.openEdit\(t\) \}, \{ stop: true \}\)\.call\(this, e\) \}/)
  }
})

/* ---------- [F5] workload tier helper ---------- */

test('[F5] estimateTier: 0=unset, 1-2=lv1, 3-4=lv2, 5+=lv3; junk tolerated', async () => {
  const mod = await importMod('renderer/js/utils/tomatoEstimate.js')
  const { estimateTier } = mod
  assert.equal(estimateTier(0), 0, 'unset is tier 0')
  assert.equal(estimateTier(undefined), 0)
  assert.equal(estimateTier(-3), 0)
  assert.equal(estimateTier(1), 1)
  assert.equal(estimateTier(2), 1)
  assert.equal(estimateTier(3), 2)
  assert.equal(estimateTier(4), 2)
  assert.equal(estimateTier(5), 3)
  assert.equal(estimateTier(20), 3)
  assert.equal(estimateTier(2.4), 1, 'rounds before tiering')
})

test('[F5] both views render no bar for unset estimates and tier via the shared helper', () => {
  for (const f of ['renderer/js/views/TodoBoxView.vue', 'renderer/js/views/FilterView.vue']) {
    const src = read(f)
    assert.match(src, /v-if="tierOf\(t\)" class="todo-box-list-item__workload"/, f + ': unset renders no bar')
    assert.match(src, /tierOf \(t\) \{ return estimateTier\(getEstimate\(t\.taskId\)\) \}/, f + ': tiering via the shared helper')
    assert.ok(!/estOf\(t\) >= 3 && estOf\(t\) <= 4/.test(src), f + ': inline tiering gone')
  }
})

/* ---------- [F6] StatisticsView empty-range inline hint ---------- */

test('[F6] custom range actions show the pick-both-dates hint (same .stat-custom-warn idiom)', () => {
  const src = read('renderer/js/views/StatisticsView.vue')
  assert.match(src, /v-if="!customDraft \|\| !customDraft\[0\] \|\| !customDraft\[1\]" class="stat-custom-warn">\{\{ \$t\('statsA\.StatisticsView\.customEmpty'\) \}\}/)
  assert.match(src, /<span v-else-if="customDraftDays > 366"/, 'the too-long hint stays, chained after the empty hint')
  assert.match(read('renderer/js/i18n/locales/en-US-A.js'), /customEmpty: 'Pick both dates first'/)
  assert.match(read('renderer/js/i18n/locales/zh-CN-A.js'), /customEmpty: '请先选择起止日期'/)
})

/* ---------- [F7] TaskAccountModal dialog label ---------- */

test('[F7] task account dialog carries an aria-label bound to the task name', () => {
  const src = read('renderer/js/components/TaskAccountModal.vue')
  assert.match(src, /role="dialog" aria-modal="true" :aria-label="\$t\('statsK\.TomatoAccount\.title', \{ name: task \? task\.taskContent : '' \}\)"/)
})

/* ---------- [F8] cal-more-pop Esc + focus ---------- */

test('[F8] cal-more-pop closes on Esc and takes focus when opened', () => {
  const src = read('renderer/js/views/CalendarView.vue')
  assert.match(src, /class="cal-more-pop"[^>]*tabindex="-1" ref="morePopEl" @keydown\.esc="morePop = null"/, 'Esc bound on the dialog container')
  assert.match(src, /this\.\$nextTick\(\(\) => \{ const el = this\.\$refs\.morePopEl; if \(el && el\.focus\) el\.focus\(\) \}\)/, 'focus moved into the dialog on open')
})

/* ---------- [F9] ContextMenuHost separator ---------- */

test('[F9] role=separator no longer carries the invalid aria-disabled attribute', () => {
  const src = read('renderer/js/components/ContextMenuHost.vue')
  assert.match(src, /class="ctx-item sep" role="separator"><\/div>/)
  assert.ok(!/aria-disabled/.test(src), 'separators are non-interactive by role')
})

/* ---------- [F10] duplicate smart-list name guard ---------- */

test('[F10] filterNameTaken pure check: trimmed compare, own id exempt, empty name never taken', async () => {
  const mod = await importMod('renderer/js/store/filters.js')
  const { filterNameTaken } = mod
  const list = [
    { id: 1, name: ' This Week ' },
    { id: 2, name: 'High prio' }
  ]
  assert.equal(filterNameTaken(list, '  This Week  ', 9), true, 'ends are trimmed before compare')
  assert.equal(filterNameTaken(list, 'This Week', 1), false, 'own id exempt (rename to self)')
  assert.equal(filterNameTaken(list, 'High prio', 2), false)
  assert.equal(filterNameTaken(list, 'High prio', 3), true)
  assert.equal(filterNameTaken(list, '', 9), false, 'empty name never counts as taken')
  assert.equal(filterNameTaken(null, 'x', 9), false, 'null list tolerated')
})

test('[F10] FilterModal.save aborts on a duplicate name with the modal warning idiom', () => {
  const src = read('renderer/js/components/FilterModal.vue')
  assert.match(src, /import \{ filterNameTaken \} from '\.\.\/store\/filters\.js'/)
  assert.match(src, /filterNameTaken\(this\.\$store\.state\.filters\.list, name, this\.filter && this\.filter\.id\)/)
  assert.match(src, /this\.\$message\.warning\(this\.\$t\('statsJ\.FilterModal\.nameTaken'\)\); return \}/)
  assert.match(read('renderer/js/i18n/locales/en-US-J.js'), /'statsJ\.FilterModal\.nameTaken': 'A filter with this name already exists'/)
  assert.match(read('renderer/js/i18n/locales/zh-CN-J.js'), /'statsJ\.FilterModal\.nameTaken': '已存在同名过滤器'/)
})

/* ---------- [F11] ProjectOverviewView proj-card ---------- */

test('[F11] proj-card is role=button with a name aria-label and Space activation', () => {
  const src = read('renderer/js/views/ProjectOverviewView.vue')
  assert.match(src, /class="proj-card" tabindex="0" role="button"/)
  assert.match(src, /:aria-label="\$t\('statsB\.ProjectsView\.enterProject', \{ name: p\.cat\.categoryName \}\)"/)
  assert.match(src, /@click="open\(p\.cat\.categoryId\)" @keydown="onOpenKey\(p, \$event\)"/)
  assert.match(src, /onOpenKey \(p, e\) \{[\s\S]{0,160}?roleButtonActivate\(function \(\) \{ this\.open\(p\.cat\.categoryId\) \}\)[\s\S]{0,60}?\.call\(this, e\)/)
})

/* ---------- [F12] TodoBoxView listbox options ---------- */

test('[F12] sort/order/category options select on Space too (same activation helper)', () => {
  const src = read('renderer/js/views/TodoBoxView.vue')
  assert.match(src, /@click="setSort\(m\.value\)" @keydown="onSortKey\(m\.value, \$event\)"/)
  assert.match(src, /@click="setOrder\(o\.value\)" @keydown="onOrderKey\(o\.value, \$event\)"/)
  assert.match(src, /@click="setCat\(-1\)" @keydown="onCatKey\(-1, \$event\)"/)
  assert.match(src, /@click="setCat\(c\.categoryId\)" @keydown="onCatKey\(c\.categoryId, \$event\)"/)
  assert.match(src, /onSortKey \(v, e\) \{ roleButtonActivate\(function \(\) \{ this\.setSort\(v\) \}\)\.call\(this, e\) \}/)
  assert.match(src, /onOrderKey \(v, e\) \{ roleButtonActivate\(function \(\) \{ this\.setOrder\(v\) \}\)\.call\(this, e\) \}/)
  assert.match(src, /onCatKey \(v, e\) \{ roleButtonActivate\(function \(\) \{ this\.setCat\(v\) \}\)\.call\(this, e\) \}/)
  assert.ok(!/@keydown\.enter\.prevent="set(Sort|Order|Cat)\(/.test(src), 'Enter-only option bindings replaced')
})

/* ---------- [F13] DepView grip: honest pointer-only documentation ---------- */

test('[F13] DepView grip stays pointer-only with the honest comment (no faked button role)', () => {
  const src = read('renderer/js/components/DepView.vue')
  assert.match(src, /class="depv-task__grip" draggable="false" tabindex="-1"/)
  assert.match(src, /\[D18-DOM3\] The grip stays pointer-only/)
  const grip = src.match(/<button class="depv-task__grip"[^>]*>/)
  assert.ok(grip, 'grip button tag found')
  assert.ok(!/role=/.test(grip[0]), 'no button role on a non-activatable grip')
})
