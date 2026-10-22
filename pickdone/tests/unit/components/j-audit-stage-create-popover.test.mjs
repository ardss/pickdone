/* J-audit 2026-10-22 (config-surface journey audit) — first-journey stage A must guide, not ambush.
 * P3 live-verified via the settings replay button: stageCreate is reached only AFTER the seed task
 * has rendered, so the old `if (document.querySelector('.td-item'))` shortcut matched the SEED and
 * the "create your own task" popover never fired. The user saw a silent sample task appear and,
 * when the 30s poll cap expired, silently vanish (finishAll soft-deletes the unadopted seed) —
 * the journey's first stage had no visible UI at all. Fix: popover always arms, growth baseline
 * excludes the seed row, and the capped poll re-arms while a driver popover is on screen (the
 * user is mid-tour, not stuck) instead of tearing the journey down under a visible card.
 * Run: node --test tests/unit/components/j-audit-stage-create-popover.test.mjs */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

const src = read('renderer/js/utils/onboardingTours.js')
const stageCreate = src.match(/const stageCreate = \(\) => \{[\s\S]*?\n {2}\}/)
assert.ok(stageCreate, 'stageCreate found')

test('stage-A instruction popover arms unconditionally (no seed-mistaking early return)', () => {
  assert.ok(!/if \(document\.querySelector\('\.td-item'\)\) \{ armGrowth\(\); return \}/.test(stageCreate[0]),
    'the early-return shortcut that skipped the popover is gone')
  assert.match(stageCreate[0], /singleStep\(\{ element: '\.qa-input'/, 'popover targets the quick-add input')
  assert.match(stageCreate[0], /jCreateTitle/, 'popover uses the create-stage copy')
  assert.match(stageCreate[0], /\r?\n\s*armGrowth\(\)\r?\n/, 'growth watch is armed on every entry')
})

test('growth baseline excludes the seed row (seed never counts as the user\'s own task)', () => {
  assert.match(stageCreate[0], /const seedText = J_SEED_TEXT\(\)/)
  assert.match(stageCreate[0], /userItemCount = \(\) => \[\.\.\.document\.querySelectorAll\('\.td-item'\)\]\.filter\(el => !\(el\.textContent \|\| ''\)\.includes\(seedText\)\)\.length/)
  assert.match(stageCreate[0], /userItemCount\(\) > baseCount/, 'advance = user-created rows grew')
})

test('capped stage-A poll re-arms while a driver popover is open; safe exit otherwise', () => {
  assert.match(src, /const pollCappedTour = \(test, cb, rearm\) => poll\(test, cb, 300, JOURNEY_POLL_CAP_MS, \(\) => \{/)
  const body = src.match(/const pollCappedTour = \(test, cb, rearm\) => poll\(test, cb, 300, JOURNEY_POLL_CAP_MS, \(\) => \{[\s\S]*?\n {2}\}\)/)
  assert.ok(body, 'pollCappedTour body found')
  assert.match(body[0], /document\.querySelector\('\.driver-popover'\)/, 'popover visibility gates the timeout')
  assert.match(body[0], /rearm\(\)/, 'open popover = user mid-tour: re-arm the watch')
  assert.match(body[0], /finishAll\(\)/, 'no popover = the safe exit still applies')
  assert.match(stageCreate[0], /pollCappedTour\(\(\) => userItemCount\(\) > baseCount, \(\) => \{ clearWatch\(\); stagePick\(\) \}, armGrowth\)/)
})

test('seeded path must not early-return above the stage-closure declarations (TDZ regression pin)', () => {
  // J-audit round 2 root cause: the seeded `if (!td-item)` block early-returned ABOVE
  // let ending/const singleStep/const finishAll/const stageCreate — its async relay then ran
  // stageCreate() with those consts in TDZ and threw a swallowed ReferenceError inside the poll
  // interval: silent journey death (no popover/advance/cleanup) on every code version.
  const idxSeeded = src.indexOf("if (!document.querySelector('.td-item')) {")
  const idxEnding = src.indexOf('let ending = false')
  const idxSingleStep = src.indexOf('const singleStep =')
  const idxFinishAll = src.indexOf('const finishAll =')
  const idxStageCreate = src.indexOf('const stageCreate =')
  assert.ok(idxSeeded > -1 && idxEnding > -1 && idxSingleStep > -1 && idxFinishAll > -1 && idxStageCreate > -1, 'all landmarks found')
  assert.ok(idxEnding < idxSeeded, 'let ending declared before the seeded block')
  assert.ok(idxSingleStep < idxSeeded, 'singleStep declared before the seeded block')
  assert.ok(idxFinishAll < idxSeeded, 'finishAll declared before the seeded block')
  assert.ok(idxStageCreate < idxSeeded, 'stageCreate declared before the seeded block')
})

test('stage A arms the growth watch AFTER the popover (singleStep clearWatch must not kill it)', () => {
  const body = stageCreate[0]
  assert.ok(body.indexOf('singleStep({ element:') < body.indexOf('armGrowth()'),
    'popover must be created before armGrowth() so its clearWatch cannot kill the growth watch')
})

test('singleStep passes prevBtnText (zh tour must not fall back to driver.js English default)', () => {
  const singleStep = src.match(/const singleStep = \(step, onDone[\s\S]*?\n {2}\}/)
  assert.ok(singleStep, 'singleStep found')
  assert.match(singleStep[0], /prevBtnText: tt\(T\('prev'\)\)/)
})

test('every journey watch stays capped (no bare poll watches; cleanup anchor intact)', () => {
  assert.ok(!/watch = poll\(/.test(src), 'no uncapped journey watch polls remain (d7 anchor)')
  assert.match(src, /const pollCapped = \(test, cb\) => poll\(test, cb, 300, JOURNEY_POLL_CAP_MS, \(\) => finishAll\(\)\)/, 'pollCapped unchanged (d7 anchor)')
  const finishAll = src.match(/const finishAll = \(\) => \{[\s\S]*?\n[ \t]{2}\}/)
  assert.ok(finishAll && /cleanupJourneySeed\(\)/.test(finishAll[0]), 'finishAll still funnels the seed cleanup (c-wave anchor)')
})
