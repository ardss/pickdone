/* maint/d11-r3 regressions, tomato retry queues survive process death:
 * [1] 账本重试队列持久化:写入失败后 _pendingLedger 镜像进 localStorage(seq/ts),模拟崩溃后新
 *     模块实例启动时水合,并在下一次账本写时重放到已恢复的 db——旧实现纯内存,条目随进程消亡。
 * [2] bumpSnow 重试队列同法:completeFocus 的积分 bump 失败后持久化,重启后经 quit-flush 重放,
 *     成功后 LS 清空。
 * [3] 损坏的队列 blob 不致命(水合回退空队列,账本本体在 SQLite)。
 * Run: node --test tests/unit/store/d11r3-pending-queue-persist.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const LEDGER_KEY = 'tomatoPendingLedger'
const SNOW_KEY = 'tomatoPendingSnow'
const CLAIM_KEY = 'tomatoLastPhaseDone'
const LS_KEY = 'tomatoState'

// TQ-2: the mirror is per-entry (`<prefix><uid>` keys, each carrying one entry). Scan by prefix.
function readQueue (prefix) {
  const entries = []
  const ls = globalThis.localStorage
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i)
    // the TQ-5 quarantine key shares the prefix but holds raw corrupt bytes, not entries
    if (!k || k.indexOf(prefix) !== 0 || k === prefix + 'corrupt') continue
    try { entries.push(JSON.parse(ls.getItem(k)).entry) } catch (e) { /* skip */ }
  }
  return { entries }
}

test('d11r3[1]: a failed ledger write is persisted to LS and replayed after a simulated crash+restart', async () => {
  for (const k of [LEDGER_KEY, SNOW_KEY]) globalThis.localStorage.removeItem(k)
  globalThis.window.todoAPI = { dbCall: async () => { throw new Error('db down at enqueue time') } }
  const mod1 = await import('../../../renderer/js/store/tomato.js?d11r3-crash')
  const s = { tomatoRecordList: [] }
  mod1.default.mutations.addRecord(s, { tomatoId: 'tmt_d11r3_1', endTime: Date.now(), dateKey: '2026-09-28', focusDuration: 25 })
  await new Promise(r => setTimeout(r, 20)) // let the failed dbCall settle; entry must stay queued

  const persisted = readQueue('tomatoPendingLedger.')
  assert.ok(persisted && Array.isArray(persisted.entries) && persisted.entries.length >= 1, 'per-entry mirror key written to localStorage')
  const entry = persisted.entries.find(e => e.op === 'tomatoAppendMany' && e.params && e.params.tomatoId === 'tmt_d11r3_1')
  assert.ok(entry, 'the failed append is in the persisted queue')
  assert.equal(typeof entry.seq, 'number', 'entry carries a seq')
  assert.equal(typeof entry.ts, 'number', 'entry carries a timestamp')

  // Simulated restart: fresh module instance hydrates from LS; db is healthy again. The replay is
  // triggered by the next ledger write (the doc contract: "下一次任意账本写时重放").
  const seen = []
  globalThis.window.todoAPI = { dbCall: async (op, params) => { seen.push([op, params]); return { accepted: 1, rejected: [] } } }
  const { default: tomato2 } = await import('../../../renderer/js/store/tomato.js?d11r3-restart')
  const s2 = { tomatoRecordList: [] }
  tomato2.mutations.addRecord(s2, { tomatoId: 'tmt_d11r3_2', endTime: Date.now(), dateKey: '2026-09-28', focusDuration: 10 })
  await new Promise(r => setTimeout(r, 20))
  const replayed = seen.filter(([op, p]) => op === 'tomatoAppendMany' && p.tomatoId === 'tmt_d11r3_1')
  assert.equal(replayed.length, 1, 'the pre-crash entry is replayed into the recovered db exactly once')
  const after = readQueue('tomatoPendingLedger.')
  assert.ok(!after.entries.some(e => e.params && e.params.tomatoId === 'tmt_d11r3_1'), 'LS copy drops the entry after successful replay')
})

