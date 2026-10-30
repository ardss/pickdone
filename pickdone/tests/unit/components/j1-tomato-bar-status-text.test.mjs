/**
 * J1 (2026-10-22 journey audit) — bottom-bar status label must be phase-aware.
 *
 * Bug: the no-attach branch of .tomato-timer__status hardcoded
 * $t('statsE.TomatoBar.readyStatus') (待开始), so a FREE focus/rest showed "待开始"
 * for its entire run while TomatoPanel/TomatoFloatPage/the native taskbar title said
 * 专注中/休息中 — the phase label was unreachable on the bottom bar (live-verified
 * on CDP 9382; see docs/journey-findings/pomodoro-auditor.md J1).
 *
 * Fix: the branch binds the existing (previously dead) `statusText` computed, which
 * returns restingStatus/focusingStatus while running and readyStatus when idle.
 *
 * Run: node --test tests/unit/components/j1-tomato-bar-status-text.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const SFC = path.join(ROOT, 'renderer/js/components/TomatoBar.vue')

const src = fs.readFileSync(SFC, 'utf8')

function loadComputed () {
  const m = src.match(/<script[^>]*>([\s\S]*?)<\/script>/)
  assert.ok(m, 'TomatoBar.vue: <script> block not found')
  const code = m[1]
    .replace(/^\s*import[\s\S]*?from\s+'[^']+'\s*(\/\/[^\n]*)?$/mg, '') // imports may carry trailing comments
    .replace(/\bas\s+any\b/g, '')
    .replace(/export\s+default\s*\{/, 'return {')
  const factory = new Function('roleButtonActivate', code) // roleButtonActivate runs at definition time (onRecordsKey)
  const component = factory(fn => fn)
  assert.ok(component.computed && typeof component.computed.statusText === 'function',
    'TomatoBar.vue: statusText computed missing')
  return component.computed.statusText
}

test('J1: no-attach status branch binds the phase-aware statusText computed (not a hardcoded state word)', () => {
  const template = src.match(/<template>[\s\S]*<\/template>/)[0]
  // The status region's no-attach branch must not hardcode readyStatus anymore.
  const statusBlock = template.match(/<div class="tomato-timer__status"[\s\S]*?<\/div>\s*<\/div>/)
  assert.ok(statusBlock, 'TomatoBar.vue: status region not found in template')
  assert.ok(!/readyStatus/.test(statusBlock[0].replace(/statusText[\s\S]*?\}\}/, '')) || !/\$t\('statsE\.TomatoBar\.readyStatus'\)/.test(statusBlock[0]),
    'status region still hardcodes statsE.TomatoBar.readyStatus — free focus/rest shows 待开始 while running again')
  assert.ok(/\{\{\s*statusText\s*\}\}/.test(statusBlock[0]), 'status region must bind {{ statusText }}')
})

test('J1: statusText returns 专注中 while focusing, 休息中 while resting, 待开始 when idle', () => {
  const statusText = loadComputed()
  const t = k => k // pass-through key probe
  assert.equal(statusText.call({ isRest: false, isWork: true, attachName: '', $t: t }), 'statsE.TomatoBar.focusingStatus')
  assert.equal(statusText.call({ isRest: true, isWork: false, attachName: '', $t: t }), 'statsE.TomatoBar.restingStatus')
  assert.equal(statusText.call({ isRest: false, isWork: false, attachName: '', $t: t }), 'statsH.TomatoBar.notStarted')
  // attached tasks keep the readyPrefix wording when idle
  assert.equal(statusText.call({ isRest: false, isWork: false, attachName: '写周报', $t: t }), 'statsE.TomatoBar.readyPrefix写周报')
})
