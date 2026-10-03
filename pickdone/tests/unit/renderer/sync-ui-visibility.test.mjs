/**
 * Sync UI visibility round regression tests (2026-09-20):
 *   F1  inbound LAN-sync rounds refresh saved filters ('filter' kind) and tomato estimates
 *       ('meta' kind, 1s throttle) — utils/externalReload.js + main.js wiring anchors
 *   F2  LAN-sync habits fold channel: habits/applyExternalPatch merges external fields into
 *       state WITHOUT persisting (no echo loop); stale rounds dropped — store/habits.js +
 *       main.js 'external-habits-changed' wiring anchor
 *   F3  EditPanel stale-snapshot guard: contentFingerprint + shouldRefreshRemote pure helpers,
 *       panel wiring + i18n parity (zh/en) — utils/editPanelRemoteSync.js
 *
 * Run: node --test tests/unit/renderer/sync-ui-visibility.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')
const importSrc = p => import(pathToFileURL(path.join(ROOT, p)).href)

/* ---------------- F1: external reload pipeline ---------------- */

test('F1: reloader dispatches todo/category always, filters only for filter rounds or absent kinds', async () => {
  const { createExternalReloader } = await importSrc('renderer/js/utils/externalReload.js')
  const dispatched = []
  const store = { dispatch: (m, p) => { dispatched.push([m, p]); return Promise.resolve() } }
  const reload = createExternalReloader({ store, reloadEstimates: () => Promise.resolve() })

  reload({ kinds: ['todo', 'category'] })
  assert.ok(dispatched.some(([m]) => m === 'todo/init'))
  assert.ok(dispatched.some(([m]) => m === 'category/init'))
  assert.ok(!dispatched.some(([m]) => m === 'filters/load'), 'non-filter round must not reload filters')

  dispatched.length = 0
  reload({ kinds: ['filter'] })
  assert.ok(dispatched.some(([m]) => m === 'filters/load'), 'filter round must reload filters')

  dispatched.length = 0
  reload({}) // absent kinds (old main build / plain CLI external write) → conservative reload
  assert.ok(dispatched.some(([m]) => m === 'filters/load'), 'absent kinds must reload filters')
})

test('F1: kind gating skips the full todo/init on meta-only and filter-only rounds', async () => {
  const { createExternalReloader } = await importSrc('renderer/js/utils/externalReload.js')
  const dispatched = []
  const store = { dispatch: (m, p) => { dispatched.push([m, p]); return Promise.resolve() } }
  let estimateReloads = 0
  const reload = createExternalReloader({ store, reloadEstimates: () => { estimateReloads++; return Promise.resolve() } })
  const counts = m => dispatched.filter(([x]) => x === m).length
  const flush = () => new Promise(r => setTimeout(r, 0))

  // meta-only round: full-table todo/init skipped, estimates still refreshed
  reload({ kinds: ['meta'] }); await flush()
  assert.equal(counts('todo/init'), 0, 'meta-only round must not trigger the full todo/init reload')
  assert.equal(counts('filters/load'), 0, 'meta-only round must not reload filters')
  assert.equal(estimateReloads, 1, 'meta-only round still refreshes tomato estimates')
  assert.equal(counts('category/init'), 0, 'meta-only round must not reload categories')

  // filter-only round: filters reload, full-table reload skipped
  dispatched.length = 0
  reload({ kinds: ['filter'] })
  assert.equal(counts('todo/init'), 0, 'filter-only round must not trigger the full todo/init reload')
  assert.equal(counts('filters/load'), 1, 'filter-only round must reload filters')

  // todo round: full reload still runs
  dispatched.length = 0
  reload({ kinds: ['todo'] })
  assert.equal(counts('todo/init'), 1, 'todo round keeps the full todo/init reload')

  // absent kinds: conservative full reload preserved
  dispatched.length = 0
  reload({})
  assert.equal(counts('todo/init'), 1, 'absent kinds keep the conservative full reload')
  assert.equal(counts('category/init'), 1, 'absent kinds keep the category reload')

  // mixed meta+category round: todo/init skipped, category/init runs
  dispatched.length = 0
  reload({ kinds: ['meta', 'category'] })
  assert.equal(counts('todo/init'), 0, 'meta+category round must skip the full todo/init reload')
  assert.equal(counts('category/init'), 1, 'meta+category round still reloads categories')

  // preserveHistory payload shape unchanged when the full reload does run
  dispatched.length = 0
  reload({ kinds: ['todo'], preserveHistory: true })
  assert.deepEqual(dispatched.find(([m]) => m === 'todo/init'), ['todo/init', { preserveHistory: true }])
})

