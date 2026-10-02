/**
 * [uiux-2026-10-01 J6 P3] Settings tab contents (shortcuts / data / sync) rendered on every tab in
 * the dev host: each tab component had an HTML comment BEFORE its root div, so the dev compiler
 * (which keeps comments) made the component root a Fragment — and Vue cannot apply the parent's
 * v-show directive to a Fragment root. Production strips comments, so shipped Electron masked it.
 * Fix: the explanatory comments now live inside the root div, keeping the root a single element.
 * Run: node --test tests/unit/renderer/uiux-1001-settings-tab-root-fragment.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const TABS = [
  'renderer/js/components/settings/SettingsShortcutsTab.vue',
  'renderer/js/components/settings/SettingsDataTab.vue',
  'renderer/js/components/settings/SettingsSyncTab.vue'
]

test('J6 P3: settings tab components keep a single-element root (no comment before the root div)', () => {
  for (const p of TABS) {
    const src = read(p)
    // The first node inside <template> must be the root element — a leading comment makes the
    // root a Fragment and parent v-show silently stops applying in dev builds.
    const first = src.replace(/<template>\s*/, '').trimStart()
    assert.ok(first.startsWith('<div'), `${p}: root must be a plain <div>, not a comment`)
  }
})
