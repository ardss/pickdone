/* H1 regressions (2026-09-16), tomato ledger retry queue:
 * [3] db 层 tomatoAppendMany 返回 {accepted,rejected} 行级容错结果,replay/flush 只 splice 从不读
 *     返回值,坏行静默消失——现在逐条 console.error 上报。
 * [4] remove 落库成功后,pending 队列里同 tomatoId 的旧 append 会在下次重放时经 ON CONFLICT
 *     DO UPDATE SET deleted=0 复活已删行——成功路径按 id 过滤 _pendingLedger。
 * Run: node --test tests/unit/store/h1-tomato-ledger-retry.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const calls = []
const errors = []
const origError = console.error

function installDb (impl) {
  globalThis.window.todoAPI = { dbCall: impl }
}

test('H1[3]: a rejected ledger row from tomatoAppendMany is logged, not silently dropped', async () => {
  console.error = (...a) => { errors.push(a.join(' ')) }
  try {
    installDb(async (op, params) => {
      calls.push([op, params])
      if (op === 'tomatoAppendMany') {
        return { accepted: 0, rejected: [{ index: 0, tomatoId: 'tmt_bad_1', reason: 'endTime required' }] }
      }
      return 'ok'
    })
    const { default: tomato } = await import('../../../renderer/js/store/tomato.js')
    const s = { tomatoRecordList: [] }
    tomato.mutations.addRecord(s, { tomatoId: 'tmt_bad_1', endTime: 0, dateKey: '2026-09-16', focusDuration: 25 })
    await new Promise(r => setTimeout(r, 20))
    assert.ok(errors.some(w => w.includes('ledger row rejected')), 'rejected row surfaced via console.error')
    assert.ok(errors.some(w => w.includes('endTime required')), 'rejection reason included')
    assert.ok(errors.some(w => w.includes('tmt_bad_1')), 'rejected row payload included')
  } finally {
    console.error = origError
  }
})

test('H1[4]: a successful remove purges the pending same-id append (no resurrection on replay)', async () => {
  console.error = () => {}
  try {
    let appendFails = true
    let appendCalls = 0
    installDb(async (op, params) => {
      calls.push([op, params])
      if (op === 'tomatoAppendMany') {
        appendCalls++
        if (appendFails) throw new Error('db down') // stays in _pendingLedger for retry
        return { accepted: 1, rejected: [] }
      }
      return 'ok' // tomatoRemoveByIds succeeds
    })
    const { default: tomato } = await import('../../../renderer/js/store/tomato.js')
    const s = { tomatoRecordList: [] }
    tomato.mutations.addRecord(s, { tomatoId: 'tmt_h1_x', endTime: Date.now(), dateKey: '2026-09-16', focusDuration: 25 })
    await new Promise(r => setTimeout(r, 20))
    assert.equal(appendCalls, 1, 'append attempted once, failed, kept pending')
    // Remove the same record: the remove op succeeds and must purge the pending append
    tomato.mutations.removeRecord(s, 'tmt_h1_x')
    await new Promise(r => setTimeout(r, 20))
    const appendsBefore = appendCalls
    // Any later ledger write triggers replayPendingLedger — the purged append must NOT be resent
    // (ON CONFLICT DO UPDATE SET deleted=0 would resurrect the deleted row)
    appendFails = false
    tomato.mutations.addRecord(s, { tomatoId: 'tmt_h1_y', endTime: Date.now(), dateKey: '2026-09-16', focusDuration: 10 })
    await new Promise(r => setTimeout(r, 20))
    assert.equal(appendCalls, appendsBefore + 1, 'only the new record replays; the purged same-id append is never resent')
  } finally {
    console.error = origError
  }
})
