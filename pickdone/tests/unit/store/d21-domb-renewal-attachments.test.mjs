/**
 * D21-DOMB B1 regression: the App's completion-renewal (store/todo.js ensureNextRepeatInstance)
 * must carry attachments onto the renewed instance. renewalCarryFields (shared/repeat-core.mjs)
 * already provides image/files and the CLI twin spreads them; the addTodo payload used to omit
 * todoImage/fileList, so a repeated task's attachments silently vanished on renewal.
 *
 * Two layers:
 *  1. behavioral — addTodo maps todoImage/fileList onto the persisted row's image/files
 *  2. source pin — ensureNextRepeatInstance's payload passes carry.image/carry.files through
 * Run: node --test tests/unit/store/d21-domb-renewal-attachments.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LS = {}
if (!globalThis.localStorage) {
  globalThis.localStorage = {
    getItem: k => (k in LS ? LS[k] : null),
    setItem: (k, v) => { LS[k] = String(v) },
    removeItem: k => { delete LS[k] }
  }
}
globalThis.window.location = { hash: '' }
globalThis.window.todoAPI = { dbCall: async () => null }

const todoMod = await import('../../../renderer/js/store/todo.js')
const todoActions = todoMod.default.actions

test('behavioral: addTodo persists todoImage/fileList as image/files', async () => {
  let stored = null
  const ctx = {
    state: { todoList: [] },
    rootState: { settings: { newTodoDefaultSort: 'top' }, auth: { user: { userId: 'u' } } },
    commit: () => {},
    dispatch: async (name, p) => { if (name === 'scheduleReminder') stored = null }
  }
  const t = await todoActions.addTodo.call({}, ctx, {
    todoContent: 'd21 renew attach', todoImage: '[{"url":"local://a.png"}]', fileList: '[{"url":"local://b.pdf"}]'
  })
  assert.equal(t.image, '[{"url":"local://a.png"}]', 'todoImage -> row.image')
  assert.equal(t.files, '[{"url":"local://b.pdf"}]', 'fileList -> row.files')
  void stored
})

test('source pin: ensureNextRepeatInstance maps carry.image/carry.files into the addTodo payload', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../renderer/js/store/todo.js'), 'utf8')
  const fn = src.slice(src.indexOf('async ensureNextRepeatInstance'), src.indexOf('async reorderTodos'))
  assert.ok(fn.includes('todoImage: carry.image'), 'payload must pass carry.image (renewalCarryFields)')
  assert.ok(fn.includes('fileList: carry.files'), 'payload must pass carry.files (renewalCarryFields)')
})
