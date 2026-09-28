/* maint/d11-r5 renderer regressions:
 * [1] category.js rewriteLegacyProjectIdsWithout: the async IIFE body's rejection used to escape
 *     the sync try/catch as an unhandled rejection — legacy project-id cleanup silently lost.
 *     Fix = .catch on the promise; test asserts no unhandledRejection fires and the failure is
 *     logged (pre-fix code fails both assertions).
 * [2] remainingSecOfState now delegates running states to the single source remainSecOf
 *     (tomatoShared) — rest fallback is ||5, not the drifted ||25; idle fallback matches too.
 *     The dead curried getter `tomato/remainingSec` (zero consumers) is removed.
 * [3] TodayXView was the 6th hand-written countdown copy (and wrong in rest phase). It now calls
 *     remainingSecOfState; a grep guard asserts no .vue hand-writes `tomatoTime * 60` anymore.
 * [4] peer-unauthorized / peer-unpaired / snapshot-sync / server-error each have a renderer
 *     branch in SettingsSyncTab + i18n keys in BOTH locales; every renderer-consumed syncEvent
 *     type stays inside the emit-side Types doc (set-equivalence gate, r3/r4 style).
 * [5] PANEL_FIELD_KEYS dead export removed.
 * Run: node --test tests/unit/renderer/fix-20260928-r5-renderer.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = f => readFileSync(join(ROOT, f), 'utf8')

test('r5[1]: rewriteLegacyProjectIdsWithout catches its async body rejection in-module (no unhandled rejection)', async () => {
  const unhandled = []
  const onUnhandled = e => unhandled.push(e)
  process.on('unhandledRejection', onUnhandled)
  const warns = []
  const origWarn = console.warn
  console.warn = (...a) => { warns.push(a.join(' ')) }
  try {
    globalThis.window.todoAPI = {
      // reject the very first dbCall: pre-fix this rejection escaped as unhandled
      dbCall: async () => { throw new Error('dbCall down') },
    }
    const { rewriteLegacyProjectIdsWithout } = await import('../../../renderer/js/store/category.js?r5-cat')
    rewriteLegacyProjectIdsWithout('cat_r5_1')
    await new Promise(r => setTimeout(r, 50))
    assert.equal(unhandled.length, 0,
      'the IIFE rejection must be caught in-module (pre-fix: sync try/catch never covered the async body → unhandled rejection, legacy project-id cleanup silently lost)')
    assert.ok(warns.some(t => t.includes('[category] legacy project-id rewrite failed') && t.includes('cat_r5_1')),
      'the failure is logged (observable degradation, not a silent drop)')
  } finally {
    console.warn = origWarn
    process.off('unhandledRejection', onUnhandled)
  }
})

test('r5[1b]: the happy path still rewrites PROJECT_IDS_KEY via commitCommand', async () => {
  const puts = []
  globalThis.window.todoAPI = {
    // getMeta → stored array; setMeta (commandBus legacyDbCall fallback, meta.put) → captured
    dbCall: async (op, params) => {
      if (op === 'getMeta') return JSON.stringify(['cat_a', 'cat_r5_2'])
      if (op === 'setMeta') puts.push(params)
      return { accepted: 1 }
    },
  }
  const { rewriteLegacyProjectIdsWithout } = await import('../../../renderer/js/store/category.js?r5-cat2')
  rewriteLegacyProjectIdsWithout('cat_r5_2')
  await new Promise(r => setTimeout(r, 20))
  assert.equal(puts.length, 1, 'one meta put was committed')
  assert.deepEqual(puts[0], ['projectCategoryIds', JSON.stringify(['cat_a'])])
})

test('r5[2]: remainingSecOfState delegates to remainSecOf — rest fallback is 5min (not the drifted 25), running states are equivalent', async () => {
  const { remainingSecOfState } = await import('../../../renderer/js/store/tomato.js?r5-fn')
  // Plain specifier (no cache-busting query): tomatoShared.js is pure (no module state), and the
  // `?r5-shared` query created a second module instance whose V8 coverage entry-shadowed the
  // clean URL's, silently dropping the file below the coverage-ratchet baseline in every run.
  const { remainSecOf } = await import('../../../renderer/js/utils/tomatoShared.js')
  const t0 = 1_700_000_000_000
  // Running: bit-for-bit equivalence with the pre-existing single source
  for (const [s, now] of [
    [{ status: 'startTomatoTime', startedAt: t0, tomatoTime: 25, restTime: 5 }, t0 + 61_000],
    [{ status: 'startRestTime', startedAt: t0, tomatoTime: 25, restTime: 5 }, t0 + 60_000],
    [{ status: 'startRestTime', startedAt: t0, tomatoTime: 25 }, t0 + 30_000], // missing restTime → 5min total, NOT 25
    [{ status: 'startTomatoTime', startedAt: t0, tomatoTime: 25 }, t0 + 26 * 60_000],
  ]) {
    assert.equal(remainingSecOfState(s, now), remainSecOf(s.status, s.startedAt, s.tomatoTime, s.restTime, now),
      JSON.stringify(s.status) + ' running countdown equals remainSecOf')
  }
  assert.equal(remainingSecOfState({ status: 'startRestTime', startedAt: t0, tomatoTime: 25 }, t0 + 1000), 5 * 60 - 1,
    'rest with missing restTime counts down from 5:00 (pre-fix drifted to 25:00)')
  // Idle fallbacks match remainSecOf's defaults
  assert.equal(remainingSecOfState({ status: 'default' }, t0), 25 * 60)
  assert.equal(remainingSecOfState({ status: 'startRestTime' }, t0), 5 * 60,
    'idle rest state previews the 5min rest default (pre-fix: 25min)')
  assert.equal(remainingSecOfState(null, t0), 25 * 60)
  // Dead curried getter (zero consumers repo-wide) is gone
  const src = read('renderer/js/store/tomato.js')
  assert.doesNotMatch(src, /remainingSec \(s\)/, 'the unused `tomato/remainingSec` getter is removed')
})

test('r5[3]: TodayXView consumes remainingSecOfState; grep-equivalence guard — no .vue hand-writes the formula', () => {
  const view = read('renderer/js/views/TodayXView.vue')
  assert.ok(view.includes("from '../store/tomato.js'") && view.includes('remainingSecOfState'),
    'TodayXView imports the single source')
  assert.ok(!view.includes('tomatoTime * 60'), 'TodayXView no longer hand-writes the countdown')
  // Mechanical guard over ALL renderer .vue files: the only surviving `tomatoTime * 60`-style
  // inline countdowns must be none (store keeps *60000 ms conversions — different unit, exempt).
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(join(dir, e.name)) : (e.name.endsWith('.vue') ? [join(dir, e.name)] : []))
  const offenders = []
  for (const dir of ['renderer/js/views', 'renderer/js/components']) {
    for (const f of walk(join(ROOT, dir))) {
      if (/\btomatoTime\s*\*\s*60\b(?!0)/.test(readFileSync(f, 'utf8'))) offenders.push(f)
    }
  }
  assert.deepEqual(offenders, [], 'no .vue component hand-writes a tomatoTime*60 countdown (r5 guard)')
})

test('r5[4]: the four syncEvent types each have a renderer branch, i18n keys, and stay inside the emit-side Types doc', () => {
  const tab = read('renderer/js/components/settings/SettingsSyncTab.vue')
  for (const t of ['peer-unauthorized', 'peer-unpaired', 'snapshot-sync', 'server-error']) {
    assert.ok(tab.includes(`evt.type === '${t}'`), `${t} has a SettingsSyncTab branch`)
  }
  for (const locale of ['renderer/js/i18n/en-US.js', 'renderer/js/i18n/zh-CN.js']) {
    const src = read(locale)
    for (const key of ['peerUnauthorizedNotice', 'peerUnpairedNotice', 'snapshotRows', 'serverErrorNotice']) {
      assert.ok(src.includes(`"${key}"`), `${key} exists in ${locale}`)
    }
  }
  // Set-equivalence gate (r3/r4 style): every syncEvent type the renderer consumes via
  // `evt.type === '...'` (SettingsSyncTab + main.js) must be listed in the emit-side Types doc.
  const boot = read('src/main/lan-sync-bootstrap.js')
  const typesDoc = boot.slice(boot.indexOf('Types:'), boot.indexOf('function emitSyncEvent'))
  const consumed = new Set()
  for (const f of ['renderer/js/components/settings/SettingsSyncTab.vue', 'renderer/js/main.js']) {
    for (const m of read(f).matchAll(/evt\.type === '([a-z-]+)'/g)) consumed.add(m[1])
  }
  assert.ok(consumed.size >= 12, 'sanity: we actually collected the consumer set (got ' + consumed.size + ')')
  for (const t of consumed) {
    assert.ok(typesDoc.includes(t), `renderer-consumed type '${t}' is documented in the emit-side Types list`)
  }
  for (const t of ['peer-unauthorized', 'peer-unpaired', 'snapshot-sync', 'server-error']) {
    assert.ok(typesDoc.includes(t), `emit-side doc still lists '${t}'`)
  }
})

test('r5[5]: PANEL_FIELD_KEYS dead export is gone (no definition, no reference)', () => {
  const src = read('renderer/js/utils/editPanelRemoteSync.js')
  assert.ok(!src.includes('PANEL_FIELD_KEYS'), 'the unused export is removed from its defining module')
})