test('F1: tomato estimate refresh is throttled to 1s across rounds', async () => {
  const { createExternalReloader } = await importSrc('renderer/js/utils/externalReload.js')
  const store = { dispatch: () => Promise.resolve() }
  let estimateReloads = 0
  let clock = 10_000
  const reload = createExternalReloader({
    store,
    reloadEstimates: () => { estimateReloads++; return Promise.resolve() },
    now: () => clock
  })
  const flush = () => new Promise(r => setTimeout(r, 0))
  reload({ kinds: ['meta'] }); await flush()
  reload({ kinds: ['meta'] }); await flush() // within 1s → suppressed
  assert.equal(estimateReloads, 1)
  clock += 1500
  reload({ kinds: ['meta'] })
  await flush()
  assert.equal(estimateReloads, 2, 'after the throttle window the refresh runs again')
})

test('F1: kindsFromChangedEvent parses the op field (comma-joined round kinds)', async () => {
  const { kindsFromChangedEvent } = await importSrc('renderer/js/utils/externalReload.js')
  assert.deepEqual(kindsFromChangedEvent({ reason: 'lan-sync-apply', op: 'todo,filter,meta' }), ['todo', 'filter', 'meta'])
  // D15-B13 (2026-10-03): reason is now the fallback kind source — the setMeta early-return
  // broadcast carries reason='setMeta' WITHOUT an op, and unknown reasons still surface as
  // (conservative) unknown kinds instead of null. Only truly kind-less events resolve to null.
  assert.deepEqual(kindsFromChangedEvent({ reason: 'external-db-write' }), ['external-db-write'], 'no op → reason becomes the kind (unknown = conservative)')
  assert.deepEqual(kindsFromChangedEvent({ reason: 'setMeta' }), ['setMeta'])
  assert.equal(kindsFromChangedEvent({}), null)
  assert.equal(kindsFromChangedEvent(null), null)
})

