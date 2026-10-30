/**
 * W20 (P3) — export-xlsx fileName hardening.
 *
 * The renderer-controlled `fileName` IPC arg used to be path.join-ed straight into the save
 * dialog defaultPath, so a crafted value ('..\\..\\evil', 'a/b', 'nul') could steer the default
 * save location outside Downloads. Now sanitizeExportFileName takes the basename, strips
 * Windows-forbidden characters, falls back to a default and forces .xlsx.
 *
 * Run: node --test tests/unit/main/w20-export-xlsx-filename-sanitize.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Module } from 'node:module'

// Neutralize the electron import (same pattern as d22) so the module loads under plain node.
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => '.' }, dialog: {} }
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const require = createRequire(import.meta.url)
const { sanitizeExportFileName } = require('../../../src/main/export-xlsx.js')

test('sanitizeExportFileName: path traversal is reduced to the basename', () => {
  assert.equal(sanitizeExportFileName('..\\..\\evil'), 'evil.xlsx')
  assert.equal(sanitizeExportFileName('../../evil'), 'evil.xlsx')
  assert.equal(sanitizeExportFileName('C:\\Users\\x\\evil.xlsx'), 'evil.xlsx')
  assert.equal(sanitizeExportFileName('/etc/passwd'), 'passwd.xlsx')
})

test('sanitizeExportFileName: Windows-forbidden characters are replaced', () => {
  assert.equal(sanitizeExportFileName('a<b>c:d"e|f?g*h.xlsx'), 'a_b_c_d_e_f_g_h.xlsx')
  assert.equal(sanitizeExportFileName('todo/1:2.xlsx'), '1_2.xlsx')
})

test('sanitizeExportFileName: empty/garbage falls back to default, suffix always .xlsx', () => {
  assert.equal(sanitizeExportFileName(''), 'todos.xlsx')
  assert.equal(sanitizeExportFileName(null), 'todos.xlsx')
  assert.equal(sanitizeExportFileName(undefined), 'todos.xlsx')
  assert.equal(sanitizeExportFileName('   '), 'todos.xlsx')
  assert.equal(sanitizeExportFileName('.'), 'todos.xlsx')
  assert.equal(sanitizeExportFileName('..'), 'todos.xlsx')
  // forced suffix, no double extension, case-insensitive
  assert.equal(sanitizeExportFileName('report'), 'report.xlsx')
  assert.equal(sanitizeExportFileName('report.xlsx'), 'report.xlsx')
  assert.equal(sanitizeExportFileName('report.XLSX'), 'report.xlsx')
})

test('W20 source pin: the exporter defaultPath routes through sanitizeExportFileName', async () => {
  const src = await (await import('node:fs')).promises.readFile(
    new URL('../../../src/main/export-xlsx.js', import.meta.url), 'utf8')
  assert.match(src, /defaultPath:\s*path\.join\(app\.getPath\('downloads'\),\s*sanitizeExportFileName\(fileName\)\)/)
  assert.match(src, /module\.exports.*sanitizeExportFileName/s)
})
