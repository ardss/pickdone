/** W4 convergence guard: store/planChips.js is the unique facade for the four chip ops that also live
 *  in utils/dayPlans.js. Two drift classes pinned here:
 *  1. Identity: the facade's re-exports must be the SAME function objects as dayPlans' exports
 *     (no copy/paste duplicate implementation).
 *  2. Import direction: renderer store files (undo.js / todo.js) must import these names from the
 *     facade (planChips.js), never directly from utils/dayPlans.js. dayPlans.js stays importable by
 *     components (DayRail.vue) for allPlans/pruneDays/importLegacyOnce/clearSnapshot, which are not
 *     duplicated names.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import '../../setup.mjs'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

test('planChips facade re-exports are the same function objects as utils/dayPlans', async () => {
  const facade = await import(pathToFileURL(path.join(ROOT, 'renderer/js/store/planChips.js')).href)
  const dayPlans = await import(pathToFileURL(path.join(ROOT, 'renderer/js/utils/dayPlans.js')).href)
  for (const name of ['moveTaskChips', 'clearTaskChips', 'snapshotForDelete', 'restoreSnapshot']) {
    assert.equal(typeof facade[name], 'function', `facade exports ${name}`)
    assert.equal(facade[name], dayPlans[name], `facade.${name} must be dayPlans' implementation (single source, no duplicate)`)
  }
})

test('undo.js and todo.js import the chip ops from the planChips facade, not dayPlans directly', () => {
  const OP_NAMES = ['moveTaskChips', 'clearTaskChips', 'snapshotForDelete', 'restoreSnapshot']
  for (const file of ['renderer/js/store/undo.js', 'renderer/js/store/todo.js']) {
    const src = read(file)
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
      const names = m[1].split(',').map(s => s.trim()).filter(Boolean)
      const from = m[2]
      const hits = names.filter(n => OP_NAMES.includes(n))
      if (!hits.length) continue
      assert.ok(
        from.endsWith('planChips.js'),
        `${file} imports chip ops [${hits.join(', ')}] from '${from}' — must come from the planChips facade`
      )
    }
  }
  // The facade itself is the only store-layer module allowed to import the duplicated names from dayPlans
  const facadeSrc = read('renderer/js/store/planChips.js')
  assert.match(facadeSrc, /import\s*\{[^}]*moveTaskChips[^}]*\}\s*from\s*'\.\.\/utils\/dayPlans\.js'/)
})
