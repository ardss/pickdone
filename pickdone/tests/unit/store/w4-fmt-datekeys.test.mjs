/** W4 convergence guard: non-view renderer files must build date keys / time strings via the FMT
 *  members (utils/core.js) instead of inline dayjs format literals. View files (.vue) are
 *  intentionally out of scope here — their literal formats are a display convention owned elsewhere.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import '../../setup.mjs'
import { FMT } from '../../../renderer/js/utils/core.js'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

test('FMT carries the dateKey and time members used by non-view files', () => {
  assert.equal(FMT.date, 'YYYY-MM-DD')
  assert.equal(FMT.time, 'HH:mm')
})

test('non-view migrated files contain no inline dateKey/time format literals', () => {
  for (const file of ['renderer/js/store/planChips.js', 'renderer/js/demo-data.js']) {
    const src = read(file)
    assert.ok(!src.includes("format('YYYY-MM-DD')"), `${file}: inline 'YYYY-MM-DD' must use FMT.date`)
    assert.ok(!src.includes("format('HH:mm')"), `${file}: inline 'HH:mm' must use FMT.time`)
  }
})

test('the migrated helpers still produce identical output through FMT', async () => {
  const { fmtChipDay } = await import(pathToFileURL(path.join(ROOT, 'renderer/js/store/planChips.js')).href)
  assert.equal(fmtChipDay(new Date('2026-09-12T08:30:00').getTime()), '2026-09-12')
})
