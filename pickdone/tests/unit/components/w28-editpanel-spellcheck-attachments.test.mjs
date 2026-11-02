/**
 * W28 maintenance wave (2026-11-01) — edit-panel domain fixes.
 *
 * Fix 1 (P2): editpanel/panelSetup.js dynamicSpellcheckGuard — the guard required the target to
 * already carry a spellcheck attribute before setting it (inverted dead code): dynamically
 * created inputs (subtask rows) never carry one, so the guard did nothing for its raison d'être.
 * Regression: a target WITHOUT the attribute must get spellcheck="false".
 *
 * Fix 4 (P2): edit-panel/attachments.js — a multi-file batch re-read ctx.e.taskId after each
 * file's async work, so a hydrate switching the edited task mid-batch attributed files 2..n to
 * the NEW task. Regression: batch ownership snapshot + abort-on-switch for pickFiles loop and
 * onDescDrop; single-shot onDescPaste passes the snapshot too.
 *
 * Run: node --test tests/unit/components/w28-editpanel-spellcheck-attachments.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

// core.js (pulled in by attachments.js) reads UMD globals off `window` at load, guarded
globalThis.window = globalThis.window || { location: { hash: '' } }

const panelSetup = await import(pathToFileURL(path.join(ROOT, 'renderer/js/components/editpanel/panelSetup.js')).href)
const attachments = await import(pathToFileURL(path.join(ROOT, 'renderer/js/components/edit-panel/attachments.js')).href)

/* ---------- Fix 1: spellcheck guard ---------- */

test('[w28.1] dynamicSpellcheckGuard sets spellcheck=false on an input WITHOUT the attribute (was inverted dead code)', () => {
  const handler = panelSetup.dynamicSpellcheckGuard()
  const sets = []
  const t = { tagName: 'INPUT', setAttribute: (k, v) => sets.push([k, v]) }
  handler({ target: t })
  assert.deepEqual(sets, [['spellcheck', 'false']])
})

test('[w28.1] guard still covers TEXTAREA and stays a no-op for other targets', () => {
  const handler = panelSetup.dynamicSpellcheckGuard()
  const sets = []
  const ta = { tagName: 'TEXTAREA', setAttribute: (k, v) => sets.push([k, v]) }
  handler({ target: ta })
  assert.deepEqual(sets, [['spellcheck', 'false']])
  const div = { tagName: 'DIV', setAttribute: () => { throw new Error('must not touch non-inputs') } }
  handler({ target: div })
  handler({ target: null })
  handler({})
  assert.equal(sets.length, 1)
})

/* ---------- Fix 4: batch upload ownership ---------- */

function makeCtx (taskId) {
  const calls = []
  return {
    calls,
    deleted: [],
    e: { taskId },
    imgList: [],
    fileList: [],
    markDirty () {},
    queueSave () {},
    scrollImgsIntoView () {},
    $message: { error () {} },
    $t: k => k
  }
}

function stubUpload (ctx, afterFirst) {
  let n = 0
  globalThis.window.todoAPI = {
    uploadAttachment: async ({ taskId, name }) => {
      calls = ctx.calls; calls.push({ taskId, name })
      n++
      if (n === 1 && afterFirst) afterFirst()
      return { url: 'local:///' + name, size: 1 }
    },
    deleteFile: async url => { ctx.deleted.push(url); return true }
  }
}
let calls

const file = name => new File(['x'], name, { type: 'image/png' })

test('[w28.4] onDescDrop batch: task switch mid-upload aborts remaining files — none land on the new task', async () => {
  const ctx = makeCtx('task-A')
  stubUpload(ctx, () => { ctx.e.taskId = 'task-B' }) // hydrate switches task after file 1
  const dt = { dataTransfer: { files: [file('one.png'), file('two.png'), file('three.png')] } }
  await attachments.onDescDrop(ctx, dt)
  assert.equal(ctx.calls.length, 1, 'uploads stop after the switch')
  assert.equal(ctx.calls[0].taskId, 'task-A', 'the one completed upload keeps its original owner')
  assert.equal(ctx.imgList.length, 0, 'completed upload for task A must never appear in task B panel')
  assert.deepEqual(ctx.deleted, ['local:///one.png'], 'unattached minted file must be cleaned')
})

test('[w28.4] onDescDrop batch with NO task switch uploads every file (behavior unchanged)', async () => {
  const ctx = makeCtx('task-A')
  stubUpload(ctx, null)
  const dt = { dataTransfer: { files: [file('one.png'), file('two.png')] } }
  await attachments.onDescDrop(ctx, dt)
  assert.equal(ctx.calls.length, 2)
  assert.ok(ctx.calls.every(c => c.taskId === 'task-A'))
  assert.equal(ctx.imgList.length, 2)
  assert.deepEqual(ctx.deleted, [], 'successful uploads must not be deleted')
})

test('[w28.4] onDescPaste: upload carries the taskId snapshotted at entry, not the post-hydrate one', async () => {
  const ctx = makeCtx('task-A')
  stubUpload(ctx, () => { ctx.e.taskId = 'task-B' })
  const item = { type: 'image/png', getAsFile: () => file('paste.png') }
  await attachments.onDescPaste(ctx, { clipboardData: { items: [item] }, preventDefault () {} })
  assert.equal(ctx.calls.length, 1)
  assert.equal(ctx.calls[0].taskId, 'task-A', 'paste must not re-read ctx.e.taskId after awaiting')
  assert.equal(ctx.imgList.length, 0, 'paste finishing after a task switch must not pollute task B')
  assert.deepEqual(ctx.deleted, ['local:///paste.png'])
})

test('[w28.4] direct uploadOne (no snapshot arg) still attributes to the current task; failed upload does not strand the batch', async () => {
  const ctx = makeCtx('task-A')
  stubUpload(ctx, null)
  await attachments.uploadOne(ctx, 'img', file('solo.png'))
  assert.equal(ctx.calls[0].taskId, 'task-A')
  // oversized file throws inside _uploadOne -> uploadOne reports and returns true (batch continues)
  const big = { size: 51 * 1024 * 1024, name: 'big.png', type: 'image/png', arrayBuffer: async () => new ArrayBuffer(8) }
  const cont = await attachments.uploadOne(ctx, 'img', big)
  assert.equal(cont, true)
  assert.equal(ctx.calls.length, 1, 'oversize file never hits IPC')
})
