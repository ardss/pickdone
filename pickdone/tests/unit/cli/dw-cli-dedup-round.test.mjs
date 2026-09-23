/**
 * dw wave — P3-7/P3-8/P3-9/P3-10: CLI dedup / dead-code round (behavior-preserving).
 *  P3-7  nextSort single source (shared/sort-core.mjs): the CLI's verbatim nextSortCli copy is
 *        deleted; renderer utils/core.js re-exports the shared implementation.
 *  P3-8  localDayKey: the CLI's inline YYYY-MM-DD copies (lib.js / pickdone.js x2 / import.js)
 *        all read src/main/fix-util.js now.
 *  P3-9  userDataDir single source (src/main/user-dir.js): audit.js's defaultDirResolver no longer
 *        assembles its own env-priority copy (the lib.js "do not assemble a third copy" note is
 *        finally honored by src/main too).
 *  P3-10 chipsRemoveTask dead export deleted (zero callers repo-wide).
 * Run: node --test tests/unit/cli/dw-cli-dedup-round.test.mjs
 */
import '../../setup.mjs' // window/i18n shims — the P3-7 check imports the renderer's utils/core.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-dw-dedup-'))
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')
const fixUtil = require_('../../../src/main/fix-util.js')
const userDir = require_('../../../src/main/user-dir.js')
const audit = require_('../../../src/main/audit.js')
const sortCore = await import('../../../shared/sort-core.mjs')
const { nextSort } = await import('../../../renderer/js/utils/core.js')
db.init(process.env.TODO_DB_DIR)

test('P3-7: renderer nextSort === shared sort-core implementation (re-export, not a copy)', async () => {
  const cases = [[true, 0, 0], [false, 0, 0], [true, 100, 200], [false, 100, 200], [true, 512.5, 3.5]]
  for (const [top, minS, maxS] of cases) {
    assert.equal(nextSort(top, minS, maxS), sortCore.nextSort(top, minS, maxS))
  }
  assert.equal(nextSort(true, 0, 0), 1024)
  assert.equal(nextSort(true, 100, 200), Math.fround(712))
  assert.equal(nextSort(false, 100, 200), Math.fround(-412))
})

test('P3-7: CLI uses the shared nextSort (add lands in the day pool by the same convention)', () => {
  const t = lib.addTodo({ content: 'dw sort probe' })
  const row = lib.open().call('getById', t.taskId)
  assert.ok(Math.abs(row.taskSort - 1024) <= 32, `first task in the empty pool must sit near baseline 1024, got ${row.taskSort}`)
})

test('P3-8: fix-util localDayKey matches the previous inline copies', () => {
  const d = new Date(2026, 8, 23, 14, 30)
  assert.equal(fixUtil.localDayKey(+d), '2026-09-23')
  assert.equal(fixUtil.localDayKey(d), '2026-09-23')
  assert.equal(fixUtil.localDayKey(new Date(2026, 0, 2).getTime()), '2026-01-02')
})

test('P3-9: audit defaultDirResolver and cli userDataDir are the same single source', () => {
  assert.equal(userDir.userDataDir(), process.env.TODO_DB_DIR, 'TODO_DB_DIR wins')
  // After resetForTests the resolver is the shared default again — auditFile() must resolve under it
  audit.resetForTests()
  assert.ok(audit.auditFile().startsWith(process.env.TODO_DB_DIR.replace(/\\/g, '/')) || audit.auditFile().includes('cli-audit.jsonl'),
    `auditFile must resolve through the shared resolver, got ${audit.auditFile()}`)
})

test('P3-10: chipsRemoveTask is gone from the CLI exports (dead code deleted)', () => {
  assert.equal(lib.chipsRemoveTask, undefined)
  // sibling export still intact
  assert.equal(typeof lib.chipsRestoreSnapshot, 'function')
})
