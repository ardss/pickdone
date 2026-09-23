/**
 * Domain-2 P2 fix: taskMenu's copy-title+desc item guarded the clipboard write with nothing —
 * a rejected navigator.clipboard.writeText (focus loss / permission denial) became an unhandled
 * promise rejection and the user got neither a success nor a failure toast.
 * Now aligned with TodoItem.vue's twin implementation: try/catch → $message.error(copyFailMsg)
 * on rejection, $message.success(copiedMsg) only after the write resolves.
 * Behavioral test: drives buildTaskMenu's returned copy fn against a stubbed clipboard.
 *
 * Run: node --test tests/unit/renderer/dw2-taskmenu-copy-guard.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

// ---- env mocks (must exist before any renderer module is imported; same recipe as
//      tests/unit/store/store-fixes-domain.test.mjs — no electron required) ----
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
globalThis.window = { location: { hash: '' }, todoAPI: {} }

const task = { taskId: 't1', taskContent: 'hello', taskDescribe: 'world' }

function makeVm () {
  const msgs = []
  return {
    msgs,
    $t: k => k,
    $store: { state: { todo: { todoList: [task] } }, commit () {}, dispatch () {} },
    $message: {
      success: m => msgs.push(['success', m]),
      error: m => msgs.push(['error', m]),
      warning () {}
    },
    $prompt: () => new Promise(() => {})
  }
}

function stubClipboard (impl) {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: impl } }
  })
}

test('copy item: resolved write → success toast, no error toast', async () => {
  const { buildTaskMenu } = await import('../../../renderer/js/utils/taskMenu.js')
  const written = []
  stubClipboard(async text => { written.push(text) })
  const vm = makeVm()
  const copy = buildTaskMenu(vm, task).find(i => i.icon === 'copy')
  assert.ok(copy, 'copy item present by default caps')
  await copy.fn()
  assert.deepEqual(written, ['hello\nworld'])
  assert.deepEqual(vm.msgs, [['success', 'statsE.TodoItem.copiedMsg']])
})

test('copy item: rejected write → error toast (copyFailMsg), no success toast, no unhandled rejection', async () => {
  const { buildTaskMenu } = await import('../../../renderer/js/utils/taskMenu.js')
  stubClipboard(async () => { throw new Error('NotAllowedError') })
  const vm = makeVm()
  const copy = buildTaskMenu(vm, task).find(i => i.icon === 'copy')
  // if the guard were missing this await would reject (unhandled-rejection territory)
  await copy.fn()
  assert.deepEqual(vm.msgs, [['error', 'statsE.TodoItem.copyFailMsg']])
})
