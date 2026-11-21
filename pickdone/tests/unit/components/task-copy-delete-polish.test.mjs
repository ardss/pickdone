import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { formatTaskHandoff } from '../../../renderer/js/utils/taskHandoff.mjs'

const editorPath = fileURLToPath(new URL('../../../renderer/js/components/EditPanel.vue', import.meta.url))
const cssPath = fileURLToPath(new URL('../../../renderer/js/components/edit-panel/editPanel.css', import.meta.url))
const editor = readFileSync(editorPath, 'utf8')
const css = readFileSync(cssPath, 'utf8')
const found = editor.match(/ {4}async delTask \(\) \{[\s\S]*?\n {4}\},/)
assert.ok(found, 'missing delete method')

function withDelete (deleteFn) {
  return new Function('deleteWithUndo', 'return ({' + found[0] + '}).delTask')(deleteFn)
}
function context (task = { taskId: 'tid_test', taskContent: 'QA fixture' }) {
  return {
    task, inRecycle: false, isRepeat: false, closed: false, confirmCalls: 0,
    $t: k => k,
    $store: {},
    $confirm () { this.confirmCalls++; return Promise.resolve() },
    close () { this.closed = true },
    askRepeatDelete () { this.repeatConfirmed = true }
  }
}

test('copy time identifies snapshot moment without changing task timestamps', () => {
  const task = { taskId: 'tid_demo', taskContent: '测试', createTime: 123, updateTime: 456 }
  const before = structuredClone(task)
  const text = formatTaskHandoff(task, { copiedAt: Date.parse('2026-11-18T05:50:08.000Z') })
  assert.match(text, /复制时间: 2026-11-18 13:50:08 \(UTC\+08:00\)/)
  assert.equal(text.includes('任务ID: tid_demo'), true)
  assert.deepEqual(task, before)
})

test('copy and trash are equal-size native SVG buttons, trash has danger hover and keyboard focus', () => {
  const footer = editor.match(/<div class="ep-tools">([\s\S]*?)<\/div>/)?.[1] || ''
  assert.match(footer, /class="ep-tool ep-copy"/)
  assert.match(footer, /class="ep-tool ep-delete danger"/)
  assert.match(footer, /<app-icon name="trash" :size="16"\/>/)
  assert.match(footer, /<app-icon name="copy" :size="16"\/>/)
  assert.doesNotMatch(footer, /delete_black_48dp\.svg/)
  assert.match(css, /\.ep-tool\.ep-copy, \.ep-tool\.ep-delete/)
  assert.match(css, /\.ep-tool\.ep-delete:hover, \.ep-tool\.ep-delete:focus-visible/)
  assert.match(css, /color: var\(--danger\)/)
})

test('cancelling deletion never deletes or closes', async () => {
  let calls = 0
  const c = context()
  c.$confirm = () => { c.confirmCalls++; return Promise.reject(new Error('cancel')) }
  await withDelete(async () => { calls++; return true }).call(c)
  assert.equal(c.confirmCalls, 1)
  assert.equal(calls, 0)
  assert.equal(c.closed, false)
})

test('confirmed delete uses existing soft-delete with undo and closes only on success', async () => {
  const c = context()
  let calls = 0
  await withDelete(async (_vm, store, task) => { calls++; assert.equal(task.taskId, 'tid_test'); return true }).call(c)
  assert.equal(c.confirmCalls, 1)
  assert.equal(calls, 1)
  assert.equal(c.closed, true)
})

test('dialog switch cannot delete newly selected task', async () => {
  const c = context()
  c.$confirm = () => { c.task = { taskId: 'tid_new' }; return Promise.resolve() }
  let calls = 0
  await withDelete(async () => { calls++; return true }).call(c)
  assert.equal(calls, 0)
  assert.equal(c.closed, false)
})

test('repeating tasks use existing scoped confirmation, not direct deletion', async () => {
  const c = context({ taskId: 'tid_repeat' })
  c.isRepeat = true
  let calls = 0
  await withDelete(async () => { calls++; return true }).call(c)
  assert.equal(c.repeatConfirmed, true)
  assert.equal(c.confirmCalls, 0)
  assert.equal(calls, 0)
})
