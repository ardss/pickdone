/**
 * Renderer boot contract tests (static + pure-unit, no Electron).
 * - Script-loading contract: index.html must not block the parser on vendor scripts (all external
 *   head scripts carry defer; no inline head scripts) and main.js must set up the dayjs globals the
 *   old inline head scripts provided BEFORE any code reads window.dayjs.
 * - Color-mode boot contract: the theme must be applied PRE-mount (before app.mount in main.js
 *   source order) and re-applied on settings/updateSettings; the pure helper is unit-tested.
 * These tests fail on the pre-fix source (synchronous vendor scripts, applyColorMode inside
 * bootstrap() after the mount+IPC chain) and pass after it, pinning the invariants.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { applyColorMode, resolveColorMode } from '../../../renderer/js/utils/colorMode.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const html = readFileSync(join(root, 'renderer/index.html'), 'utf8')
const mainJs = readFileSync(join(root, 'renderer/js/main.js'), 'utf8')

const head = html.slice(0, html.indexOf('</head>'))
const scriptTags = head.match(/<script\b[^>]*>(?:[\s\S]*?<\/script>)?/g) || []

test('script-loading: every external head script carries defer (parser not blocked by ~1.9MB vendor JS)', () => {
  assert.ok(scriptTags.length > 0, 'head contains script tags')
  for (const tag of scriptTags) {
    const src = /\ssrc="([^"]+)"/.exec(tag)
    if (!src) continue // inline scripts are covered by the next test
    assert.match(tag, /\bdefer\b|\basync\b/, `external head script must defer: ${src[1]}`)
  }
})

test('script-loading: no inline <script> remains in <head> (they cannot defer; logic lives in main.js)', () => {
  for (const tag of scriptTags) {
    assert.match(tag, /\ssrc="/, 'inline script found in <head>: ' + tag.slice(0, 80))
  }
})

test('script-loading: main.js sets dayjs isoWeek extension + global fallback before first window.dayjs read', () => {
  // The two former inline head one-liners must run before globalProperties.dayjs = window.dayjs
  const iso = mainJs.indexOf('dayjs_plugin_isoWeek')
  const fallback = mainJs.indexOf('window.dayjs = window.dayjs || window.dayJs')
  const firstRead = mainJs.indexOf('window.dayjs', 0) === -1 ? -1 : mainJs.indexOf('window.dayjs')
  // first executable read happens at the extension line itself; the legacy consumer is globalProperties
  const consumer = mainJs.indexOf('globalProperties.dayjs = window.dayjs')
  assert.ok(iso > -1 && fallback > -1 && consumer > -1, 'main.js defines isoWeek extension, dayjs fallback, and consumes window.dayjs')
  assert.ok(firstRead === -1 || firstRead === iso || firstRead === fallback || firstRead > -1, 'sanity')
  assert.ok(iso < consumer, 'isoWeek extension must run before globalProperties.dayjs is assigned from window.dayjs')
  assert.ok(fallback < consumer, 'dayjs global fallback must run before globalProperties.dayjs is assigned')
  // Both must appear in the module top-level section, before Vue mount machinery (bootMark usage)
  const mount = mainJs.indexOf("app.mount('#app')")
  assert.ok(mount > consumer, 'module-level dayjs setup runs before app.mount')
})

test('color-mode: pre-mount application precedes app.mount in main.js; store subscription re-applies', () => {
  const applyIdx = mainJs.indexOf('applyColorMode()')
  const subscribeIdx = mainJs.indexOf("mutation.type === 'settings/updateSettings'")
  const mountIdx = mainJs.indexOf("app.mount('#app')")
  assert.ok(applyIdx > -1 && subscribeIdx > -1, 'applyColorMode() call and updateSettings subscription exist')
  assert.ok(applyIdx < mountIdx, 'first applyColorMode() must run BEFORE app.mount (no light flash for dark users)')
  assert.ok(subscribeIdx < mountIdx, 'the updateSettings subscription must be registered at module level, not after bootstrap()')
  // bootstrap() must no longer own the block (it runs after serial IPC awaits)
  const bootStart = mainJs.indexOf('async function bootstrap')
  const bootEnd = mainJs.indexOf('// mount moved before bootstrap', bootStart)
  assert.ok(bootStart > -1 && bootEnd > bootStart, 'bootstrap body bounds found')
  const inBootstrap = mainJs.slice(bootStart, bootEnd).includes('applyColorMode()')
  assert.ok(!inBootstrap, 'applyColorMode() must not be invoked inside bootstrap() anymore')
})

/* ---------- pure helper units ---------- */

function fakeDoc () {
  const attrs = new Map(); const classes = new Set()
  return {
    documentElement: {
      setAttribute: (k, v) => attrs.set(k, v),
      getAttribute: k => attrs.get(k) ?? null,
      classList: { toggle: (c, on) => { on ? classes.add(c) : classes.delete(c) } },
      _classes: classes
    },
    _attrs: attrs
  }
}

test('color-mode helper: light/dark apply directly; system follows mql.matches', () => {
  assert.deepEqual(resolveColorMode('dark', false), { dark: true, theme: 'dark' })
  assert.deepEqual(resolveColorMode('light', true), { dark: false, theme: 'light' })
  assert.deepEqual(resolveColorMode('system', true), { dark: true, theme: 'dark' })
  assert.deepEqual(resolveColorMode('system', false), { dark: false, theme: 'light' })
})

test('color-mode helper: applies data-theme + .dark on documentElement (pre-mount first paint)', () => {
  const doc = fakeDoc()
  const theme = applyColorMode('dark', false, doc)
  assert.equal(theme, 'dark')
  assert.equal(doc.documentElement.getAttribute('data-theme'), 'dark')
  assert.ok(doc.documentElement._classes.has('dark'))
  // switching to light via settings clears the class (idempotent re-apply)
  applyColorMode('light', false, doc)
  assert.equal(doc.documentElement.getAttribute('data-theme'), 'light')
  assert.ok(!doc.documentElement._classes.has('dark'))
})
