/**
 * Renderer <-> CLI date-parsing parity pinning tests - the two sides' parseMilestoneDate / milestone progress used to be
 * same-named dual implementations kept in sync only by comments (drift meant "CLI and UI disagree on overdue"). This test pins: same input must give same output.
 * If the logic later moves into a shared layer, this test remains as a behavioral regression.
 */
import '../../setup.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { parseMilestoneDate: cliParse, msProgress: cliProgress } = require('../../../cli/lib.js')
const { parseMilestoneDate: uiParse, milestoneProgress: uiProgress } = await import('../../../renderer/js/utils/milestones.js')
const { dayjs } = await import('../../../renderer/js/utils/core.js')

// bare 'M-D' back in full parity: both sides now route M-D before dayjs() so V8's fallback
// Date parse (which turned '03-15' into 2001-03-15) can never win.
const CASES = ['today', '明天', '+3d', '+2w', '2026-12-31', '1999-01-01', '', 'garbage', '2026-02-30', '03-15', '9-22']
test('parseMilestoneDate: the renderer and the CLI agree on the same inputs', () => {
  for (const c of CASES) {
    const a = cliParse(c)
    const b = uiParse(c)
    assert.equal(Number(a) || 0, Number(b) || 0, `input ${JSON.stringify(c)}: CLI=${a} UI=${b}`)
  }
})

test('parseMilestoneDate: bare M-D resolves to the current year on the renderer (no V8 2001 fallback)', () => {
  const expected = +dayjs(`${dayjs().year()}-03-15`).startOf('day')
  assert.equal(uiParse('03-15'), expected, '03-15 lands on this year Mar 15')
})

test('milestone progress: both sides agree on the same inputs (unlinked/linked/mixed completion states)', () => {
  const tasks = [
    { taskId: 'a', complete: true },
    { taskId: 'b', complete: false },
    { taskId: 'x', complete: true } // not on the milestone; should be filtered
  ]
  const cases = [
    { id: 'm1', taskIds: [] },
    { id: 'm2', taskIds: ['a', 'b'] },
    { id: 'm3', taskIds: ['a', 'x'] }
  ]
  for (const m of cases) {
    assert.deepEqual(cliProgress(m, tasks), uiProgress(m, tasks), JSON.stringify(m))
  }
})
