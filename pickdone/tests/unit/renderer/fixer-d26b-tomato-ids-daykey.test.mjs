/**
 * maint/d26b fixer round (renderer source anchors):
 *  - F2 manual tomato backfill (taskMenu.js) mints its tomatoId from the FULL taskId, matching the
 *    CLI twin (lib-focus.cjs backfillRecord) — the old last-8 tail minted identical ids for two
 *    same-suffix tasks backfilled in the same minute, and tomatoAppendMany's ON CONFLICT silently
 *    overwrote one ledger row;
 *  - F3 DayRail manual card saveEntry derives dateKey from endTime — the DB layer re-derives it
 *    from endTime unconditionally (tomatoAppendMany/tomatoUpdateById), so a 23:50+25min card used
 *    to land on different days in memory vs DB.
 * Source-anchor style mirrors d22-tomato-id-salt / d23-maint-cli-fixes (the renderer entry points
 * need a full Vue host; the id/dateKey shape is the contract under test).
 * Run: node --test tests/unit/renderer/fixer-d26b-tomato-ids-daykey.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

test('[F2] taskMenu backfill tomatoId mixes the FULL taskId (CLI parity, no last-8 tail)', () => {
  const src = read('renderer/js/utils/taskMenu.js')
  assert.match(src, /tomatoId: 'tmt_m_' \+ startTs \+ '_' \+ min2 \+ '_' \+ String\(cur\.taskId \|\| 'free'\)/,
    'the backfill id is minted from the full taskId, same shape as cli/lib-focus.cjs backfillRecord')
  assert.ok(!/String\(cur\.taskId \|\| 'free'\)\.slice\(-8\)/.test(src),
    'red before the fix: the last-8 tail collided same-suffix tasks in the same minute')
})

test('[F3] DayRail saveEntry derives dateKey from endTime', () => {
  const src = read('renderer/js/components/DayRail.vue')
  const saveEntry = src.match(/saveEntry \(\) \{[\s\S]*?\n {4}\},/)
  assert.ok(saveEntry, 'saveEntry block found')
  assert.match(saveEntry[0], /dateKey: dayjs\(endTs\)\.format\(FMT\.date\)/,
    'dateKey derives from endTime like the DB layer (tomatoAppendMany/tomatoUpdateById)')
  assert.ok(!saveEntry[0].includes('dateKey: dayjs(startTs).format(FMT.date)'),
    'red before the fix: a 23:50+25min card landed on a different day in memory vs DB')
})
