/**
 * [fix 2026-10-09] Renderer fixes 3-5, pinned by source extraction (same style as
 * tests/unit/renderer/maint-d26-role-space-contract.test.mjs — these components have no
 * jsdom harness, so the real source is extracted and executed/inspected):
 *
 * 3. ViewMoreMenu Space activation orphan: its items use role="menuitemradio"/"menuitemcheckbox",
 *    which were NOT in main.js's document capture-handler allowlist, and the D27 Enter-only
 *    helper change left Space dead on them. The allowlist was extended to both roles (they carry
 *    aria-checked state semantics, so the roles themselves were kept). Contract test: every
 *    role= attribute in ViewMoreMenu.vue must be covered by the main.js allowlist, and a Space
 *    press on a menuitemradio target must activate exactly once (capture handler clicks; the
 *    in-file helper is Enter-only and must not re-activate).
 * 4. WeatherWidget.pruneShapeCache now sweeps expired geoShapeMiss-<name> negative-cache
 *    entries (previously read for TTL but never removed -> permanent localStorage leak).
 * 5. DayRail prune comment no longer claims "never delete future" — buckets past +366d ARE
 *    pruned; the window is a ~1-year pragmatic cap.
 *
 * Run: node --test tests/unit/renderer/fixer-role-allowlist-widget-prune.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

import { roleButtonActivate } from '../../../renderer/js/utils/roleButtonKey.js'

/** Extract the document-level capture handler callback source out of main.js and evaluate it */
function loadCaptureHandler () {
  const src = read('renderer/js/main.js')
  const m = src.match(/document\.addEventListener\('keydown', (\([\s\S]*?\}), true\)/)
  assert.ok(m, 'main.js: document keydown capture handler not found')
  return new Function(`return ${m[1]}`)()
}

function fakeEvent (target) {
  return {
    key: ' ', ctrlKey: false, altKey: false, metaKey: false, repeat: false,
    target, prevented: false,
    preventDefault () { this.prevented = true },
    stopPropagation () {}
  }
}

function fakeTarget (role) {
  return {
    tagName: 'DIV', isContentEditable: false,
    clicks: 0,
    getAttribute (attr) { return attr === 'role' ? role : null },
    click () { this.clicks++ }
  }
}

// ---------- Fix 3: every ViewMoreMenu role is covered by the capture-handler allowlist ----------

