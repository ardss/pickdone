/* maint/d11-r4 regressions:
 * [1] bumpSnow 队列的启动水合曾因 TDZ 永远静默失败:hydratePendingQueue(PENDING_SNOW_KEY) 在
 *     `const _pendingSnow = []` 声明之前执行,revive 闭包抛 ReferenceError,被"corrupt blob"
 *     的 catch 吞掉——崩溃前持久化的积分补账条目重启后永不重放。修复=声明上移 + catch 拆分为
 *     parse 失败(降级+log)与 revive/其他失败(向上抛)。本测试在模块导入前预置合法 snow 队列
 *     blob,断言新模块实例将其重放:旧代码此处拿到空队列,quit-flush 一次 bump 都发不出。
 * [2] 损坏 blob(parse 失败)仍是非致命降级,但现在打日志(可观测),且不毒害后续水合。
 * [3] remainingSecOfState 单源:运行中从 startedAt 推导并钳零(floor);空闲回退默认 25 分钟;
 *     rest 阶段用 restTime。此前该公式在 TomatoBar/TomatoPanel/TomatoFloatPage 有 5 份手写副本。
 * [4] 防再复制守卫:三个组件必须 import remainingSecOfState 且不再内联手写倒计时公式。
 * Run: node --test tests/unit/store/d11r4-snow-hydrate-and-remainingsec.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const LEDGER_KEY = 'tomatoPendingLedger'
const SNOW_KEY = 'tomatoPendingSnow'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

test('d11r4[1]: a snow entry persisted before a crash is hydrated and replayed in a fresh module instance (TDZ fix)', async () => {
  globalThis.localStorage.removeItem(LEDGER_KEY)
  globalThis.localStorage.removeItem(SNOW_KEY)
  // Pre-crash blob: a failed bumpSnow was mirrored to LS before the process died.
  globalThis.localStorage.setItem(SNOW_KEY, JSON.stringify({
    v: 1,
    entries: [{ seq: 41, ts: Date.now() - 60000, params: { taskId: 77, minutes: 25, dedupKey: '1700000000000' } }],
  }))

  const bumps = []
  globalThis.window.todoAPI = {
    // D14-C2: real db.bumpSnow contract is {ok:true|false,reason}, never {accepted,rejected}
    dbCall: async (op, params) => { if (op === 'bumpSnow') bumps.push(params); return { ok: true, minutes: 1 } },
    onAppQuittingFlush (cb) { this._quitCbs = (this._quitCbs || []).concat(cb) },
  }
  const { default: tomato } = await import('../../../renderer/js/store/tomato.js?d11r4-snow-hydrate')

  // Trigger the quit-flush path with a normal ledger write (same trigger as production quit)
  const s = { tomatoRecordList: [] }
  tomato.mutations.addRecord(s, { tomatoId: 'tmt_d11r4_h', endTime: Date.now(), dateKey: '2026-09-28', focusDuration: 25 })
  await new Promise(r => setTimeout(r, 20))
  const quitCbs = globalThis.window.todoAPI._quitCbs || []
  for (const cb of quitCbs) await cb()
  await new Promise(r => setTimeout(r, 20))

  assert.equal(bumps.filter(p => p && p.taskId === 77).length, 1,
    'the pre-crash snow entry hydrated at module load and replayed exactly once (pre-fix: hydrate hit the _pendingSnow TDZ, the ReferenceError was swallowed as "corrupt blob", and this bump never fired)')
  const after = JSON.parse(globalThis.localStorage.getItem(SNOW_KEY))
  assert.equal(after.entries.length, 0, 'LS snow queue drains after successful replay')
})

test('d11r4[2]: a corrupt (unparseable) snow blob still degrades non-fatally but logs, and does not poison hydration', async () => {
  globalThis.localStorage.setItem(LEDGER_KEY, '{not json either')
  globalThis.localStorage.setItem(SNOW_KEY, '{"v":1,"entries":[{"seq":7,')
  const errs = []
  const origErr = console.error
  console.error = (...a) => { errs.push(a.join(' ')) }
  try {
    const { default: tomato } = await import('../../../renderer/js/store/tomato.js?d11r4-corrupt')
    globalThis.window.todoAPI = { dbCall: async () => ({ accepted: 1, rejected: [] }) }
    const s = { tomatoRecordList: [] }
    tomato.mutations.addRecord(s, { tomatoId: 'tmt_d11r4_c', endTime: Date.now(), dateKey: '2026-09-28', focusDuration: 1 })
    await new Promise(r => setTimeout(r, 20))
  } finally {
    console.error = origErr
  }
  const blob = JSON.parse(globalThis.localStorage.getItem(SNOW_KEY))
  assert.ok(blob && blob.v === 1 && Array.isArray(blob.entries), 'module loaded and rewrote the blob (degradation was non-fatal)')
  assert.equal(blob.entries.length, 0, 'corrupt leftovers did not resurrect')
  assert.ok(errs.some(t => t.includes('tomatoPendingSnow') && t.includes('corrupt')), 'parse failure is now logged with the offending key (was a silent comment-only catch)')
})

test('d11r4[3]: remainingSecOfState — running derives from startedAt with floor+clamp-to-zero, rest uses restTime, idle falls back to the default', async () => {
  const { remainingSecOfState } = await import('../../../renderer/js/store/tomato.js?d11r4-fn')
  const t0 = 1_700_000_000_000
  // Running focus: 25min total, 61s elapsed → floor to 61, remainder 1439
  assert.equal(remainingSecOfState({ status: 'startTomatoTime', startedAt: t0, tomatoTime: 25, restTime: 5 }, t0 + 61_000), 1500 - 61)
  // Elapsed beyond total clamps to 0 (no negative countdown)
  assert.equal(remainingSecOfState({ status: 'startTomatoTime', startedAt: t0, tomatoTime: 25 }, t0 + 26 * 60_000), 0)
  // Negative fraction (clock skew at click instant) clamps elapsed, not below zero
  assert.equal(remainingSecOfState({ status: 'startTomatoTime', startedAt: t0, tomatoTime: 25 }, t0 - 500), 25 * 60)
  // Rest phase uses restTime
  assert.equal(remainingSecOfState({ status: 'startRestTime', startedAt: t0, tomatoTime: 25, restTime: 5 }, t0 + 60_000), 4 * 60)
  // Running flag but missing startedAt → full amount, not NaN
  assert.equal(remainingSecOfState({ status: 'startTomatoTime', tomatoTime: 25, restTime: 5 }, t0), 25 * 60)
  // Idle → configured tomatoTime
  assert.equal(remainingSecOfState({ status: 'default', tomatoTime: 30, restTime: 5 }, t0), 30 * 60)
  // Idle with no configured duration → 25min default (not NaN, the old TomatoBar.remainSecNow could produce NaN*60)
  assert.equal(remainingSecOfState({ status: 'default' }, t0), 25 * 60)
  // Null state → idle default
  assert.equal(remainingSecOfState(null, t0), 25 * 60)
})

test('d11r4[4]: anti-re-copy guard — the three components consume the single source instead of hand-rolling the formula', async () => {
  const files = [
    'renderer/js/components/TomatoBar.vue',
    'renderer/js/components/TomatoPanel.vue',
    'renderer/js/views/TomatoFloatPage.vue',
  ]
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), 'utf8')
    assert.ok(src.includes('remainingSecOfState'), f + ' imports the shared remaining-seconds source')
    assert.ok(!src.includes("s.status === 'startRestTime' ? s.restTime : s.tomatoTime) * 60"),
      f + ' no longer hand-writes the remaining-seconds formula')
  }
  // And the single source exists exactly once, in the store
  const store = readFileSync(join(ROOT, 'renderer/js/store/tomato.js'), 'utf8')
  assert.equal((store.match(/restTime : s\.tomatoTime/g) || []).length, 1, 'the formula lives exactly once, in store/tomato.js')
})
