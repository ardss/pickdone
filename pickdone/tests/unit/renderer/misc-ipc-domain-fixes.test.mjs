/**
 * maint/deep-r2 — renderer-misc-and-ipc-errors domain batch (main.js/tomato/DepView/core.js +
 * db-sync-ops + cli/lib-tomato.cjs). One test per finding, all red on the pre-fix code:
 *   T1  cli/lib-tomato.cjs: the App's EXPIRED receipt ({status:'expired'}, written for a stale
 *       command) used to satisfy waitForTomatoAck and the CLI printed "✓ focus started" for a
 *       command the App never executed — faking success, the exact contract violation the
 *       waitForTomatoAck gate was added to prevent. start/stop/attach must reject CMD_EXPIRED.
 *   T2  store/tomato.js removeRecordsByIdPrefix: removing ledger rows (demo-data cleanup) never
 *       recomputed todayTomatoCount — the initiating window receives no recordsReload recompute
 *       for its own write, so the today ring stayed stale until an unrelated broadcast (same
 *       defect class as D14-B2 removeRecord/updateRecord).
 *   T3  DepView.vue onDrop right-half branch passed the raw id STRING as dependentTask, so the
 *       undo toast lost the dragged task's name (dependentTask.taskContent is undefined on a
 *       string). The call must pass the dragged card object.
 * Run: node --test tests/unit/renderer/misc-ipc-domain-fixes.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const require_ = createRequire(import.meta.url)
const dayjs = require_('dayjs')
const todayKey = dayjs().format('YYYY-MM-DD')
const yesterdayKey = dayjs(+dayjs().startOf('day') - 86400000).format('YYYY-MM-DD')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

/* shared db bridge stub — installed BEFORE importing the store module (tomato hydrates its
   pending queues from localStorage at import time) */
let allRows = []
globalThis.window.todoAPI = {
  dbCall (op, params) {
    if (op === 'tomatoAll') return Promise.resolve(allRows)
    return Promise.resolve(null)
  },
  onAppQuittingFlush () {}
}
const tomato = (await import('../../../renderer/js/store/tomato.js')).default

/* ==================== T1: CLI expired receipt must not fake success ==================== */

function makeLib (ack) {
  return {
    CliError: class CliError extends Error { constructor (msg, code) { super(msg); this.code = code } },
    writeTomatoCmd: () => 1,
    waitForTomatoAck: async () => ack,
    resolveTask: () => ({ taskId: 't1', taskContent: 'x' }),
    liveTasks: () => [],
    tomatoRecords: () => [],
    readTomatoState: () => null,
    tomatoLiveRemainSec: () => 0,
    backfillRecord: () => ({ tomatoId: 'x', dateKey: todayKey, focusDuration: 25 })
  }
}
const runTomato = require_(path.join(ROOT, 'cli/lib-tomato.cjs'))

test('T1 cli tomato start/stop/attach: an EXPIRED receipt rejects instead of faking success', async () => {
  const expired = { seq: 1, status: 'expired', error: 'stale command (>60s)', at: Date.now() }
  for (const op of ['start', 'stop', 'attach']) {
    await assert.rejects(
      () => runTomato({ opts: { _: [op] }, lib: makeLib(expired), emit: () => {}, emitNext: () => {} }),
      e => /expired|stale/i.test(e.message),
      op + ': the expired receipt is a rejection, not "✓ done" (CLI MUST not report a focus/session the App never ran)')
  }
})

test('T1 cli tomato start: a live receipt still resolves (contract preserved)', async () => {
  const ack = { seq: 1, status: 'startTomatoTime', remainSec: 1500, at: Date.now() }
  await assert.doesNotReject(
    () => runTomato({ opts: { _: ['start'] }, lib: makeLib(ack), emit: () => {}, emitNext: () => {} }))
})

/* ==================== T2: removeRecordsByIdPrefix recomputes the today count ==================== */

test('T2 removing today rows via id prefix recomputes todayTomatoCount in the initiating window', async () => {
  allRows = [
    { tomatoId: 'tmt_demo_1', dateKey: todayKey, succeed: true },
    { tomatoId: 'tmt_real_1', dateKey: todayKey, succeed: true },
    { tomatoId: 'tmt_demo_2', dateKey: yesterdayKey, succeed: true }
  ]
  const state = { tomatoRecordList: [], todayTomatoCount: 3, _countDate: todayKey }
  const commit = (type, payload) => {
    if (type === 'recordsReplace') tomato.mutations.recordsReplace(state, payload)
    else if (type === 'patch') tomato.mutations.patch(state, payload)
  }
  await tomato.actions.removeRecordsByIdPrefix({ state, commit }, 'tmt_demo_')
  assert.ok(!state.tomatoRecordList.some(r => r.tomatoId.startsWith('tmt_demo_')), 'demo rows removed from the ledger copy')
  assert.equal(state.todayTomatoCount, 1, 'today count recomputed from the mutated ledger (was left stale at 3)')
  assert.equal(state._countDate, todayKey, 'count date anchored to today')
})

/* ==================== T3: DepView right-half drop passes the dragged CARD to the toast builder ==================== */

test('T3 DepView onDrop right branch passes the dragged card object (not the raw id string) as dependentTask', () => {
  const src = read('renderer/js/components/DepView.vue')
  const i = src.indexOf("if (side === 'right')")
  assert.ok(i > 0, 'onDrop right-branch block found')
  const block = src.slice(Math.max(0, i - 200), i + 300)
  assert.match(block, /var srcTask = this\.inScope\.find\(x => x\.taskId === srcId\)/,
    'the dragged card is resolved to its task object once, before the branch')
  assert.match(block, /addDependency\(srcTask, t\.taskId, t, srcTask\)/,
    'right-half drop: dependentTask is the dragged CARD object — a string has no .taskContent, so the undo toast lost the dragged task name')
})
