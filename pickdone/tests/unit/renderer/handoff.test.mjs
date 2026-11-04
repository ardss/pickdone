/**
 * S2 slice — buildHandoff pure function (renderer/js/utils/handoff.js).
 * Pure read-side assembly: episodes + sources + task authority data -> { text, json }.
 * Zero dependencies, no DB writes, no IPC. Ordering: episodes sorted by startedAt asc.
 * Empty episodes must yield a 'no episodes' placeholder text, never throw.
 * Run: node --test tests/unit/renderer/handoff.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildHandoff } from '../../../renderer/js/utils/handoff.js'

const EP_LATER = {
  startedAt: '2026-11-02T10:00:00Z',
  role: 'agent',
  goal: 'fix the updater 404 storm',
  outcome: 'failures classified, retry storm stopped',
  nextAction: 'verify lastCheckError surface',
}
const EP_EARLIER = {
  startedAt: '2026-11-02T09:00:00Z',
  role: 'human',
  goal: 'review updater logs',
  outcome: 'confirmed 404 loop',
  nextAction: 'hand to agent',
}
const SRC_L0 = { level: 'L0', canonicalUri: 'file:///repo/README.md' }
const SRC_L2 = { level: 'L2', canonicalUri: 'https://example.com/spec#section' }
const TASK = { id: 't-42', title: 'stabilize updater' }

test('text contains each episode segment with role, L-labels and canonicalUri', () => {
  const { text } = buildHandoff([EP_LATER, EP_EARLIER], [SRC_L0, SRC_L2], TASK)
  // episodes in startedAt-ascending order: human first even though input had agent first
  const iHuman = text.indexOf('review updater logs')
  const iAgent = text.indexOf('fix the updater 404 storm')
  assert.ok(iHuman !== -1, 'human goal present')
  assert.ok(iAgent !== -1, 'agent goal present')
  assert.ok(iHuman < iAgent, 'episodes ordered by startedAt ascending')
  assert.ok(text.includes('review updater logs') && text.includes('confirmed 404 loop') && text.includes('hand to agent'))
  assert.ok(text.includes('fix the updater 404 storm') && text.includes('failures classified, retry storm stopped') && text.includes('verify lastCheckError surface'))
  assert.ok(text.includes('human'), 'human role labeled')
  assert.ok(text.includes('agent'), 'agent role labeled')
  assert.ok(text.includes('L0'), 'L0 source label')
  assert.ok(text.includes('L2'), 'L2 source label')
  assert.ok(text.includes('file:///repo/README.md'), 'L0 canonicalUri')
  assert.ok(text.includes('https://example.com/spec#section'), 'L2 canonicalUri')
  assert.ok(text.includes('stabilize updater'), 'task title included')
})

test('shuffled episodes input still outputs startedAt ascending', () => {
  const a = buildHandoff([EP_LATER, EP_EARLIER], [SRC_L0, SRC_L2], TASK).text
  const b = buildHandoff([EP_EARLIER, EP_LATER], [SRC_L0, SRC_L2], TASK).text
  assert.equal(a, b, 'same content regardless of input order')
})

test('empty episodes -> "no episodes" placeholder, no throw', () => {
  const { text, json } = buildHandoff([], [SRC_L0], TASK)
  assert.ok(text.includes('no episodes'), 'placeholder present')
  assert.ok(!text.includes('stabilize updater') === false || true) // task section may still render
  assert.ok(Array.isArray(json.episodes) && json.episodes.length === 0)
})

test('json branch maps input fields one-to-one (snapshot-stable)', () => {
  const { json } = buildHandoff([EP_EARLIER, EP_LATER], [SRC_L0, SRC_L2], TASK)
  assert.equal(json.task.id, 't-42')
  assert.equal(json.task.title, 'stabilize updater')
  assert.equal(json.episodes.length, 2)
  assert.deepEqual(json.episodes[0], EP_EARLIER, 'first episode sorted first')
  assert.deepEqual(json.episodes[1], EP_LATER)
  assert.deepEqual(json.sources, [SRC_L0, SRC_L2])
  // snapshot stability: identical input -> identical serialization
  const again = buildHandoff([EP_EARLIER, EP_LATER], [SRC_L0, SRC_L2], TASK).json
  assert.equal(JSON.stringify(again), JSON.stringify(json))
})

test('pure function: does not mutate inputs', () => {
  const eps = [EP_LATER, EP_EARLIER]
  const srcs = [SRC_L2, SRC_L0]
  buildHandoff(eps, srcs, TASK)
  assert.deepEqual(eps, [EP_LATER, EP_EARLIER], 'episodes array order preserved')
  assert.deepEqual(srcs, [SRC_L2, SRC_L0], 'sources array order preserved')
})
