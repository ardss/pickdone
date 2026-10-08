/**
 * [maint/d26 P2] "On-time" offset chip was a dead toggle: offsetPresetsList offered {v: 0},
 * but src/main/db-rows.js normOffsets/packReminders strip 0 on persist — the chip highlighted,
 * "persisted", and silently flipped back off on reload. "On time" IS the base reminder row, so
 * the preset was removed entirely (semantically redundant, nothing stored).
 * Pinned source-level (same no-Vue-mount convention as h7-editpanel-seams.test.mjs, which
 * already reads this exact .vue file).
 * Run: node --test tests/unit/components/maint-d26-offset-chip-dead-toggle.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const REMINDERS = readFileSync(path.join(ROOT, 'renderer/js/components/edit-panel/EpReminders.vue'), 'utf8')

function presetList () {
  const script = REMINDERS.indexOf('<script')
  const s = REMINDERS.indexOf('offsetPresetsList (', script) // the method definition, not the template call
  assert.ok(s >= 0, 'offsetPresetsList found')
  const body = REMINDERS.slice(s, REMINDERS.indexOf('toggleOffset', s))
  return [...body.matchAll(/\{ v: (-?\d+),/g)].map(m => Number(m[1]))
}

test('offset presets no longer offer the 0 (on-time) chip', () => {
  const vs = presetList()
  assert.ok(vs.length > 0, 'presets still exist')
  assert.ok(!vs.includes(0), 'no v:0 preset (it is silently stripped by normOffsets on persist)')
  assert.deepEqual(vs, [-10, -30, -60, -1440], 'the four before-hand presets remain, in order')
})
