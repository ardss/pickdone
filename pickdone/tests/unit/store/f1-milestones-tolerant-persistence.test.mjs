/* F1 (2026-10-21) regression: milestones load/save was a DESTRUCTION path —
 *   - loadMilestones passed NUMERIC-STRING dates through uncoerced (milestoneState's
 *     `ms.date === today0` then mis-stated the entry), and
 *   - saveMilestones silently DROPPED unresolvable siblings, so an edit touching one milestone
 *     permanently destroyed a corrupt (e.g. partially-landed cross-device merge) sibling even
 *     though the user never touched it.
 * Fix: load coerces numeric-string dates to numbers (tolerant parse); save preserves unresolvable
 * entries VERBATIM instead of dropping. The F6 contract (unparseable dates still filtered on
 * load for CLI parity) is unchanged.
 * Run: node --test tests/unit/store/f1-milestones-tolerant-persistence.test.mjs */
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'

const meta = new Map()
const origError = console.error
globalThis.window = { todoAPI: { dbCall: async (op, p) => {
  if (op === 'getMeta') return meta.get(p) ?? null
  if (op === 'setMeta') { meta.set(p[0], p[1]); return }
  return null
} } }

let mod
beforeEach(async () => {
  meta.clear()
  mod = await import('../../../renderer/js/utils/milestones.js')
})
after(() => { console.error = origError })

test('F1: loadMilestones coerces numeric-string dates to numbers (tolerant parse)', async () => {
  meta.set('projectMilestones:p1', JSON.stringify([
    { id: 'a', title: 'string stamp', date: '1730000000000' },
    { id: 'b', title: 'already numeric', date: 1740000000000 },
  ]))
  const list = await mod.loadMilestones('p1')
  assert.equal(list.length, 2)
  assert.equal(list[0].id, 'a')
  assert.equal(typeof list[0].date, 'number', 'numeric-string date coerced in place')
  assert.equal(list[0].date, 1730000000000)
  assert.equal(typeof list[1].date, 'number')
})

test('F1: saveMilestones preserves an unresolvable sibling verbatim — an unrelated edit must not destroy it', () => {
  const saved = mod.saveMilestones('p2', [
    { id: 'good1', title: 'Good', date: 1000 },
    { title: 'half-landed merge entry' }, // corrupt: no date
  ])
  assert.equal(saved.length, 2, 'the corrupt sibling SURVIVES the save')
  assert.equal(saved.find(x => x.id === 'good1').title, 'Good', 'the well-formed entry is normalized as before')
  assert.equal(saved.find(x => x.title === 'half-landed merge entry').title, 'half-landed merge entry', 'corrupt entry written back verbatim')
  const stored = JSON.parse(meta.get('projectMilestones:p2'))
  assert.equal(stored.length, 2, 'and it lands in the persisted blob too')
  // tolerant sort: the corrupt entry (date reads 0) must not poison the comparator with NaN
  assert.ok(stored.every((x, i) => i === 0 || (Number(stored[i - 1].date) || 0) <= (Number(x.date) || 0)))
})

test('F1: unrelated edit does not destroy a corrupt sibling (realistic load→edit→save flow)', async () => {
  meta.set('projectMilestones:p3', JSON.stringify([
    { id: 'keep_me', title: 'corrupt, no date' },
    { id: 'fine', title: 'Fine', date: 500 },
  ]))
  const loaded = await mod.loadMilestones('p3')
  assert.deepEqual(loaded.map(x => x.id), ['fine'], 'load still filters unparseable dates (F6 CLI parity)')
  // the add flow keeps the raw list including the corrupt entry alongside the loaded ones:
  mod.saveMilestones('p3', [...loaded, { id: 'new1', title: 'New', date: 900 }, { id: 'keep_me', title: 'corrupt, no date' }])
  const stored = JSON.parse(meta.get('projectMilestones:p3'))
  assert.ok(stored.some(x => x.id === 'keep_me'), 'the corrupt sibling was NOT silently destroyed by the unrelated save')
  assert.ok(stored.some(x => x.id === 'new1'), 'the new edit landed')
  assert.ok(stored.some(x => x.id === 'fine'), 'the healthy entry landed')
})
