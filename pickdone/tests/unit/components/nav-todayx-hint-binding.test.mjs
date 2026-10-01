import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Regression: the developer-mode sidebar nav item "今日·实验" (todo-list-today-x) had no
// title/aria hint even though the explanation string sTodayX
// ("今日·实验（实验性 · 不建议日常使用）") already existed for the settings toggle — the
// string was simply not wired to the nav item. The fix adds navHint()/navAria() to
// side-nav/sideNavHandlers.js and binds them in SideNav.vue's nav-item template.
// Run: node --test tests/unit/components/nav-todayx-hint-binding.test.mjs

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

test('navHint: today-x resolves the existing disclaimer string; other items get no hint', async () => {
  const { navHint } = await import('../../../renderer/js/components/side-nav/sideNavHandlers.js')
  const zhE = (await import('../../../renderer/js/i18n/locales/zh-CN-E.js')).default
  const sTodayX = zhE.statsE.SettingsModal.sTodayX
  assert.ok(sTodayX && sTodayX.includes('实验性'), 'precondition: the disclaimer string exists in zh-CN-E')
  assert.equal(navHint({}, 'todo-list-today-x'), sTodayX, 'today-x hint is wired to the existing sTodayX string')
  assert.equal(navHint({}, 'todo-list-today'), '', 'ordinary items keep no-hint behavior')
})

test('navAria: today-x announces label + hint; ordinary items stay null (text-content fallback)', async () => {
  const { navAria, navLabel, navHint } = await import('../../../renderer/js/components/side-nav/sideNavHandlers.js')
  const n = 'todo-list-today-x'
  assert.equal(navAria({}, n), `${navLabel({}, n)} — ${navHint({}, n)}`, 'aria text contains the visible label and the hint')
  assert.equal(navAria({}, 'todo-list-today'), null)
})

test('SideNav.vue template binds the hint into title (expanded) and aria-label on the nav item', () => {
  const tpl = read('renderer/js/components/SideNav.vue')
  assert.ok(tpl.includes(':title="collapsed ? navLabel(n) : navHint(n)"'), 'expanded nav item exposes the hint as tooltip')
  assert.ok(tpl.includes(':aria-label="navAria(n)"'), 'nav item exposes the combined aria label')
})
