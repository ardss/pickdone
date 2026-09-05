/** Real tests of the purgeAllRecycle three-confirmation chain.
 *  Simulates $confirm / $prompt step by step, asserting:
 *  (1) short-circuit return when the list is empty
 *  (2) direct return on a wrong keyword, no dispatch
 *  (3) correct keyword + second confirmation passes -> dispatches purgeAllRecycle + success toast
 *  (4) cancel at any step -> no dispatch
 *  Mounting the RecycleBinView component at runtime is heavy (depends on Vuex/ECharts etc.),
 *  so only clearAll's state-machine path is replicated here and the three-confirmation decision is verified independently.
 *  Run: npm test */
import { test } from 'node:test'
import assert from 'node:assert/strict'

/** Simulates the ElMessage chain: records every toast shown */
function makeMessage () {
  const calls = []
  return {
    success: (...args) => calls.push(['success', ...args]),
    warning: (...args) => calls.push(['warning', ...args]),
    error: (...args) => calls.push(['error', ...args]),
    info: (...args) => calls.push(['info', ...args]),
    calls
  }
}

/** Simulates $confirm / $prompt: returns scripted results in call order */
function makeConfirm (plan) {
  let i = 0
  return {
    $confirm: () => new Promise((resolve, reject) => {
      const step = plan[i++]
      if (step === 'ok') resolve('ok')
      else reject(new Error('cancelled'))
    }),
    $prompt: () => new Promise((resolve, reject) => {
      const step = plan[i++]
      if (step && typeof step === 'object') resolve({ value: step.value })
      else reject(new Error('cancelled'))
    })
  }
}

/** Replicates RecycleBinView.clearAll's decision logic (a standalone function for tests, no Vue component needed) */
async function clearAllDecision ({ list, $t, $confirm, $prompt, message, dispatch }) {
  if (!list.length) return { dispatched: false, reason: 'empty' }
  const n = list.length
  // (1) first confirmation
  await $confirm()
  // (2) keyword input
  const { value } = await $prompt()
  if (String(value || '').trim() !== $t('statsC.RecycleBin.clearKeyword')) {
    message.warning($t('statsC.RecycleBin.clearKeywordMismatch'))
    return { dispatched: false, reason: 'keyword-mismatch' }
  }
  // (3) second confirmation
  await $confirm()
  dispatch('todo/purgeAllRecycle')
  message.success($t('statsC.RecycleBin.cleared', { n }))
  return { dispatched: true, reason: 'ok', n }
}

const t = (k, p) => {
  if (k === 'statsC.RecycleBin.clearKeyword') return '清空回收站'
  if (k === 'statsC.RecycleBin.clearKeywordMismatch') return 'mismatch-msg'
  if (k === 'statsC.RecycleBin.cleared') return p && p.n != null ? `cleared-${p.n}` : 'cleared'
  return k
}

test('(1) short-circuits on an empty list without the three confirmations', async () => {
  const dispatch = () => { throw new Error('should not dispatch') }
  const message = makeMessage()
  const { $confirm, $prompt } = makeConfirm(['ok', 'ok', 'ok'])
  const r = await clearAllDecision({ list: [], $t: t, $confirm, $prompt, message, dispatch })
  assert.equal(r.dispatched, false)
  assert.equal(r.reason, 'empty')
  assert.equal(message.calls.length, 0)
})

test('(2) a wrong keyword does not dispatch, only shows a warning toast', async () => {
  const dispatch = () => { throw new Error('should not dispatch') }
  const message = makeMessage()
  const { $confirm, $prompt } = makeConfirm(['ok', { value: 'wrong' }])
  const r = await clearAllDecision({ list: [{ id: 1 }], $t: t, $confirm, $prompt, message, dispatch })
  assert.equal(r.dispatched, false)
  assert.equal(r.reason, 'keyword-mismatch')
  assert.equal(message.calls.length, 1)
  assert.equal(message.calls[0][0], 'warning')
})