test('d11r3[2]: a failed bumpSnow is persisted and replays via quit-flush after a simulated restart', async () => {
  for (const k of [LEDGER_KEY, SNOW_KEY, CLAIM_KEY]) globalThis.localStorage.removeItem(k)
  const startedAt = Date.now()
  globalThis.localStorage.setItem(LS_KEY, JSON.stringify({ schemaV: 1, status: 'startTomatoTime', startedAt, tomatoTime: 25, restTime: 5 }))
  let bumpFails = true
  const calls = []
  globalThis.window.todoAPI = { dbCall: async (op, params) => {
    calls.push([op, params])
    if (op === 'getById') return { taskId: 7, delete: false }
    if (op === 'bumpSnow' && bumpFails) throw new Error('ipc down')
    return { ok: true, minutes: 5 } // D14-C2: real db.bumpSnow contract is {ok:true|false,reason}, never {accepted,rejected}
  } }
  const { default: tomato } = await import('../../../renderer/js/store/tomato.js?d11r3-snow-crash')
  const state = Object.assign({}, tomato.state, {
    status: 'startTomatoTime', startedAt, tomatoTime: 25, restTime: 5, enableNotification: false,
    attachTodo: { taskId: 7, taskContent: 'Task' }, tomatoRecordList: [], todayTomatoCount: 0
  })
  const ctx = {
    state,
    rootState: { todo: { todoList: [{ taskId: 7, taskContent: 'Task', delete: false }] }, settings: {} },
    commit (m, p) { tomato.mutations[m] && tomato.mutations[m](state, p) },
    dispatch () { return Promise.resolve() }
  }
  await tomato.actions.completeFocus.call({ rootState: ctx.rootState, state }, ctx)
  await new Promise(r => setTimeout(r, 20))
  const persisted = readQueue('tomatoPendingSnow.')
  assert.ok(persisted && Array.isArray(persisted.entries) && persisted.entries.length === 1, 'failed bump is persisted to LS')
  assert.equal(persisted.entries[0].params.taskId, 7, 'snow entry payload persisted')
  assert.equal(typeof persisted.entries[0].seq, 'number', 'seq stamped')
  assert.equal(typeof persisted.entries[0].ts, 'number', 'ts stamped')

  // Restart: fresh module hydrates the snow queue from LS; db healthy. Quit-flush must replay it.
  // maint/d11-r4: count only restart-phase calls. The old assertion scanned both phases and the
  // phase-1 dbCall records the FAILED bump before throwing — with the hydration TDZ the replay
  // never fired and the "exactly once" pass was the failed attempt, a fake green.
  bumpFails = false
  const restartCalls = []
  const flushCbs = []
  globalThis.window.todoAPI = {
    dbCall: async (op, params) => { restartCalls.push([op, params]); return { ok: true, minutes: 5 } }, // D14-C2: bumpSnow contract is {ok:true|false}
    onAppQuittingFlush (cb) { flushCbs.push(cb) }
  }
  const { default: tomato2 } = await import('../../../renderer/js/store/tomato.js?d11r3-snow-restart')
  const s2 = { tomatoRecordList: [] }
  tomato2.mutations.addRecord(s2, { tomatoId: 'tmt_d11r3_k', endTime: Date.now(), dateKey: '2026-09-28', focusDuration: 5 })
  await new Promise(r => setTimeout(r, 20))
  assert.ok(flushCbs.length >= 1, 'the ledger write hooks the quit flush in the fresh instance')
  for (const cb of flushCbs) await cb()
  await new Promise(r => setTimeout(r, 20))
  const bumps = restartCalls.filter(([op, p]) => op === 'bumpSnow' && p && p.taskId === 7)
  assert.equal(bumps.length, 1, 'the hydrated snow entry replays exactly once at quit-flush (restart phase only)')
  const after = readQueue('tomatoPendingSnow.')
  assert.equal(after.entries.length, 0, 'LS snow queue drains after successful replay')
})

test('d11r3[3]: a corrupt queue blob hydrates to an empty queue without throwing', async () => {
  globalThis.localStorage.setItem(LEDGER_KEY, '{not json')
  globalThis.localStorage.setItem(SNOW_KEY, JSON.stringify({ v: 99, entries: 'nope' }))
  const { default: tomato } = await import('../../../renderer/js/store/tomato.js?d11r3-corrupt')
  const s = { tomatoRecordList: [] }
  globalThis.window.todoAPI = { dbCall: async () => ({ accepted: 1, rejected: [] }) }
  // Any subsequent write still works (hydration failure is non-fatal)
  tomato.mutations.addRecord(s, { tomatoId: 'tmt_d11r3_c', endTime: Date.now(), dateKey: '2026-09-28', focusDuration: 1 })
  await new Promise(r => setTimeout(r, 20))
  const blob = readQueue('tomatoPendingLedger.')
  assert.equal(blob.entries.length, 0, 'the successful write drained the queue (corrupt leftovers did not resurrect)')
})