test('fix3: every role= in ViewMoreMenu.vue is covered by the main.js Space allowlist', () => {
  const mainSrc = read('renderer/js/main.js')
  const m = mainSrc.match(/const role = t\.getAttribute\('role'\)\s*\n\s*([\s\S]*?)\{\s*\n/)
  assert.ok(m, 'allowlist condition not found in main.js')
  const cond = m[1]
  // Extract every quoted role token from the allowlist condition
  const allowlisted = [...cond.matchAll(/'([a-z]+)'/g)].map(x => x[1])
  assert.ok(allowlisted.length >= 8, `allowlist looks complete: ${allowlisted.join(',')}`)

  const menuSrc = read('renderer/js/components/ViewMoreMenu.vue')
  const roles = [...menuSrc.matchAll(/role="([a-z]+)"/g)].map(x => x[1])
  assert.ok(roles.includes('menuitemradio'), 'ViewMoreMenu still uses menuitemradio (kept for aria-checked semantics)')
  assert.ok(roles.includes('menuitemcheckbox'), 'ViewMoreMenu still uses menuitemcheckbox')
  // Container/landmark roles never carry tabindex and are never Space-activation targets.
  const containerRoles = new Set(['menu', 'group'])
  for (const r of roles.filter(r => !containerRoles.has(r))) {
    assert.ok(allowlisted.includes(r), `role="${r}" in ViewMoreMenu is not covered by the main.js allowlist`)
  }
})

test('fix3: Space on a role=menuitemradio activates EXACTLY ONCE (capture handler + Enter-only helper)', () => {
  const capture = loadCaptureHandler()
  const t = fakeTarget('menuitemradio')
  const e = fakeEvent(t)
  capture(e)
  assert.equal(t.clicks, 1, 'capture handler activates menuitemradio via click()')
  assert.equal(e.prevented, true, 'page scroll suppressed')
  // The in-file keydown binding (roleButtonActivate) must NOT re-activate on the same Space
  let helperCalls = 0
  const elHandler = roleButtonActivate(function () { helperCalls++ })
  elHandler.call({}, e)
  assert.equal(helperCalls, 0, 'helper is Enter-only — no double activation')

  const t2 = fakeTarget('menuitemcheckbox')
  const e2 = fakeEvent(t2)
  capture(e2)
  assert.equal(t2.clicks, 1, 'capture handler activates menuitemcheckbox via click()')
})

test('fix3: stale "Space joins Enter" comment is gone from ViewMoreMenu', () => {
  const menuSrc = read('renderer/js/components/ViewMoreMenu.vue')
  assert.doesNotMatch(menuSrc, /Space joins Enter/, 'D17 comment no longer claims Space joins Enter in-file')
  assert.match(menuSrc, /capture handler/, 'comment points at the capture-handler ownership contract')
})

// ---------- Fix 4: pruneShapeCache sweeps expired geoShapeMiss- keys ----------

test('fix4: WeatherWidget.pruneShapeCache enumerates and removes expired geoShapeMiss- keys', () => {
  const src = read('renderer/js/components/WeatherWidget.vue')
  const m = src.match(/function pruneShapeCache \(\) \{([\s\S]*?)\n\}/)
  assert.ok(m, 'pruneShapeCache not found')
  const body = m[1]
  assert.match(body, /geoShapeMiss-/, 'pruneShapeCache must sweep the miss cache, not only geoShape-v2-')
  assert.match(body, /SHAPE_MISS_TTL_MS/, 'miss sweep uses the same TTL as the read path')
  assert.match(body, /removeItem/, 'expired miss entries are removed')
  // Backward iteration (safe while removing from a live list)
  assert.match(body, /length - 1/, 'sweep iterates backward (index-stable under removal)')
})

test('fix4: executed pruneShapeCache removes expired misses and keeps fresh ones', () => {
  const src = read('renderer/js/components/WeatherWidget.vue')
  // Pull out pruneShapeCache + its pure dependency and run them against a fake localStorage
  const pure = src.match(/\/\/ \[d12-fixes\] pure-start([\s\S]*?)\/\/ \[d12-fixes\] pure-end/)[1]
  const fn = src.match(/(function pruneShapeCache \(\) \{[\s\S]*?\n\})/)[1]
  const TTL = 60 * 60 * 1000
  const store = new Map([
    ['geoShapeMiss-stale', String(Date.now() - TTL - 5000)],
    ['geoShapeMiss-fresh', String(Date.now() - 1000)],
    ['geoShape-v2-Beijing', JSON.stringify({ at: Date.now(), shape: { d: 'M', vb: 'x' } })]
  ])
  const localStorage = {
    get length () { return store.size },
    key: i => [...store.keys()][i],
    getItem: k => store.has(k) ? store.get(k) : null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k)
  }
  const SHAPE_MISS_TTL_MS = TTL
  // planShapeCacheEviction's default param (max = SHAPE_CACHE_MAX) resolves in the closure where
  // the function was CREATED (the pure-block extraction Function below), so SHAPE_CACHE_MAX must
  // be injected THERE — otherwise the try/catch inside pruneShapeCache swallows the ReferenceError.
  const planShapeCacheEviction = new Function('SHAPE_CACHE_MAX', `${pure}; return planShapeCacheEviction`)(40)
  new Function('localStorage', 'planShapeCacheEviction', 'SHAPE_MISS_TTL_MS', `${fn}; pruneShapeCache()`)(localStorage, planShapeCacheEviction, SHAPE_MISS_TTL_MS)
  assert.ok(!store.has('geoShapeMiss-stale'), 'expired miss entry pruned')
  assert.ok(store.has('geoShapeMiss-fresh'), 'fresh miss entry kept')
  assert.ok(store.has('geoShape-v2-Beijing'), 'shape cache untouched by the miss sweep')
})

// ---------- Fix 5: DayRail prune comment states the real contract ----------

test('fix5: DayRail prune comment no longer overstates "never delete future"', () => {
  const src = read('renderer/js/components/DayRail.vue')
  assert.doesNotMatch(src, /only prune expired, never delete future/, 'the false "never delete future" claim is gone')
  assert.match(src, /prune EVERYTHING outside the window/, 'comment states the real keep-window semantics')
  assert.match(src, /\+366d ARE deleted/, 'comment admits buckets past +366d are pruned')
  assert.match(src, /~1-year pragmatic cap/, 'comment names the cap rationale')
  // Comment-only change: the prune() body itself is untouched
  const m = src.match(/prune \(\) \{([\s\S]*?)\n {4}\}/)
  assert.match(m[1], /dayPlans\.pruneDays\(\[\.\.\.keep\]\)/, 'prune body unchanged')
  assert.match(m[1], /for \(let i = -366; i <= 7; i\+\+\)/, 'keep window unchanged')
})
