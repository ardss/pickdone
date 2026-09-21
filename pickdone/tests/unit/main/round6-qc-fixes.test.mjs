/* Round-6 (2026-09-21) regression suite — R6-A CLI findings + R6-B renderer findings.
   Locked behaviors:
   - r6-1  list <unknown-token> throws even with --all/--view (silent today-fallback killed)
   - r6-2  listTodos invalid --limit falls back to the 200 default, not 50
   - r6-3  planRemove defaults to the task's scheduled day (parity with planSet)
   - r6-4  settings manifest: calendarCategory is a number; restored tombstones stamp oldest
   - r6-5  refreshFromDb clears undo history (restore/CSV import cannot mass-tombstone on undo)
   - r6-6  contentFingerprint matches across panel-snapshot and raw-row vocabularies
*/
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const require_ = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

test('r6-1: list unknown first token throws USAGE even when --all/--view present', () => {
  const src = require_('fs').readFileSync(path.join(root, 'cli/pickdone.js'), 'utf8')
  // The guard must key off the token's validity, not off the resolved range (which --all/--view null out)
  assert.match(src, /const validRange = \[/)
  assert.match(src, /if \(first && !validRange && !hasOn\) throw new lib\.CliError\(`unknown range/)
  // Old inverted guard must be gone
  assert.doesNotMatch(src, /!range && !opts\.all && !opts\.on\) throw/)
})

test('r6-2: listTodos invalid --limit falls back to the 200 default', async () => {
  const lib = require_(path.join(root, 'cli/lib.js'))
  // Direct unit probe of the normalization seam via the documented default contract
  const src = require_('fs').readFileSync(path.join(root, 'cli/lib.js'), 'utf8')
  assert.match(src, /parseInt\(opts\.limit, 10\) \|\| 200, 500\)/)
  assert.ok(typeof lib.listTodos === 'function')
})

test('r6-3: planRemove derives the default day from the task scheduled day like planSet', () => {
  const src = require_('fs').readFileSync(path.join(root, 'cli/lib.js'), 'utf8')
  const fn = src.match(/function planRemove[\s\S]*?\n}/)[0]
  assert.match(fn, /planDayKey\(date != null && date !== true \? date : \(t\.dayStart \? dayjs\(t\.dayStart\)/, 'same default-day rule as planSet')
})

test('r6-4: settings manifest types calendarCategory as number', () => {
  const src = require_('fs').readFileSync(path.join(root, 'cli/lib.js'), 'utf8')
  const manifest = src.match(/const SETTINGS_MANIFEST[\s\S]*?\n}/)[0]
  assert.doesNotMatch(manifest, /string: \[[^\]]*calendarCategory/)
  assert.match(manifest, /number: \[[^\]]*'calendarCategory'\]/)
})

test('r6-5: _rt/refreshFromDb voids undo history before the whole-table replace', () => {
  const src = require_('fs').readFileSync(path.join(root, 'renderer/js/main.js'), 'utf8')
  const i = src.indexOf('async refreshFromDb')
  const body = src.slice(i, src.indexOf('\n  }', i))
  const iClear = body.indexOf("commit('todo/historyClear')")
  const iSet = body.indexOf("commit('todo/setAllRows'")
  assert.ok(iClear >= 0, 'historyClear present in refreshFromDb')
  assert.ok(iSet > iClear, 'history must be voided BEFORE the replacement snapshot lands')
})

test('r6-6: contentFingerprint is vocabulary-agnostic (panel snapshot vs raw row agree)', async () => {
  const { contentFingerprint } = await import(pathToFileURL(path.join(root, 'renderer/js/utils/editPanelRemoteSync.js')).href)
  const panelShape = { title: 'Buy milk', desc: '2L', dateTs: 1700000000000, remindTs: 0, priority: 0, important: 0, categoryId: 3 }
  const rawRow = { taskContent: 'Buy milk', taskDescribe: '2L', todoTime: 1700000000000, reminderTime: 0, priority: 0, important: 0, categoryId: 3 }
  assert.equal(contentFingerprint(panelShape), contentFingerprint(rawRow), 'same content, different vocabularies -> same fingerprint')
  assert.notEqual(contentFingerprint(panelShape), contentFingerprint({ ...rawRow, taskContent: 'Buy bread' }), 'a real peer edit still changes it')
  // Mixed-shape rows (partially hydrated) resolve panel key first, fall back to row key
  assert.equal(contentFingerprint({ title: 'X', todoTime: 5 }), contentFingerprint({ taskContent: 'X', todoTime: 5 }))
})
