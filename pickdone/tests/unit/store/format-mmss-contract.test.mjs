/** CONTRACT MIRROR for the two formatMMSS twins (regression guard, mirrors tomato-remote-announce.test.mjs):
 *  - pickdone/shared/format-mmss.cjs (main-process single source, CJS) and
 *  - pickdone/renderer/js/utils/tomatoShared.js formatMMSS (renderer ESM copy)
 *  must produce IDENTICAL output on the same inputs. The "keep in sync" comment alone let either
 *  side drift with the gates green — this pins the semantics (floor + clamp-at-0, mm>59 allowed).
 * Run: node --test tests/unit/store/format-mmss-contract.test.mjs */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { formatMMSS as rendererFormatMMSS } from '../../../renderer/js/utils/tomatoShared.js'

const require = createRequire(import.meta.url)
const { formatMMSS: mainFormatMMSS } = require('../../../shared/format-mmss.cjs')

test('contract mirror: renderer formatMMSS matches shared/format-mmss.cjs exactly', () => {
  const fixtures = [
    0,
    75,
    3725, // mm may exceed 59 (taskbar semantics)
    5999,
    60,
    -1, // the finding: old tray copy rendered "-1:-1"
    -0.5,
    0.5, // fractional seconds floored
    1.999,
    'abc',
    NaN,
    undefined,
    null,
    '',
    '90', // numeric string coerces via Number()
    Number.MAX_SAFE_INTEGER,
  ]
  for (const f of fixtures) {
    assert.equal(rendererFormatMMSS(f), mainFormatMMSS(f),
      `formatMMSS twins diverged on ${String(f)}: renderer=${rendererFormatMMSS(f)} main=${mainFormatMMSS(f)}`)
  }
})
