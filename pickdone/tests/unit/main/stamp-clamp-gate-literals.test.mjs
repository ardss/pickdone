/* Stamp-clamp gate literal detector (docs-gate-1 regression):
 *   checkSharedStampClamp's handwritten-literal detector must be VALUE-based, not spelling-
 *   based — an equivalent spelling of the clamp window (600000, 3e5, 1000*60*10, 0x927C0)
 *   must be flagged exactly like the canonical "5|10 * 60 * 1000" shape, while unrelated
 *   numbers, identifiers embedding the digits, and comment/doc text must stay clean.
 * Run: node --test tests/unit/main/stamp-clamp-gate-literals.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const gate = require_('../../../cli/check-command-bus.cjs')

const WINDOWS = new Set([600000, 300000])

test('gate-1: equivalent spellings of the clamp window are all caught', () => {
  const spellings = [
    'const A = 10 * 60 * 1000',
    'const B = 5 * 60 * 1000',
    'const C = 600000',
    'const D = 300000',
    'const E = 6e5',
    'const F = 3e5',
    'const G = 1000 * 60 * 10',
    'const H = 60 * 1000 * 10',
    'const I = 0x927C0'
  ]
  const hits = gate.findClampWindowLiterals(spellings.join('; '), WINDOWS)
  assert.equal(hits.length, spellings.length,
    'every equivalent spelling must flag, got: ' + hits.map(h => h.text).join(' | '))
  assert.ok(hits.some(h => h.text === '600000'), 'bare decimal spelling caught')
  assert.ok(hits.some(h => h.text === '6e5'), 'exponent spelling caught')
  assert.ok(hits.some(h => h.text === '1000 * 60 * 10'), 'reordered product spelling caught')
  assert.ok(hits.some(h => h.text === '0x927C0'), 'hex spelling caught')
})

test('gate-1: unrelated numbers, identifiers and comments are not flagged', () => {
  const clean = gate.findClampWindowLiterals(
    'const t = 30000; const m = 60 * 1000; const clamp600000 = 1; x.slice(0, 1000); ' +
    '// 600000 in a line comment\n/* 5 * 60 * 1000 in a block comment */',
    WINDOWS)
  assert.deepEqual(clean, [], 'no false positives: ' + clean.map(h => h.text).join(' | '))
})

test('gate-1: evalNumericProduct evaluates pure numeric products only', () => {
  assert.equal(gate.evalNumericProduct('600000'), 600000)
  assert.equal(gate.evalNumericProduct('6e5'), 600000)
  assert.equal(gate.evalNumericProduct('1000 * 60 * 10'), 600000)
  assert.equal(gate.evalNumericProduct('0x927C0'), 600000)
  assert.equal(gate.evalNumericProduct('60 * 1000'), 60000)
  assert.equal(gate.evalNumericProduct("require('./x')"), null, 'non-numeric slice is rejected')
  assert.equal(gate.evalNumericProduct('foo * 2'), null)
})

test('gate-1: parseStampClampMs derives the window from stamp-clamp.js however it is spelled', () => {
  assert.equal(gate.parseStampClampMs('const STAMP_CLAMP_MS = 10 * 60 * 1000'), 600000)
  assert.equal(gate.parseStampClampMs('const STAMP_CLAMP_MS = 600000'), 600000)
  assert.equal(gate.parseStampClampMs('const OTHER = 1; const STAMP_CLAMP_MS = 6e5'), 600000)
  assert.equal(gate.parseStampClampMs('const NOPE = 1'), null)
})

test('gate-1: the real gate passes on the current tree (both doors import the shared constant)', () => {
  const messages = []
  const ok = gate.checkSharedStampClamp(m => messages.push(m))
  assert.equal(ok, true, 'gate must pass, messages: ' + messages.join(' | '))
})
