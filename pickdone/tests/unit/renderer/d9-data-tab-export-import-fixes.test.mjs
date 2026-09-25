/**
 * Domain-3 renderer fixes in SettingsDataTab (2026-09-25):
 *   B1  importFromCsv checks importCsvRun's structured {ok:false} BEFORE the success toast.
 *   B2  exportXlsxTip no longer promises the impossible "migrate back via CSV import" round-trip.
 *   B7  xlsx export column 11 carries the repeat rule BODY (serialized repeatSettingsV2 from meta
 *       'repeatRule:<rid>'), not just the bare repeatId — pure fill logic unit-tested from
 *       renderer/js/utils/exportRepeatRules.js, data channel proven against a real temp DB,
 *       17-column sheet shape re-asserted.
 *   B8  purgeSeed writes the 'purge-seed' event snapshot BEFORE purging (same channel/contract as
 *       import :172 / restore :339 / restore :436).
 * Run: node --test tests/unit/renderer/d9-data-tab-export-import-fixes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'module'
import { repeatRuleMetaKeys, ruleMapFromMetaRows, repeatRuleCell } from '../../../renderer/js/utils/exportRepeatRules.js'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')
const vue = read('renderer/js/components/settings/SettingsDataTab.vue')

/* ---------------- B1: failed import:run must not toast success ---------------- */

test('B1: importFromCsv checks done.ok===false and shows error INSTEAD of the success toast', () => {
  const body = vue.slice(vue.indexOf('async importFromCsv'), vue.indexOf('async pickBackupDir'))
  const runIdx = body.indexOf('importCsvRun(')
  const failIdx = body.indexOf('done.ok === false')
  const successIdx = body.indexOf("$message.success(this.$t('statsH.SettingsModal.importDone'")
  assert.ok(runIdx > 0 && failIdx > runIdx && successIdx > failIdx,
    'order must be: await importCsvRun -> ok===false error branch -> success toast')
  const errBranch = body.slice(failIdx, successIdx)
  assert.match(errBranch, /importFailedMsg/, 'structured failure surfaces the error message')
  assert.ok(!/\$message\.success/.test(errBranch), 'the failure path must never reach a success toast')
  // the new structured codes the branch must surface with context (regression: done carried code but UI said success)
  assert.match(vue, /done\.message \|\| done\.code/)
})

/* ---------------- B2: honest export tip (no impossible round-trip promise) ---------------- */

test('B2: exportXlsxTip no longer points at a CSV data round-trip (zh + en), comment synced', () => {
  const zh = read('renderer/js/i18n/locales/zh-CN-E.js')
  const en = read('renderer/js/i18n/locales/en-US-E.js')
  const zhTip = zh.match(/"exportXlsxTip": "([^"]*)"/)[1]
  const enTip = en.match(/"exportXlsxTip": "([^"]*)"/)[1]
  assert.ok(!zhTip.includes('数据回迁'), 'zh tip must not promise data round-trip: ' + zhTip)
  assert.ok(!/migrate data back/i.test(enTip), 'en tip must not promise data round-trip: ' + enTip)
  // still honest about what the export IS for
  assert.ok(zhTip.includes('仅供查看') && /viewing/i.test(enTip))
  // the in-component comment explains WHY (capability gap is a tracked legacy item, not a copy bug)
  assert.match(vue, /tracked as a legacy item/)
})

/* ---------------- B7: column 11 carries the repeat rule body, sheet stays 17 columns ---------------- */

test('B7 pure fill: rule JSON wins, orphan repeatId falls back, no repeatId stays empty', () => {
  const rule = JSON.stringify({ repeatType: 'week', repeatInterval: 2, weekDays: [1, 3] })
  const t = { repeatId: 'rid9' }
  assert.equal(repeatRuleCell(t, { rid9: rule }), rule, 'column 11 gets the serialized rule body')
  assert.match(repeatRuleCell(t, { rid9: rule }), /repeatInterval/, 'the cell carries the frequency/interval fields')
  assert.equal(repeatRuleCell(t, {}), 'rid9', 'orphaned repeatId (meta cleaned) still exports the id')
  assert.equal(repeatRuleCell({ repeatId: null }, {}), '')
  assert.deepEqual(repeatRuleMetaKeys([{ repeatId: 'a' }, { repeatId: 'a' }, { repeatId: 'b' }, {}]),
    ['repeatRule:a', 'repeatRule:b'], 'keys deduped and prefixed for one batched read')
  assert.deepEqual(ruleMapFromMetaRows([{ key: 'repeatRule:a', value: 'R1' }, { key: 'repeatRule:b', value: null }]), { a: 'R1' })
})

test('B7 data channel: getMetaMany on a real temp DB returns the persisted rule the fill consumes; export stays 17 cols', () => {
  // temp DB isolation (f6 pattern) — never the real library
  process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'd9-b7-db-'))
  const require_ = createRequire(import.meta.url)
  const db = require_('../../../src/main/db.js')
  db.init(process.env.TODO_DB_DIR)
  db.call('setMeta', ['repeatRule:ridB7', JSON.stringify({ repeatType: 'day', repeatInterval: 3 })])
  const rows = db.call('getMetaMany', repeatRuleMetaKeys([{ repeatId: 'ridB7' }, { repeatId: 'nope' }]))
  const ruleMap = ruleMapFromMetaRows(rows)
  const cell = repeatRuleCell({ repeatId: 'ridB7' }, ruleMap)
  assert.equal(JSON.parse(cell).repeatInterval, 3, 'column 11 cell parses to the real rule (frequency/interval present)')
  // the sheet shape is untouched: still exactly 17 data columns
  const { EXPECTED_EXPORT_COLS, parseExportColumns } = require_('../../../src/main/export-xlsx.js')
  assert.equal(EXPECTED_EXPORT_COLS, 17)
  const head = parseExportColumns('a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q')
  assert.equal(head.length, 17)
  // and the component actually reads the rules through this channel before building rows
  assert.match(vue, /getMetaMany\(ruleKeys\)/)
  assert.match(vue, /repeatRuleCell\(t, ruleMap\)/)
})

/* ---------------- B8: purge-seed event snapshot before the purge ---------------- */

test('B8: purgeSeed writes the purge-seed event snapshot BEFORE purgeSeedTodos (boolean contract checked)', () => {
  const body = vue.slice(vue.indexOf('async purgeSeed'))
  const snapIdx = body.indexOf("dispatch('todo/writeEventBackup', 'purge-seed')")
  const purgeIdx = body.indexOf('purgeSeedTodos()')
  assert.ok(snapIdx > 0 && purgeIdx > snapIdx, 'snapshot dispatch must precede the purge')
  assert.match(body, /snapshotFailWarnMsg/, 'a failed pre-purge snapshot warns (no rollback point), same as import/restore')
})