test('F1: main.js wires the extracted reloader (filters + estimates on inbound rounds)', () => {
  const src = read('renderer/js/main.js')
  assert.match(src, /createExternalReloader\(/, 'main.js must use the extracted reload pipeline')
  assert.match(src, /kindsFromChangedEvent\(evt\)/, 'main.js must parse round kinds from the broadcast')
})

/* ---------------- F2: habits fold channel ---------------- */

function habitsCtx () {
  const calls = { setMeta: 0, lsWrites: 0 }
  globalThis.localStorage.getItem = () => null
  globalThis.localStorage.setItem = (k) => { if (k === 'habitsState') calls.lsWrites++ }
  globalThis.window.todoAPI = { dbCall: async (op) => { if (op === 'setMeta') calls.setMeta++; return 'ok' } }
  const mod = { }
  return { calls, mod }
}

test('F2: applyExternalPatch merges external habit fields into state without persisting', async () => {
  const store = (await importSrc('renderer/js/store/habits.js')).default
  const { calls } = habitsCtx()
  const s = { habits: [], moments: [], savedAt: 100 }
  store.mutations.applyExternalPatch(s, {
    fields: { habits: [{ id: 'a', name: 'Drink water', records: null }], moments: [{ id: 'm1', name: 'Trip', date: '2026-10-01', kind: 'countdown' }] },
    savedAt: 200
  })
  assert.equal(s.habits.length, 1)
  assert.deepEqual(s.habits[0].records, {}, 'records map normalized (missing-records guard)')
  assert.equal(s.moments.length, 1)
  assert.equal(s.savedAt, 200, 'incoming savedAt recorded as applied')
  assert.equal(calls.setMeta, 0, 'no DB persist on inbound apply (echo-loop guard)')
  assert.equal(calls.lsWrites, 0, 'no LS persist on inbound apply (echo-loop guard)')
})

test('F2: unchanged content produces no state churn; stale rounds are dropped', async () => {
  const store = (await importSrc('renderer/js/store/habits.js')).default
  habitsCtx()
  const habits = [{ id: 'a', name: 'Drink water', records: {} }]
  const s = { habits, moments: [], savedAt: 500 }

  // Empty payload → no-op
  store.mutations.applyExternalPatch(s, { fields: {}, savedAt: 600 })
  assert.equal(s.savedAt, 500, 'nothing applicable must not bump savedAt')

  // Stale round (older savedAt) → dropped wholesale
  store.mutations.applyExternalPatch(s, { fields: { habits: [{ id: 'b', name: 'x', records: {} }] }, savedAt: 400 })
  assert.equal(s.habits[0].id, 'a', 'stale peer round must not overwrite newer state')

  // Re-applying the same fields object does not diverge (idempotent merge, still no persist)
  store.mutations.applyExternalPatch(s, { fields: { habits }, savedAt: 600 })
  assert.equal(s.habits, habits, 'same content re-applied is a stable reference assignment, no re-persist path')
})

test("F2: main.js consumes the 'external-habits-changed' channel defensively", () => {
  const src = read('renderer/js/main.js')
  assert.match(src, /onExternalHabitsChanged/, 'main.js must register the S1 habits channel')
  assert.match(src, /habits\/applyExternalPatch/, '...routing into store/habits.js')
})

test('F2: sanitizeSettingsPatch keeps DEFAULT_SETTINGS-only validation (habits ride the separate channel)', async () => {
  const { sanitizeSettingsPatch } = await importSrc('renderer/js/store/settings.js')
  const out = sanitizeSettingsPatch({ developerMode: true, habits: [{ id: 'x' }], moments: [1], savedAt: 9 })
  assert.deepEqual(out, { developerMode: true }, 'habit fields stay out of the settings patch by design')
})

/* ---------------- F3: EditPanel remote-update guard ---------------- */

test('F3: contentFingerprint covers the core editable fields, order-stable and null-tolerant', async () => {
  const { contentFingerprint } = await importSrc('renderer/js/utils/editPanelRemoteSync.js')
  const row = { taskId: 1, title: 'Buy milk', desc: '2L', dateTs: 123, remindTs: 0, priority: 3, important: 1, categoryId: 7, updateTime: 55 }
  assert.equal(contentFingerprint(row), contentFingerprint({ ...row, updateTime: 999 }), 'updateTime is not part of the content fingerprint')
  assert.notEqual(contentFingerprint(row), contentFingerprint({ ...row, title: 'Buy soy milk' }))
  assert.notEqual(contentFingerprint(row), contentFingerprint({ ...row, dateTs: undefined }), 'undefined vs value must differ')
  assert.equal(contentFingerprint(null), '')
  assert.equal(contentFingerprint({ ...row, remindTs: null }), contentFingerprint({ ...row, remindTs: undefined }), 'null/undefined normalize equal')
})

test('F3: shouldRefreshRemote verdicts — none / own-echo / peer change', async () => {
  const { shouldRefreshRemote, contentFingerprint } = await importSrc('renderer/js/utils/editPanelRemoteSync.js')
  const row = { title: 'A', desc: '', dateTs: 1, remindTs: 0, priority: 0, important: 0, categoryId: 0, updateTime: 10 }
  assert.equal(shouldRefreshRemote({ baseFingerprint: '', baseUpdateTime: 0, row: null }), 'none')
  assert.equal(shouldRefreshRemote({ baseFingerprint: contentFingerprint(row), baseUpdateTime: 10, row }), 'none', 'same updateTime → nothing to do')
  assert.equal(shouldRefreshRemote({ baseFingerprint: contentFingerprint(row), baseUpdateTime: 5, row }), 'none', 'updateTime moved but content identical (own-save echo) → none')
  const peer = { ...row, title: 'B', updateTime: 20 }
  assert.equal(shouldRefreshRemote({ baseFingerprint: contentFingerprint(row), baseUpdateTime: 10, row: peer }), 'changed', 'content + updateTime moved → peer edit')
})

test('F3: EditPanel wires the guard (watcher, silent re-hydrate vs notice) and i18n parity holds', () => {
  const panel = read('renderer/js/components/EditPanel.vue')
  assert.match(panel, /checkRemoteUpdate/, 'panel must watch the live store row')
  assert.match(panel, /refreshFromStore/, 'panel must offer a manual refresh (never auto-overwrite user input)')
  assert.match(panel, /remoteStale/, 'panel must track the stale state')
  const zh = read('renderer/js/i18n/locales/zh-CN-J.js')
  const en = read('renderer/js/i18n/locales/en-US-J.js')
  for (const key of ['statsJ.EditPanel.remoteUpdated', 'statsJ.EditPanel.remoteRefresh']) {
    assert.ok(zh.includes(`'${key}'`), `zh locale missing ${key}`)
    assert.ok(en.includes(`'${key}'`), `en locale missing ${key}`)
  }
  assert.match(zh, /内容已在其他设备更新/)
})
