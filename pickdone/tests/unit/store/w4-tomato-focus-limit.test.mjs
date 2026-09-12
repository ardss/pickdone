/** W4 convergence guard: the 600 focus-minute cap in renderer/js/store/tomato.js must come from the
 *  shared limits module (shared/limits.mjs via renderer/js/utils/limits.js), not an inline literal —
 *  the same constant is enforced DB-side (src/main/db.js _recToRow) and CLI-side (cli/lib.js), and an
 *  inline renderer copy would drift when the shared cap changes.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import '../../setup.mjs'
import { FOCUS_MAX_MINUTES, FOCUS_INPUT_MAX_MINUTES } from '../../../shared/limits.mjs'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

test('shared limits export the documented dual-cap constants', () => {
  assert.equal(FOCUS_MAX_MINUTES, 600)
  assert.equal(FOCUS_INPUT_MAX_MINUTES, 720)
})

test('tomato.js clamps through FOCUS_MAX_MINUTES, no inline 600 literal remains', () => {
  const src = read('renderer/js/store/tomato.js')
  assert.match(src, /import\s*\{[^}]*FOCUS_MAX_MINUTES[^}]*\}\s*from\s*'\.\.\/utils\/limits\.js'/)
  assert.ok(!/\bMath\.min\(600\b/.test(src), 'inline Math.min(600, ...) clamp must use FOCUS_MAX_MINUTES')
  assert.ok(src.includes('FOCUS_MAX_MINUTES'), 'the constant must actually be used')
})

test('renderer shim utils/limits.js re-exports the shared constants unchanged', async () => {
  const { pathToFileURL } = await import('node:url')
  const limits = await import(pathToFileURL(path.join(ROOT, 'renderer/js/utils/limits.js')).href)
  assert.equal(limits.FOCUS_MAX_MINUTES, FOCUS_MAX_MINUTES)
  assert.equal(limits.FOCUS_INPUT_MAX_MINUTES, FOCUS_INPUT_MAX_MINUTES)
})
