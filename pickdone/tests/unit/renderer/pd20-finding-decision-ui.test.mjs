/* pd20 S1 closure (2026-11-10) — EditPanelWork Finding/Decision UI contract (SFC source
 * doctrine, same harness as editpanel-work.test.mjs — no mount, the source IS the contract).
 * User-visible behavior pinned:
 *   (a) the 'continue work' section carries a findings block AND a decisions block, each with
 *       its own list and record form (data-block anchors the e2e journeys);
 *   (b) the writes go through the ONE renderer mutation door: commit('finding','put' /
 *       'decision','put') and the tombstone removes — no second write path;
 *   (c) the reads go through the read-only whitelisted ops queryFindingsByTask /
 *       queryDecisionsByTask (the db view models, never raw SQL in the renderer);
 *   (d) the handoff copies pass the findings and decisions to buildHandoff (the exported
 *       handoff carries the facts and the choices, not just episode prose);
 *   (e) every new i18n key exists in BOTH language shards (en-US-J and zh-CN-J) — bilingual
 *       parity, no hardcoded UI strings (the section template uses $t for all new labels).
 * Run: node --test tests/unit/renderer/pd20-finding-decision-ui.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = (() => {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i++) {
    try { readFileSync(join(dir, 'package.json')); return dir } catch { dir = join(dir, '..') }
  }
  throw new Error('repo root not found')
})()

const sfc = readFileSync(join(ROOT, 'renderer/js/components/editpanel/EditPanelWork.vue'), 'utf8')
const en = readFileSync(join(ROOT, 'renderer/js/i18n/locales/en-US-J.js'), 'utf8')
const zh = readFileSync(join(ROOT, 'renderer/js/i18n/locales/zh-CN-J.js'), 'utf8')

test('EditPanelWork carries findings + decisions blocks with list and record form anchors', () => {
  assert.match(sfc, /data-block="findings"/, 'the findings block exists')
  assert.match(sfc, /data-block="decisions"/, 'the decisions block exists')
  assert.match(sfc, /data-input="finding-statement"/, 'the finding record form has a statement input')
  assert.match(sfc, /data-input="finding-confidence"/, 'the finding form has a confidence select')
  assert.match(sfc, /data-input="finding-level"/, 'the finding form has a verificationLevel select')
  assert.match(sfc, /data-input="decision-choice"/, 'the decision record form has a choice input')
  assert.match(sfc, /data-input="decision-supersedes"/, 'the decision form exposes the supersedes relation')
  assert.match(sfc, /ep-work-save-finding/, 'a dedicated save-finding button')
  assert.match(sfc, /ep-work-save-decision/, 'a dedicated save-decision button')
})

test('finding/decision writes ride the command bus; reads use the whitelisted view-model ops', () => {
  assert.match(sfc, /commit\('finding', 'put'/, 'finding.put is the write door')
  assert.match(sfc, /commit\('decision', 'put'/, 'decision.put is the write door')
  assert.match(sfc, /commit\('finding', 'removeIds'/, 'finding removal is the tombstone door')
  assert.match(sfc, /commit\('decision', 'removeIds'/, 'decision removal is the tombstone door')
  assert.match(sfc, /dbCall\('queryFindingsByTask'/, 'the findings read is the whitelisted op')
  assert.match(sfc, /dbCall\('queryDecisionsByTask'/, 'the decisions read is the whitelisted op')
  // Red line: no second write path (no direct dbCall to the mutation ops from the renderer).
  assert.doesNotMatch(sfc, /dbCall\('findingPut'/, 'the renderer never bypasses the bus')
  assert.doesNotMatch(sfc, /dbCall\('decisionPut'/, 'the renderer never bypasses the bus')
})

test('the handoff copies carry findings and decisions into buildHandoff', () => {
  const hits = sfc.match(/buildHandoff\(this\.handoffEpisodes\(\)[^)]*\)/g) || []
  assert.ok(hits.length >= 2, 'both copy buttons feed buildHandoff')
  for (const h of hits) {
    assert.match(h, /this\.findings \|\| \[\]/, 'findings ride the handoff: ' + h)
    assert.match(h, /this\.decisions \|\| \[\]/, 'decisions ride the handoff: ' + h)
  }
})

test('every new i18n key exists in BOTH language shards (bilingual parity)', () => {
  const keys = [...sfc.matchAll(/\$t\('(statsJ\.EditPanel\.work(?:Finding|Decision)[^']+)'\)/g)].map(m => m[1])
  assert.ok(keys.length >= 16, 'the new labels are all $t-driven, found ' + keys.length)
  const uniq = [...new Set(keys)]
  for (const k of uniq) {
    assert.ok(en.includes("'" + k + "'"), 'en-US-J carries ' + k)
    assert.ok(zh.includes("'" + k + "'"), 'zh-CN-J carries ' + k)
  }
})
