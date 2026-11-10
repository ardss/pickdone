// Red-first unit tests for the VS Code extension pure helpers (S6): reference-shaped
// capture only — diagnostics summarize to counts/sources/lines, never message text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
const { diagnosticsSummary, buildContextTitle, buildDeepLink } = await import('../../../vscode-extension/lib.js')

test('diagnosticsSummary counts severities and names sources without message text', () => {
  const s = diagnosticsSummary([
    { severity: 0, source: 'eslint', range: { start: { line: 9 } }, message: 'SECRET-LEAKING-TEXT should never surface' },
    { severity: 0, source: 'typescript', range: { start: { line: 4 } } },
    { severity: 1, source: 'eslint', range: { start: { line: 20 } } }
  ])
  assert.match(s, /2 error/)
  assert.match(s, /1 warning/)
  assert.match(s, /eslint/)
  assert.match(s, /typescript/)
  assert.match(s, /L5,10,21/)
  assert.ok(!s.includes('SECRET-LEAKING-TEXT'), 'diagnostic message text must never leave the editor')
})

test('diagnosticsSummary of an empty list says no problems', () => {
  assert.match(diagnosticsSummary([]), /no problems/)
  assert.match(diagnosticsSummary(null), /no problems/)
})

test('buildContextTitle is reference-shaped and bounded', () => {
  const t = buildContextTitle({ relPath: 'src\\main\\a.js', sel: { start: 3, end: 7 }, diagSummary: '2 error/1 warning (eslint)', branch: 'feat/x', sha: 'abcdef1234567890' })
  assert.match(t, /^src\/main\/a\.js L3-7 · 2 error\/1 warning \(eslint\) · feat\/x@abcdef123456/)
  assert.ok(t.length <= 500)
  const long = buildContextTitle({ relPath: 'x'.repeat(900) })
  assert.ok(long.length <= 500)
})

test('buildDeepLink uses the renderer hash route with encoding', () => {
  assert.equal(buildDeepLink('http://127.0.0.1:5173/', 'cap-abc'), 'http://127.0.0.1:5173#/todo-list/task/cap-abc')
  assert.equal(buildDeepLink('https://pd.example/app', 'a b/c'), 'https://pd.example/app#/todo-list/task/a%20b%2Fc')
})
