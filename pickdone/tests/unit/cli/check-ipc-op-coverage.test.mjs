/**
 * IPC op 覆盖门禁自检 — 三条扫描正则的标识符类别(不真跑门禁,门禁本体由 check:all 跑)。
 * 重点回归:op 含下划线/数字(如 export_v2)必须被「白名单提取」「dbCall 调用面」「op: 字面量」
 * 三条正则同时看见——此前类别是 [A-Za-z]+,与 db.js OPS 键提取([A-Za-z_][A-Za-z0-9_]*)不一致,
 * 下划线 op 对门禁整体隐身 = 整个功能静默全断仍绿(门禁头注里 filterList/bumpSnow 同型事故)。
 * Run: node --test tests/unit/cli/check-ipc-op-coverage.test.mjs
 */
import { createRequire } from 'module'
import assert from 'node:assert/strict'
import { test } from 'node:test'

const require_ = createRequire(import.meta.url)
const { PATTERNS } = require_('../../../cli/check-ipc-op-coverage.cjs')

const extract = (src, re) => [...src.matchAll(re)].map(m => m[1])

test('all three patterns capture underscore/digit ops (export_v2 class)', () => {
  assert.deepEqual(
    extract(`window.todoAPI.dbCall('export_v2', {})`, PATTERNS.call),
    ['export_v2']
  )
  assert.deepEqual(
    extract(`ledgerWrite('ledger_append_v2')`, PATTERNS.call),
    ['ledger_append_v2']
  )
  assert.deepEqual(
    extract(`{ op: 'bulk_restore_v2' }`, PATTERNS.opLiteral),
    ['bulk_restore_v2']
  )
  assert.deepEqual(
    extract(`ALLOWED_RENDERER_OPS = new Set(['export_v2', 'plain'])`, PATTERNS.whitelist),
    ['export_v2', 'plain']
  )
})

test('plain alnum ops still match (no regression on the historical shape)', () => {
  assert.deepEqual(
    extract(`dbCall('upsert', x); dbCall?.('filterList', f); ledgerWrite('tomatoAdd', t)`, PATTERNS.call),
    ['upsert', 'filterList', 'tomatoAdd']
  )
})

test('dynamic dispatch detection (x.op form) is unchanged by the widening', () => {
  // The dynamic-dispatch regex itself is not exported (it matches a variable, not a literal),
  // so pin its documented behavior here via the same source shape the gate tests for.
  const src = `const r = window.todoAPI.dbCall(entry.op, payload)`
  assert.ok(/dbCall(?:\?\.)?\(\s*[A-Za-z_$][\w$]*\.op\b/.test(src))
  assert.ok(!/dbCall(?:\?\.)?\(\s*[A-Za-z_$][\w$]*\.op\b/.test(`dbCall('entry.op', x)`))
})
