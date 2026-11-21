/**
 * Sidebar foot theme quick-toggle — pure helpers, consumed by SnFootActions.vue.
 *
 * Why helpers and not a mixin (2026-11-20): tests/unit/components/structure.test.mjs pins every
 * identifier the template binds to a DECLARATION on the component (data/computed/methods/props).
 * Mixin-provided members are invisible to that static scan, so the guard — correctly, given its
 * "silent undefined render" purpose — reds the component. The state therefore lives in
 * SnFootActions (data/computed/methods) and the logic lives here, which also keeps it unit-testable
 * without mounting Vue.
 *
 * Semantics:
 *  - the icon shows the CURRENT theme (sun while dark, moon while light) and one click lands on the
 *    opposite EXPLICIT mode — picking 'system' in Settings keeps working and a footer click always
 *    produces a theme the user can see;
 *  - 'system' resolves against the live OS scheme, so the icon does not go stale when Windows flips
 *    light/dark while the app is open (main.js owns the document attribute; this owns the icon);
 *  - writes go through the `settings/update` action, not a raw commit, so main.js's
 *    settings/updateSettings subscriber re-applies data-theme and the value persists/syncs.
 */
import { resolveColorMode } from '../../utils/colorMode.js'

export const DARK_MQL = '(prefers-color-scheme: dark)'

/** Resolved theme right now: explicit colorMode wins, 'system' follows the live OS scheme */
export function isDarkNow (vm) {
  const mode = (vm.$store && vm.$store.state.settings && vm.$store.state.settings.colorMode) || 'light'
  return resolveColorMode(mode, vm.sysDark).dark
}

/** i18n key of the action the button performs (the label names the destination, not the state) */
export function themeLabelKey (isDark) {
  return isDark ? 'statsG.SideNav.themeToLight' : 'statsG.SideNav.themeToDark'
}

/** One click = the opposite of what is on screen; returns the dispatched promise or the target mode */
export function toggleThemeMode (vm) {
  const next = isDarkNow(vm) ? 'light' : 'dark'
  if (vm.$store && vm.$store.dispatch) return vm.$store.dispatch('settings/update', { colorMode: next })
  return next
}

/** Track the OS scheme for the lifetime of the component (no-op where matchMedia is absent) */
export function trackSystemScheme (vm) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
  const mql = window.matchMedia(DARK_MQL)
  vm.sysDark = !!mql.matches
  vm.sysMql = mql
  const onChange = e => { vm.sysDark = !!e.matches }
  if (mql.addEventListener) mql.addEventListener('change', onChange)
  else if (mql.addListener) mql.addListener(onChange) // older Chromium
  vm.sysSchemeListener = onChange
}

export function untrackSystemScheme (vm) {
  const mql = vm.sysMql
  const onChange = vm.sysSchemeListener
  if (!mql || !onChange) return
  if (mql.removeEventListener) mql.removeEventListener('change', onChange)
  else if (mql.removeListener) mql.removeListener(onChange)
}
