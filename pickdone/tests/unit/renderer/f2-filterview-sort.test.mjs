/**
 * F2-P3 (2026-10-18): FilterView's list() sorted by taskSort DESCENDING only — no createTime ASC
 * tiebreaker (sortMode.js custom spec: taskSort desc || createTime asc). Import-path ties
 * (sort=0) fell to Array.sort's unstable input order and diverged from the Today page.
 * Run: node --test tests/unit/renderer/f2-filterview-sort.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const src = fs.readFileSync(path.join(ROOT, 'renderer/js/views/FilterView.vue'), 'utf8')

// Extract the actual comparator lambda from the source so the test exercises the shipped code,
// not a re-typed copy. The lambda sits on its own line and ends with `))` (the outer paren
// closes the .sort( call).
const line = src.split('\n').find(l => l.includes('.sort((a, b) =>'))
assert.ok(line, 'list() comparator found in FilterView.vue')
const expr = line.slice(line.indexOf('=>') + 2).trim().replace(/\)$/, '')
const cmp = new Function('a', 'b', 'return ' + expr)

test('comparator carries the createTime ASC tiebreaker (sortMode.js custom caliber)', () => {
  assert.match(src, /\(a\.createTime \|\| 0\) - \(b\.createTime \|\| 0\)/, 'tiebreaker present')
  // ties on taskSort break by createTime ascending
  const a = { taskSort: 0, createTime: 100 }
  const b = { taskSort: 0, createTime: 50 }
  assert.ok(cmp(b, a) < 0, 'earlier-created row sorts first inside a sort tie')
  // taskSort still dominates, descending
  const hi = { taskSort: 5, createTime: 999 }
  const lo = { taskSort: 0, createTime: 1 }
  assert.ok(cmp(hi, lo) < 0, 'higher taskSort still sorts first')
})

test('a full tie lists identically to the Today page custom sort for tied rows', () => {
  const rows = [
    { taskId: 'c', taskSort: 0, createTime: 300 },
    { taskId: 'a', taskSort: 0, createTime: 100 },
    { taskId: 'b', taskSort: 2, createTime: 200 }
  ]
  const out = [...rows].sort(cmp)
  assert.deepEqual(out.map(r => r.taskId), ['b', 'a', 'c'], 'pinned first, then createTime ASC among ties')
})
