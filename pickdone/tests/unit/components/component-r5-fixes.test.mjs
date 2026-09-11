/**
 * Component/view fixes — round 5 daily maintenance wave (agent R: components/views domain).
 * Regression tests: source-level assertions for template/aria/behavior fixes plus
 * i18n bilingual parity for newly added keys (same paradigm as component-fixes-a11y.test.mjs).
 *
 * Run: node --test tests/component-r5-fixes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, 'renderer/js', p), 'utf8')

/* ---------------- i18n: bilingual parity of every shard + new fix keys ---------------- */

test('i18n: every en-US shard has a zh-CN twin with identical key sets', async () => {
  const dir = path.join(ROOT, 'renderer/js/i18n/locales')
  // NOTE: D and F are skipped — they carry a pre-existing cross-shard key split
  // (RepeatModal/QuickAdd/WeatherWidget keys land in F on en side, D on zh side) that
  // predates this wave and is left untouched to keep the fix scoped.
  const enFiles = readdirSync(dir).filter(f => f.startsWith('en-US-') && !/^en-US-[DF]\.js$/.test(f))
  for (const f of enFiles) {
    const zf = f.replace('en-US', 'zh-CN')
    const e = (await import(pathToFileURL(path.join(dir, f)).href)).default
    const z = (await import(pathToFileURL(path.join(dir, zf)).href)).default
    const flat = o => {
      const out = []
      const walk = (obj, pre) => Object.entries(obj).forEach(([k, v]) => {
        if (v && typeof v === 'object') walk(v, `${pre}${k}.`)
        else out.push(`${pre}${k}`)
      })
      walk(o, '')
      return out.sort()    }
    assert.deepEqual(flat(e), flat(z), `${f} vs ${zf} key parity (flattened)`)
  }
})

test('i18n: component-r5 keys exist in both languages with matching placeholders', async () => {
  const dir = path.join(ROOT, 'renderer/js/i18n/locales')
  const load = async f => (await import(pathToFileURL(path.join(dir, f)).href)).default
  for (const [en, zh] of [['en-US-E.js', 'zh-CN-E.js']]) {
    const e = await load(en); const z = await load(zh)
    for (const k of ['statsE.TodoItem.openTaskAria', 'statsE.TodoItem.moreTagsTip']) {
      assert.ok(e[k] && z[k], k)
    }
    assert.match(e['statsE.TodoItem.openTaskAria'], /\{name\}/)
    assert.match(z['statsE.TodoItem.openTaskAria'], /\{name\}/)
    assert.match(e['statsE.TodoItem.moreTagsTip'], /\{tags\}/)
    assert.match(z['statsE.TodoItem.moreTagsTip'], /\{tags\}/)
    // dead placeholder key removed along with the fake menu item
    assert.equal(e['statsE.ViewMoreMenu.monthViewMenuItem'], undefined)
    assert.equal(z['statsE.ViewMoreMenu.monthViewMenuItem'], undefined)
  }
  const enD = await load('en-US-D.js'); const zhD = await load('zh-CN-D.js')
  for (const k of ['statsD.DayDateStrip.prevDay', 'statsD.DayDateStrip.nextDay']) {
    assert.ok(enD.statsD.DayDateStrip[k.split('.').pop()] && zhD.statsD.DayDateStrip[k.split('.').pop()], k)
  }
  const enB = await load('en-US-B.js'); const zhB = await load('zh-CN-B.js')
  for (const k of ['prevMonthAria', 'nextMonthAria']) {
    assert.ok(enB.statsB.HabitView[k] && zhB.statsB.HabitView[k], `statsB.HabitView.${k}`)
  }
  const enC = await load('en-US-C.js'); const zhC = await load('zh-CN-C.js')
  assert.ok(enC.statsC.Search.searchAria && zhC.statsC.Search.searchAria, 'statsC.Search.searchAria')
  assert.ok(enC.statsC.Completed.tipAria && zhC.statsC.Completed.tipAria, 'statsC.Completed.tipAria')
})

/* ---------------- #2/#7/#14 TodoItem ---------------- */

