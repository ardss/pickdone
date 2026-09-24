/**
 * dw wave5 P2 — statutory holiday table single-sourced into shared/holidays.mjs.
 * The two verbatim mirrors (src/main/core/holidays.js + renderer/js/utils/holidays.js) had to be
 * hand-updated in sync every year; now renderer statically imports the shared module and
 * main/cli require(esm) it (same pattern as shared/limits.mjs).
 * Run: node --test tests/unit/main/dw5-holidays-single-source.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const require_ = createRequire(import.meta.url)

test('single source: main CJS entry consumes shared/holidays.mjs with data intact', () => {
  const viaMain = require_(path.join(ROOT, 'src/main/core/holidays.js'))
  const shared = require_(path.join(ROOT, 'shared/holidays.mjs'))
  assert.deepEqual(viaMain.HOLIDAY_DATA, shared.HOLIDAY_DATA)
  assert.equal(viaMain.HOLIDAY_DATA.length, 65, '2025+2026 entries preserved verbatim')
  const copy = viaMain.getHolidayList()
  copy[0].holiday = !copy[0].holiday
  assert.deepEqual(viaMain.getHolidayList(), shared.HOLIDAY_DATA, 'getHolidayList still returns defensive copies')
})

test('single source: renderer entry re-exports the shared module (no second data copy)', async () => {
  const esm = await import(process.platform === 'win32'
    ? 'file:///' + path.join(ROOT, 'renderer/js/utils/holidays.js').replace(/\\/g, '/')
    : 'file://' + path.join(ROOT, 'renderer/js/utils/holidays.js'))
  const shared = await import(process.platform === 'win32'
    ? 'file:///' + path.join(ROOT, 'shared/holidays.mjs').replace(/\\/g, '/')
    : 'file://' + path.join(ROOT, 'shared/holidays.mjs'))
  assert.equal(esm.HOLIDAY_DATA, shared.HOLIDAY_DATA, 'renderer HOLIDAY_DATA IS the shared array (re-export, not a copy)')
  assert.equal(typeof esm.getHolidayList, 'function')
})

test('single source: neither mirror file carries a HOLIDAY_DATA literal anymore', async () => {
  const forMain = fs.readFileSync(path.join(ROOT, 'src/main/core/holidays.js'), 'utf8')
  const forRenderer = fs.readFileSync(path.join(ROOT, 'renderer/js/utils/holidays.js'), 'utf8')
  assert.match(forMain, /require\('\.\.\/\.\.\/\.\.\/shared\/holidays\.mjs'\)/)
  assert.match(forRenderer, /from '\.\.\/\.\.\/\.\.\/shared\/holidays\.mjs'/)
  assert.ok(!forMain.includes("dateString: '20"), 'main mirror no longer embeds data rows')
  assert.ok(!forRenderer.includes("dateString: '20"), 'renderer mirror no longer embeds data rows')
})
