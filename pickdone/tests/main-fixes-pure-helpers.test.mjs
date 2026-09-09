import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const {
  formatLogLines, nextAvailableName, backupNameTs, sortBackupNamesNewestFirst, parseTomatoMetaBlob
} = require('../src/main/fix-util.js')

const NL = String.fromCharCode(10)

/* ---- formatLogLines (log:write array join fix, 2026-09-10 #4) ---- */
test('formatLogLines: joins entries with NL, not commas', () => {
  const out = formatLogLines([
    { ts: '2026-09-10T00:00:00Z', level: 'info', msg: 'a, b, c' },
    { ts: '2026-09-10T00:00:01Z', level: 'error', msg: 'boom', stack: 'Error: boom' + NL + '  at x' }
  ])
  const lines = out.split(NL)
  // entry line intact (commas preserved), then the stack appended after NL with indented lines
  assert.equal(lines[0], '[2026-09-10T00:00:00Z] [info] a, b, c')
  assert.equal(lines[1], '[2026-09-10T00:00:01Z] [error] boom')
  assert.equal(lines[2], '  Error: boom')
  assert.equal(lines[3], '    at x')
  assert.ok(!out.includes(',' + NL)) // no accidental comma joining
})
test('formatLogLines: empty/non-array input yields empty string', () => {
  assert.equal(formatLogLines([]), '')
  assert.equal(formatLogLines(undefined), '')
  assert.equal(formatLogLines('nope'), '')
})

/* ---- nextAvailableName (save-to-download overwrite fix, 2026-09-10 #7) ---- */
test('nextAvailableName: returns target as-is when free', () => {
  assert.equal(nextAvailableName('/dl', 'a.txt', () => false), require('path').join('/dl', 'a.txt'))
})
test('nextAvailableName: appends (1),(2)… before extension on collision', () => {
  const taken = new Set(['/dl/a.txt', '/dl/a (1).txt'])
  const exists = p => taken.has(p.replace(/\\/g, '/'))
  assert.equal(nextAvailableName('/dl', 'a.txt', exists).replace(/\\/g, '/'), '/dl/a (2).txt')
  assert.equal(nextAvailableName('/dl', 'b.txt', exists).replace(/\\/g, '/'), '/dl/b.txt')
  // no extension: suffix before nothing
  const takenC = new Set([require('path').join('/dl', 'c'), require('path').join('/dl', 'c (1)')])
  assert.equal(nextAvailableName('/dl', 'c', p => takenC.has(p)).endsWith('c (2)'), true)
})

/* ---- backupNameTs / sortBackupNamesNewestFirst (dedup mis-order fix, 2026-09-10 #8) ---- */
test('backupNameTs: parses auto-/evt- names, 0 for junk', () => {
  assert.ok(backupNameTs('auto-20260910-130000.json') > 0)
  assert.equal(backupNameTs('auto-20260910-130000.json'), backupNameTs('evt-test-20260910-130000.json')) // same instant
  assert.equal(backupNameTs('garbage.json'), 0)
})
test('sortBackupNamesNewestFirst: timestamp order beats lexical prefix order', () => {
  // Lexically 'auto-2026…' < 'evt-…-2026…', so .sort() mis-ranked same-day evt snapshots.
  const names = ['evt-r-20260910-120000.json', 'auto-20260910-130000.json', 'auto-20260909-010101.json']
  assert.deepEqual(sortBackupNamesNewestFirst(names), [
    'auto-20260910-130000.json',
    'evt-r-20260910-120000.json',
    'auto-20260909-010101.json'
  ])
  // does not mutate input
  assert.equal(names[0], 'evt-r-20260910-120000.json')
})

/* ---- parseTomatoMetaBlob (corrupt blob must not be deleted, 2026-09-10 #5) ---- */
test('parseTomatoMetaBlob: ok:false on corrupt JSON (caller must keep the blob)', () => {
  assert.equal(parseTomatoMetaBlob('{"tomatoRecordList": [truncated').ok, false)
})
test('parseTomatoMetaBlob: filters invalid rows, keeps valid ones', () => {
  const r = parseTomatoMetaBlob(JSON.stringify({ tomatoRecordList: [
    { tomatoId: 't1', endTime: 123 },
    null,
    { tomatoId: 't2' }, // no endTime → filtered
    { endTime: 456 } // no tomatoId → filtered
  ] }))
  assert.equal(r.ok, true)
  assert.deepEqual(r.list, [{ tomatoId: 't1', endTime: 123 }])
  // empty list (legit) still parses ok — caller may then safely delete the blob
  assert.deepEqual(parseTomatoMetaBlob('{}').list, [])
})
