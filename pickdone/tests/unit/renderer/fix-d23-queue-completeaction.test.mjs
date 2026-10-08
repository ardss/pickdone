/**
 * maint/d23 FIX-3a — executing regression tests:
 *
 * #2 tomatoPendingQueue: both same-origin windows (main + float) hydrate the pending queue
 *    into a private array; settle/purge only mutate the settling process's array + its LS
 *    delete-own-key, so the OTHER window's stale entry is re-sent by its next replay and the
 *    db layer's ON CONFLICT DO UPDATE SET deleted=0 resurrects the removed record. Replay
 *    now re-checks the LS mirror and drops peer-settled/purged entries.
 * #3 completeAction: the FORWARD completion announce fires only after the dispatch resolves;
 *    a rejection surfaces the shared actionFailedMsg toast instead of being swallowed.
 * Run: node --test tests/unit/renderer/fix-d23-queue-completeaction.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const url = p => 'file://' + path.join(ROOT, p).replace(/\\/g, '/')
const tick = () => new Promise(r => setTimeout(r, 20))

function stubStorage () {
  const map = new Map()
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: k => { map.delete(k) },
    key: i => [...map.keys()][i] ?? null,
    get length () { return map.size }
  }
}

test('#2 ledger replay skips an entry the peer settled/purged from the LS mirror', async () => {
  globalThis.localStorage = stubStorage()
  const calls = []
  globalThis.window.todoAPI = { dbCall: (op, params) => { calls.push(params); return Promise.resolve(undefined) } }
  const mod = await import(url('renderer/js/store/helpers/tomatoPendingQueue.js?peer=' + Math.random()))
  // Enqueue in "window A": replay fires, dbCall resolves falsy → entry stays pending (mirror present)
  mod.ledgerWrite('tomatoAppendMany', [{ tomatoId: 'a', endTime: 1 }])
  await tick()
  assert.equal(calls.length, 1, 'the first replay sends the entry once')
  // "Peer" settles/purges it: LS delete-own-key, private array in THIS process untouched
  const mirrorKey = [...globalThis.localStorage.length ? [] : []]
  void mirrorKey
  // find the entry's key the same way the module names it: prefix + uid — emulate a peer by
  // removing every pending-ledger key (that is exactly what a peer's settle/purge does).
  const keys = []
  for (let i = 0; i < globalThis.localStorage.length; i++) keys.push(globalThis.localStorage.key(i))
  for (const k of keys.filter(k => k.startsWith('tomatoPendingLedger.'))) globalThis.localStorage.removeItem(k)
  // Next write in this window replays the queue: the stale entry must be DROPPED, not re-sent
  // (re-sending would make the db layer's ON CONFLICT resurrect the row the peer removed).
  mod.ledgerWrite('tomatoAppendMany', [{ tomatoId: 'b', endTime: 2 }])
  await tick()
  const aSends = calls.filter(p => p[0] && p[0].tomatoId === 'a').length
  assert.equal(aSends, 1, 'the peer-settled entry is never re-sent (stays at one send)')
  assert.ok(calls.some(p => p[0] && p[0].tomatoId === 'b'), 'the fresh entry is still replayed')
})

test('#2 snow replay skips a peer-settled bump entry', async () => {
  globalThis.localStorage = stubStorage()
  const calls = []
  globalThis.window.todoAPI = { dbCall: (op, params) => { calls.push(params); return Promise.resolve(undefined) } }
  const mod = await import(url('renderer/js/store/helpers/tomatoPendingQueue.js?peersnow=' + Math.random()))
  mod.snowWrite({ taskId: 't1', dedupKey: '100' }) // falsy result → stays pending
  await tick()
  assert.equal(calls.length, 1, 'first replay sends the bump once')
  for (let i = 0; i < globalThis.localStorage.length;) {
    const k = globalThis.localStorage.key(i)
    if (k && k.startsWith('tomatoPendingSnow.')) globalThis.localStorage.removeItem(k)
    else i++
  }
  mod.snowWrite({ taskId: 't2', dedupKey: '200' })
  await tick()
  const t1 = calls.filter(p => p && p.dedupKey === '100').length
  assert.equal(t1, 1, 'peer-settled snow entry is not re-sent')
  assert.ok(calls.some(p => p && p.dedupKey === '200'), 'fresh snow entry still replays')
})

test('#3 completion announce fires only after the dispatch resolves', async () => {
  globalThis.window.Vue = { h: (tag, props) => ({ tag, props }) }
  try {
    const { toggleCompleteWithUndo } = await import(url('renderer/js/utils/completeAction.js'))
    let resolveDispatch
    const toasts = []
    const message = m => toasts.push(m)
    message.closeAll = () => {}
    const announced = []
    const store = {
      state: { todo: { todoList: [{ taskId: 't1', taskContent: 'A', complete: false }], recycleList: [] } },
      dispatch: () => new Promise(r => { resolveDispatch = r })
    }
    const p = toggleCompleteWithUndo({ store, message, todo: { taskId: 't1', taskContent: 'A' }, announce: m => announced.push(m) })
    assert.equal(announced.length, 0, 'the announce does NOT fire synchronously for a pending write')
    resolveDispatch()
    await p
    assert.equal(announced.length, 1, 'the announce fires after the write lands')
    assert.ok(announced[0].includes('A'))
  } finally { delete globalThis.window.Vue }
})

test('#3 a failed completion surfaces the failure toast instead of a fake success', async () => {
  globalThis.window.Vue = { h: (tag, props) => ({ tag, props }) }
  try {
    const { toggleCompleteWithUndo } = await import(url('renderer/js/utils/completeAction.js'))
    const toasts = []
    const message = m => toasts.push(m)
    message.closeAll = () => {}
    const announced = []
    const store = {
      state: { todo: { todoList: [{ taskId: 't1', taskContent: 'A', complete: false }], recycleList: [] } },
      dispatch: () => Promise.reject(new Error('db busy'))
    }
    const p = toggleCompleteWithUndo({ store, message, todo: { taskId: 't1', taskContent: 'A' }, announce: m => announced.push(m) })
    await assert.rejects(p, /db busy/, 'the dispatch rejection still propagates to the caller')
    assert.equal(announced.length, 0, 'no success announce for a failed write')
    const err = toasts.find(t => t && t.type === 'error')
    assert.ok(err, 'an error toast is shown')
    assert.ok(/db busy/.test(err.message), 'the failure toast carries the cause (actionFailedMsg shape)')
  } finally { delete globalThis.window.Vue }
})