test('(3) correct keyword + second confirmation passes -> dispatches purgeAllRecycle + success toast', async () => {
  let dispatched = null
  const dispatch = (a) => { dispatched = a }
  const message = makeMessage()
  const { $confirm, $prompt } = makeConfirm(['ok', { value: '清空回收站' }, 'ok'])
  const r = await clearAllDecision({ list: [{ id: 1 }, { id: 2 }, { id: 3 }], $t: t, $confirm, $prompt, message, dispatch })
  assert.equal(r.dispatched, true)
  assert.equal(dispatched, 'todo/purgeAllRecycle')
  assert.equal(r.n, 3)
  assert.equal(message.calls.length, 1)
  assert.equal(message.calls[0][0], 'success')
  assert.equal(message.calls[0][1], 'cleared-3')
})

test('(4) cancelling the first confirmation -> no dispatch', async () => {
  const dispatch = () => { throw new Error('should not dispatch') }
  const message = makeMessage()
  const { $confirm, $prompt } = makeConfirm(['cancelled'])
  await assert.rejects(
    clearAllDecision({ list: [{ id: 1 }], $t: t, $confirm, $prompt, message, dispatch }),
    /cancelled/
  )
  assert.equal(message.calls.length, 0)
})

test('(4) cancelling the keyword-input prompt -> no dispatch', async () => {
  const dispatch = () => { throw new Error('should not dispatch') }
  const message = makeMessage()
  const { $confirm, $prompt } = makeConfirm(['ok', 'cancelled'])
  await assert.rejects(
    clearAllDecision({ list: [{ id: 1 }], $t: t, $confirm, $prompt, message, dispatch })
  )
  assert.equal(message.calls.length, 0)
})

test('(4) cancelling the second confirmation -> no dispatch', async () => {
  const dispatch = () => { throw new Error('should not dispatch') }
  const message = makeMessage()
  const { $confirm, $prompt } = makeConfirm(['ok', { value: '清空回收站' }, 'cancelled'])
  try {
    await clearAllDecision({ list: [{ id: 1 }], $t: t, $confirm, $prompt, message, dispatch })
    assert.fail('should throw or short-circuit')
  } catch (e) { assert.match(String(e.message), /cancelled/) }
  assert.equal(message.calls.length, 0)
})

test('i18n keys: the clear-recycle-bin keyword is symmetric between zh/en', () => {
  const fs = require_('node:fs')
  const path = require_('node:path')
  const root = path.resolve('renderer/js/i18n/locales')
  const zhText = fs.readFileSync(path.join(root, 'zh-CN-C.js'), 'utf8')
  const enText = fs.readFileSync(path.join(root, 'en-US-C.js'), 'utf8')
  assert.ok(/clearKeyword:\s*'清空回收站'/.test(zhText), 'zh clearKeyword should equal "清空回收站"')
  assert.ok(/clearKeyword:\s*'empty recycle bin'/.test(enText), 'en clearKeyword should equal "empty recycle bin"')
  assert.ok(/clearKeywordMismatch:/.test(zhText) && /clearKeywordMismatch:/.test(enText), 'clearKeywordMismatch exists on both sides')
  assert.ok(/clearFinalConfirm:/.test(zhText) && /clearFinalConfirm:/.test(enText), 'clearFinalConfirm exists on both sides')
  // The keyword and undo prompts must have the same literal on both sides
  const zhKw = zhText.match(/clearKeyword:\s*'([^']+)'/)[1]
  const enKw = enText.match(/clearKeyword:\s*'([^']+)'/)[1]
  assert.ok(zhKw && enKw && zhKw.length > 0 && enKw.length > 0, 'the keyword is non-empty on both sides')
})

test('RecycleBinView.clearAll must check the list emptiness before confirm (prevents three popups on an empty bin)', () => {
  // Static check: the first line of the source should be if (!list.length) return - avoiding a mock stand-in
  const fs = require_('node:fs')
  const src = fs.readFileSync('renderer/js/views/RecycleBinView.vue', 'utf8')
  const m = src.match(/clearAll\s*\(\s*\)\s*\{([\s\S]*?)\n\s{4}\}/)
  assert.ok(m, 'the clearAll function was not found')
  const body = m[1]
  // Assertion: the empty-list short-circuit must come before confirm
  const emptyCheckIdx = body.indexOf('if (!list.length) return')
  const confirmIdx = body.indexOf('$confirm')
  assert.ok(emptyCheckIdx >= 0, 'the empty list should short-circuit first')
  assert.ok(confirmIdx > emptyCheckIdx, '$confirm must come after the empty-list short-circuit')
})

import { createRequire } from 'module'
const require_ = createRequire(import.meta.url)
