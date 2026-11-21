/**
 * Sidebar foot theme quick-toggle (2026-11-20 user request: "左下角同步/回收站/设置那一排再加一个
 * 切换深浅色的图标").
 *
 * Covers four layers so the feature cannot silently rot:
 *  1. resolved-theme contract (light / dark / system + live OS scheme);
 *  2. click semantics — one click lands on the OPPOSITE EXPLICIT mode through settings/update
 *     (a raw commit would skip main.js's data-theme re-apply and the persistence path);
 *  3. wiring — moon icon, both foot variants, and the repo's two structural contracts
 *     (no <style scoped>; every template identifier declared on the component — the reason this
 *     is helpers + component declarations instead of a mixin);
 *  4. both locales carry the labels.
 *
 * Run: node --test tests/unit/components/sn-foot-theme-toggle.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { isDarkNow, themeLabelKey, toggleThemeMode } from '../../../renderer/js/components/side-nav/themeToggle.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')
const vm = (colorMode, sysDark) => ({ $store: { state: { settings: { colorMode } } }, sysDark })

test('isDarkNow: explicit modes win, "system" follows the live OS scheme', () => {
  assert.equal(isDarkNow(vm('dark', false)), true)
  assert.equal(isDarkNow(vm('dark', true)), true)
  assert.equal(isDarkNow(vm('light', true)), false)
  assert.equal(isDarkNow(vm('system', true)), true)
  assert.equal(isDarkNow(vm('system', false)), false)
  // degraded store (boot order, tests): never throw, fall back to light
  assert.equal(isDarkNow({ $store: null, sysDark: false }), false)
})

test('isDarkNow: a missing colorMode (pre-migration settings blob) resolves to light, not dark', () => {
  assert.equal(isDarkNow(vm(undefined, false)), false)
  assert.equal(isDarkNow(vm(undefined, true)), false)
})

test('the label names the destination: to-dark while light, to-light while dark', () => {
  assert.equal(themeLabelKey(false), 'statsG.SideNav.themeToDark')
  assert.equal(themeLabelKey(true), 'statsG.SideNav.themeToLight')
})

test('toggleThemeMode: dispatches the OPPOSITE explicit mode through settings/update', async () => {
  const calls = []
  const mk = (colorMode, sysDark) => ({
    sysDark,
    $store: { state: { settings: { colorMode } }, dispatch: (...args) => { calls.push(args); return Promise.resolve() } }
  })
  await toggleThemeMode(mk('light', false))
  await toggleThemeMode(mk('dark', true))
  assert.deepEqual(calls, [
    ['settings/update', { colorMode: 'dark' }],
    ['settings/update', { colorMode: 'light' }]
  ])
  // never writes 'system' — one click always lands on a concrete, visible theme
  for (const [, patch] of calls) assert.notEqual(patch.colorMode, 'system')
})

test('toggleThemeMode: degrades to returning the target mode when no store is mounted', () => {
  // no store at all: colorMode is unknown → resolves light → target dark (never throws)
  assert.equal(toggleThemeMode({ $store: null, sysDark: false }), 'dark')
  // store present but no dispatch (degraded host): the target still comes back for the caller
  assert.equal(toggleThemeMode({ $store: { state: { settings: { colorMode: 'dark' } } } }), 'light')
})

test('AppIcon ships the moon glyph next to the sun glyph', () => {
  const icons = read('renderer/js/components/AppIcon.js')
  assert.match(icons, /^\s*moon:\s*'M21 12\.79A9 9 0 1 1 11\.21 3 7 7 0 0 0 21 12\.79z',?$/m)
  assert.match(icons, /^\s*sun:/m)
})

test('SnFootActions renders the toggle in BOTH foot variants', () => {
  const foot = read('renderer/js/components/side-nav/SnFootActions.vue')
  // expanded (sn-account row) + collapsed (sn-collapsed-foot): one data-act="theme" each
  assert.equal((foot.match(/data-act="theme"/g) || []).length, 2)
  assert.equal((foot.match(/@click="toggleTheme"/g) || []).length, 2)
  // state is conveyed to AT, and the icon reflects the CURRENT theme (sun while dark)
  assert.equal((foot.match(/:aria-pressed="isDark \? 'true' : 'false'"/g) || []).length, 2)
  assert.equal((foot.match(/:name="isDark \? 'sun' : 'moon'"/g) || []).length, 2)
  // the settings gear keeps its own contract (updater dot)
  assert.match(foot, /v-if="updateReady" class="sn-upd-dot"/)
})

test('SnFootActions declares every identifier its template binds (structure guard contract)', () => {
  const foot = read('renderer/js/components/side-nav/SnFootActions.vue')
  // no mixins: the guard scans declarations on the component and would red a mixin-provided member
  assert.ok(!/mixins:/.test(foot), 'theme state must be declared on the component, not injected by a mixin')
  for (const decl of [/isDark \(\)/, /themeToggleLabelKey \(\)/, /toggleTheme \(\)/, /sysDark: false/]) {
    assert.match(foot, decl)
  }
  // and it must not reintroduce the two shape-level regressions the suite caught
  assert.ok(!/<style[^>]*\sscoped/.test(foot), '<style scoped> is forbidden (global cascade contract)')
  assert.match(foot, /<style>[\s\S]*\.sn-foot-cluster \{ display: flex; align-items: center; gap: 4px; \}/)
})

test('SideNav.vue stays out of it: the foot is mounted by the parent without new props', () => {
  const sideNav = read('renderer/js/components/SideNav.vue')
  assert.ok(!/sn-foot-actions[^>]*:dark=/.test(sideNav), 'parent must not own theme state')
  assert.match(sideNav, /<sn-foot-actions collapsed/)
})

test('both locales carry the toggle labels (a missing key renders the raw path)', () => {
  for (const file of ['renderer/js/i18n/locales/zh-CN-G.js', 'renderer/js/i18n/locales/en-US-G.js']) {
    const src = read(file)
    assert.match(src, /themeToDark:\s*'[^']+'/, file + ' themeToDark')
    assert.match(src, /themeToLight:\s*'[^']+'/, file + ' themeToLight')
  }
})
