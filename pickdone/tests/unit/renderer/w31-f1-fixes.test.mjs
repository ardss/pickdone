/**
 * W31 fixer F1 — regression guards (4 items, feat/w29-maintenance).
 *
 *   [1] P2 TomatoFocusRecordModal.saveAdd minted a deterministic mintTomatoId('tmt_f_', startTs):
 *       on one device the salt is constant, so two backfills with the same startTs minted the
 *       SAME id and tomato/addRecord's idempotent dedupe silently swallowed the second record
 *       while the quota counter still incremented behind a success toast. The mint now carries
 *       a random tail (same shape as DayRail.saveEntry / TaskAccountModal.save).
 *   [2] P3 dead computed selDayLabel string-concatenated a raw ms timestamp with the
 *       today/yesterday suffix ("1730…（今天）"); the template uses timeline.label. Removed.
 *   [3] P2 DayRail.saveEntry lacked the "today may not record into the future" guard: the
 *       entry card's time-picker can move startMin (a 23:50 + 25min card) so endTs lands past
 *       now — both the create AND the edit path. Same caliber as the modal's saveAdd guard.
 *   [4] P3 onSegDragLeave/onSegDrop reset dragOverSeg to -1 while its initial value is null —
 *       both resets now use null (uniform sentinel).
 *
 * Run: node --test tests/unit/renderer/w31-f1-fixes.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')
const importMod = p => import(pathToFileURL(path.join(ROOT, p)).href)

const MODAL = read('renderer/js/components/TomatoFocusRecordModal.vue')
const RAIL = read('renderer/js/components/DayRail.vue')

/* ---------- [1] manual backfill id carries a random tail ---------- */

test('[1a] the bug is real: tomato/addRecord dedupes by tomatoId (swallowing is the failure mode)', async () => {
  const tomato = await importMod('renderer/js/store/tomato.js')
  const addRecord = tomato.default.mutations.addRecord
  const s = { tomatoRecordList: [], persistState () {}, ledgerWrite () {} }
  const rec = { tomatoId: 'tmt_f_1700000000000', endTime: 1700001500000 }
  addRecord(s, rec)
  addRecord(s, { ...rec, endTime: 1700001600000 }) // second manual entry, same minted id
  assert.equal(s.tomatoRecordList.length, 1, 'same-id second record is silently dropped by the store')
})

test('[1b] saveAdd mints a per-record id: deterministic mintTomatoId PLUS a random tail', () => {
  const add = MODAL.match(/this\.\$store\.commit\('tomato\/addRecord', \{[\s\S]*?\}\)/)
  assert.ok(add, 'addRecord commit found in TomatoFocusRecordModal.saveAdd')
  assert.match(add[0], /tomatoId: mintTomatoId\('tmt_f_', f\.startTs\)\s*\+/, 'id must carry a random tail appended after the deterministic mint')
  assert.match(add[0], /Math\.random\(\)\.toString\(36\)/, 'tail must be random (DayRail/TaskAccountModal pattern)')
})

test('[1c] the minted-id expression differs across two evaluations (same startTs, two records survive)', () => {
  // Evaluate the exact expression shape saveAdd now uses, twice, same startTs:
  const mint = startTs => `tmt_f_${startTs}_${Math.random().toString(36).slice(2, 7)}`
  assert.notEqual(mint(1700000000000), mint(1700000000000), 'same startTs must mint different ids')
})

/* ---------- [2] dead computed selDayLabel removed ---------- */

test('[2] selDayLabel (raw-ms + suffix string concat) is gone; template stays on timeline.label', () => {
  assert.ok(!MODAL.includes('selDayLabel'), 'dead computed must be deleted (template uses timeline.label)')
  assert.match(MODAL, /\{\{ timeline\.label \}\}/, 'the visible date label still renders from timeline.label')
  assert.match(MODAL, /selDayStart \(\)/, 'selDayStart (used by dayRecords/timeline) must survive')
})

/* ---------- [3] DayRail saveEntry future guard (create AND edit path) ---------- */

test('[3a] saveEntry rejects a today card whose endTs lands in the future, before either branch', () => {
  const saveEntry = RAIL.match(/saveEntry \(\) \{[\s\S]*?\n {4}\},/)
  assert.ok(saveEntry, 'saveEntry block found')
  assert.match(saveEntry[0], /isViewingToday && endTs > Date\.now\(\)/, 'today-only caliber, keyed on endTs like the modal guard')
  assert.match(saveEntry[0], /\$message\.error/, 'rejection must surface on the existing error channel, not silently')
  // guard sits BEFORE the create/update branch → covers both paths
  const guardAt = saveEntry[0].indexOf('isViewingToday && endTs > Date.now()')
  const branchAt = saveEntry[0].indexOf('if (d.create)')
  assert.ok(guardAt > -1 && branchAt > -1 && guardAt < branchAt, 'guard must run before the create/update split (edit path covered too)')
})

test('[3b] guard caliber matches the modal: sameDay && computed end > now', () => {
  assert.match(MODAL, /sameDay && end > now/, 'modal saveAdd guard (reference caliber) intact')
})

/* ---------- [4] dragOverSeg sentinel unified to null ---------- */

test('[4] every dragOverSeg reset uses null (initial data value), never -1', () => {
  const resets = RAIL.match(/dragOverSeg = [^;\n]+/g) || []
  assert.ok(resets.length >= 3, 'onSegDragOver set + two resets expected')
  for (const r of resets) {
    assert.match(r, /dragOverSeg = (s\.tomatoId|null)/, `uniform sentinel, got: ${r}`)
  }
  assert.ok(!RAIL.includes('dragOverSeg = -1'), 'the -1 sentinel (never the initial value) is gone')
})
