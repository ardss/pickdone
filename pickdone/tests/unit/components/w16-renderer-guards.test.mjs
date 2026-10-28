/**
 * W16 regression (2026-10-28) — EditPanel removeFile disk-delete guard + FilterView reactive
 * smart-list window (source-level assertions on the two SFCs, same precedent as
 * j1-tomato-bar-status-text.test.mjs).
 *
 * Bug 4 (EditPanel): deleteFromDisk's data-safety row lookup only searched todoList. With the
 * remove-attachment undo toast pending, the task could be whole-deleted into the recycle bin;
 * there the lookup missed, the guard passed, and the physical file was deleted anyway — a later
 * bin restore revived a row whose attachment 404'd. Fix: the lookup also searches recycleList.
 *
 * Bug 6 (FilterView): the smart-list window used a bare `Date.now()` inside a computed with no
 * reactive dependency on time, so after a midnight rollover today/week/overdue stayed frozen in
 * the old buckets until an unrelated store mutation re-rendered. Fix: the window derives from
 * todo.todayTimestamp (refreshed by the store's setTodayTs across midnight — the RecycleBinView
 * precedent), which IS tracked by the computed.
 * Run: node --test tests/unit/components/w16-renderer-guards.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { attachmentUrlPresent } from '../../../renderer/js/utils/attachmentRefs.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

test('W16 EditPanel: deleteFromDisk re-checks the row in todoList AND recycleList', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer/js/components/EditPanel.vue'), 'utf8')
  const block = src.match(/const deleteFromDisk = \(\) => \{[\s\S]*?\n {6}\}/)
  assert.ok(block, 'deleteFromDisk block not found')
  assert.ok(/todoList\.concat\(this\.\$store\.state\.todo\.recycleList\)\.find/.test(block[0]),
    'the row lookup must cover recycleList too (task deleted to bin during the undo window)')
  assert.ok(/attachmentUrlPresent\(row, item\.url\)/.test(block[0]),
    'the attachmentUrlPresent guard must stay')
})

test('W16 attachmentRefs: a recycle-bin row still counts as present (fail-safe stays)', () => {
  const row = { image: JSON.stringify([{ url: 'app://f/a.png' }]), files: '[]' }
  assert.equal(attachmentUrlPresent(row, 'app://f/a.png'), true)
  assert.equal(attachmentUrlPresent(null, 'app://f/a.png'), false)
  assert.equal(attachmentUrlPresent({ image: 'not json' }, 'app://f/x.png'), true, 'malformed JSON counts as present')
})

test('W16 FilterView: the smart-list window clock is reactive (todayTimestamp), not a bare Date.now()', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer/js/views/FilterView.vue'), 'utf8')
  const listComputed = src.match(/list \(\) \{[\s\S]*?\n {4}\},/)
  assert.ok(listComputed, 'FilterView list computed not found')
  const body = listComputed[0]
  assert.ok(/todayTimestamp/.test(body), 'the window must derive from the reactive todo.todayTimestamp')
  assert.ok(!/isoWeekEnd\(Date\.now\(\)\)/.test(body) && !/today0\(\)/.test(body),
    'no bare non-reactive clock calls left in the window')
})
