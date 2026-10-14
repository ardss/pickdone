/**
 * F4 fix (2026-10-15): coverage-ratchet baseline I/O hardening.
 *  - a corrupted .coverage-baseline.json used to crash the gate with a bare SyntaxError; now
 *    loadBaseline throws a CLEAR human-actionable error (never silently rebuilds — that would
 *    erase the ratchet history) and the main script reports it and exits non-zero;
 *  - writeBaseline used a bare writeFileSync (tear under crash → the next run hits the corrupt
 *    path); it now writes tmp → fsync → rename (D22 convention) and preserves other platforms.
 * Run: node --test tests/unit/cli/f4-coverage-ratchet-durability.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)

function freshModule (baselineFile) {
  process.env.PICKDONE_COV_RATCHET_BASELINE_FILE = baselineFile
  const resolved = require_.resolve('../../../cli/check-coverage-ratchet.cjs')
  delete require_.cache[resolved]
  return require_(resolved)
}

test('F3: loadBaseline on a corrupted baseline throws a CLEAR error, not a bare SyntaxError', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f4-ratchet-'))
  const file = path.join(dir, '.coverage-baseline.json')
  fs.writeFileSync(file, '{"baselines": { "win32@node24": {"lines": 80,')
  const m = freshModule(file)
  try {
    m.loadBaseline()
    assert.fail('must throw on corrupted baseline')
  } catch (e) {
    assert.match(e.message, /corrupted/, 'error must name the corruption')
    assert.match(e.message, new RegExp(file.replace(/\\/g, '\\\\')), 'error must name the file')
    assert.match(e.message, /BY HAND|by hand/, 'error must demand HUMAN intervention (no silent rebuild)')
    assert.ok(!(e instanceof SyntaxError) || /corrupted/.test(e.message), 'never leaks a bare SyntaxError as the whole story')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('F3: loadBaseline on a shape-broken baseline (baselines: "string") throws the same clear error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f4-ratchet-'))
  const file = path.join(dir, '.coverage-baseline.json')
  fs.writeFileSync(file, '{"baselines": "oops"}')
  const m = freshModule(file)
  try {
    assert.throws(() => m.loadBaseline(), e => /unexpected shape/.test(e.message))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('F3: writeBaseline round-trips atomically — other platforms preserved, no .tmp residue, no torn file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f4-ratchet-'))
  const file = path.join(dir, '.coverage-baseline.json')
  fs.writeFileSync(file, JSON.stringify({ baselines: { 'linux@node22': { lines: 86, branches: 81, functions: 77 } } }, null, 2) + '\n')
  const m = freshModule(file)
  try {
    m.writeBaseline({ lines: 90.4, branches: 70.98, functions: 61.2 })
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.deepEqual(doc.baselines['linux@node22'], { lines: 86, branches: 81, functions: 77 }, 'existing platforms must survive the read-modify-write')
    const mine = Object.keys(doc.baselines).find(k => k !== 'linux@node22')
    assert.deepEqual(doc.baselines[mine], { lines: 90, branches: 70, functions: 61 }, 'new platform entry is floored to whole percent')
    const residue = fs.readdirSync(dir).filter(f => f.includes('.tmp-'))
    assert.deepEqual(residue, [], 'atomic write must leave no tmp residue')
    const raw = fs.readFileSync(file, 'utf8')
    assert.ok(raw.endsWith('\n'), 'file stays newline-terminated (diff-friendly)')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('F3: writeBaseline on a corrupt EXISTING baseline refuses to overwrite (history is not silently destroyed)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f4-ratchet-'))
  const file = path.join(dir, '.coverage-baseline.json')
  fs.writeFileSync(file, 'not json at all')
  const m = freshModule(file)
  try {
    assert.throws(() => m.writeBaseline({ lines: 90, branches: 70, functions: 60 }), e => /corrupted|BY HAND|by hand/.test(e.message))
    assert.equal(fs.readFileSync(file, 'utf8'), 'not json at all', 'the corrupt file must not be silently replaced')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// restore for any later importer in this process: the real repo baseline path again
process.env.PICKDONE_COV_RATCHET_BASELINE_FILE = ''
