/**
 * J4 (2026-10-22 journey audit) — TomatoPanel duration steppers must write the settings ledger.
 *
 * Bug: TomatoPanel.commitPatch raw-committed tomato/patch, so the panel's 专注/休息分钟 steppers
 * updated only the TRANSIENT tomato runtime blob. The settings ledger diverged on three surfaces
 * (live-verified): the SettingsModal 专注时长 input kept the old value in the same session (while
 * the adjacent tip promises 与番茄面板实时同步), the db settings mirror stayed behind, and the
 * next boot's settings restore mirrored the stale ledger over the panel's value — silently
 * reverting the user's choice.
 *
 * Fix: commitPatch dispatches settings/update — the canonical writer (SettingsModal.set uses the
 * same action), which mirrors the duration keys back down into tomato/patch (tomatoLedgerPatch),
 * so the running countdown still updates and every ledger agrees.
 *
 * Run: node --test tests/unit/components/j4-tomato-panel-settings-ledger.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readAnchorSet } from '../../lib/source-anchors.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const src = fs.readFileSync(path.join(ROOT, 'renderer/js/components/TomatoPanel.vue'), 'utf8')

test('J4: panel duration steppers write through settings/update (canonical writer), not a raw tomato/patch commit', () => {
  assert.ok(/commitPatch\s*\(p\)\s*\{\s*store\.dispatch\('settings\/update',\s*p\)\s*\}/.test(src),
    'TomatoPanel.commitPatch must dispatch settings/update')
  assert.ok(!/commit\('tomato\/patch',\s*p\)/.test(src),
    'TomatoPanel must not raw-commit tomato/patch for duration keys (settings ledger goes stale)')
})

test('J4: the settings/update action still mirrors duration keys down into the tomato ledger', () => {
  // settings-schema split (2026-10-24): the keys manifest moved to settings-schema.js —
  // the set anchor scans store + schema (mirror call site stays in the store).
  const settings = readAnchorSet('settingsStoreFamily')
  assert.ok(/mirrorTomatoLedger\s*\(commit,\s*patch\)/.test(settings),
    'settings/update must keep mirroring TOMATO_LEDGER_KEYS into tomato/patch')
  assert.ok(/TOMATO_LEDGER_KEYS = \['tomatoTime', 'restTime', 'dailyTomatoTarget'\]/.test(settings),
    'duration keys manifest unchanged')
})