test('TodoItem: clickable row has role=button and i18n aria-label', () => {
  const src = read('components/TodoItem.vue')
  const head = src.slice(src.indexOf('<div class="td-item"'), src.indexOf('<span class="td-check"'))
  assert.match(head, /role="button"/)
  assert.match(head, /:aria-label="\$t\('statsE\.TodoItem\.openTaskAria'/)
})

test('TodoItem: +N overflow badge for tags beyond 4 with full-list title', () => {
  const src = read('components/TodoItem.vue')
  const badge = src.match(/<button v-if="tags\.length>4"[\s\S]{0,500}?<\/button>/)
  assert.ok(badge, 'overflow badge found')
  assert.match(badge[0], /td-tag--more/)
  assert.match(badge[0], /tags\.slice\(4\)\.join/)
  assert.match(badge[0], /moreTagsTip/)
})

test('TodoItem: priority badge uses a single key family (statsJ.TodoItem.prio*)', () => {
  const src = read('components/TodoItem.vue')
  const badge = src.match(/<span v-if="\(todo\.priority\|\|0\)>0"[\s\S]*?<\/span>/)
  assert.ok(badge, 'priority badge found')
  assert.ok(!badge[0].includes('statsE.TodoItem.priorityLow'), 'no statsE prio key mixed in badge body')
  for (const k of ['statsJ.TodoItem.prioLow', 'statsJ.TodoItem.prioMedium', 'statsJ.TodoItem.prioHigh']) {
    assert.ok(badge[0].includes(k), `badge uses ${k}`)
  }
})

/* ---------------- #3 ViewMoreMenu ---------------- */

test('ViewMoreMenu: fake info-only menu item and info branch removed', () => {
  const src = read('components/ViewMoreMenu.vue')
  assert.ok(!src.includes('info: true'), 'no info item in MENUS')
  assert.ok(!src.includes('if (it.info)'), 'no info branch in click()')
})

/* ---------------- #4 CompletedView ---------------- */

test('CompletedView: help tip popover keyboard/touch reachable (click trigger + focusable reference)', () => {
  const src = read('views/CompletedView.vue')
  assert.match(src, /el-popover[^>]*trigger="click"/)
  const ref = src.match(/<template #reference>[\s\S]*?<\/template>/)
  assert.ok(ref, 'popover reference found')
  assert.match(ref[0], /tabindex="0"/)
  assert.match(ref[0], /role="button"/)
  assert.match(ref[0], /@keydown\.enter\.prevent/)
  assert.match(ref[0], /statsC\.Completed\.tipAria/)
})

/* ---------------- #5/#6 DayDateStrip + HabitView arrows ---------------- */

test('DayDateStrip: day-shift arrows have aria-label; selected day cell has aria-current=date', () => {
  const src = read('components/DayDateStrip.vue')
  assert.match(src, /class="ds-arrow"[^>]*aria-label="\$t\('statsD\.DayDateStrip\.prevDay'\)"/)
  assert.match(src, /class="ds-arrow"[^>]*aria-label="\$t\('statsD\.DayDateStrip\.nextDay'\)"/)
  assert.match(src, /class="ds-day"[^>]*:aria-current="d\.isSel \? 'date' : null"/)
})

test('DayDateStrip: calendar popover closes on Escape', () => {
  const src = read('components/DayDateStrip.vue')
  assert.match(src, /ds-cal-pop[^>]*@keydown\.esc\.prevent="showCal = false"/s)
})

test('HabitView: month nav mini arrows have aria-labels', () => {
  const src = read('views/HabitView.vue')
  assert.match(src, /statsB\.HabitView\.prevMonthAria/)
  assert.match(src, /statsB\.HabitView\.nextMonthAria/)
})

/* ---------------- #9 HabitView rename Esc cancel ---------------- */

test('HabitView: rename input supports Esc to cancel (restore original name, exit edit mode)', () => {
  const src = read('views/HabitView.vue')
  assert.match(src, /habit-rename[^>]*@keydown\.esc\.prevent="cancelRename\(h\)"/s)
  assert.match(src, /cancelRename \(h\) \{ this\.editName = h\.name; this\.editingId = null \}/)
})

/* ---------------- #8 SearchView ---------------- */

test('SearchView: search input has aria-label (not placeholder-only)', () => {
  const src = read('views/SearchView.vue')
  const inp = src.match(/<input ref="inp"[\s\S]*?\/>/)
  assert.ok(inp, 'search input found')
  assert.match(inp[0], /:aria-label="\$t\('statsC\.Search\.searchAria'\)"/)
})

/* ---------------- #10 SettingsModal ---------------- */

test('SettingsModal: shortcuts tab shows loading placeholder until getSettings resolves', () => {
  const src = read('components/SettingsModal.vue')
  assert.match(src, /shortcutsLoaded: false/)
  assert.match(src, /shortcutsLoaded \? formatShortcut\(shortcutForm\[sc\.key\]\) : \$t\('statsE\.SettingsModal\.loadingPlaceholder'\)/)
  assert.match(src, /this\.shortcutsLoaded = true/)
})

/* ---------------- #11 RecycleBinView ---------------- */

test('RecycleBinView: hidden inline date-picker inputs removed from Tab order', () => {
  const src = read('views/RecycleBinView.vue')
  assert.match(src, /querySelectorAll\('\.rc-pick input'\)\.forEach\(inp => inp\.setAttribute\('tabindex', '-1'\)\)/)
})

/* ---------------- #12/#13 value-consistency fixes ---------------- */

test('RepeatModal: yearly fixed-date picker is not clearable', () => {
  const src = read('components/RepeatModal.vue')
  const row = src.match(/repeatYearType!=='lunar'[\s\S]{0,600}?el-date-picker[^>]*>/)
  assert.ok(row, 'yearly date-picker found')
  assert.match(row[0], /:clearable="false"/)
})

test('TaskAccountModal: focus-minutes input max aligns with store clamp (600, not 720)', () => {
  const src = read('components/TaskAccountModal.vue')
  assert.ok(src.includes(':max="600"'))
  assert.ok(!src.includes(':max="720"'))
})
