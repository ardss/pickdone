/**
 * EditPanel attachments orchestration — extracted from EditPanel.vue (maint/dw-arch 2026-09-24, D1 knife 2).
 *
 * Pure move, zero behavior change: every function takes the component as `ctx` and reads/writes
 * the same state (imgList/fileList/e) through it. The protocol is unchanged — EpAttachments only
 * EMITS pick/preview/remove; the parent owns the lists and funnels mutations through queueSave.
 * scrollImgsIntoView stays on the component (focus/scroll timing is knife 4's concern);
 * onDescPaste/onDescDrop invoke it via ctx exactly as before.
 */
import { reportError } from '../../utils/core.js'

export function pickFiles (ctx, kind) {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  if (kind === 'img') input.accept = 'image/*'
  // P2 fix (2026-09-25): serialize the uploads — the old fire-and-forget loop raced uploadOne
  // calls, landing thumbnails out of pick order (and interleaving queueSave writes)
  input.onchange = async () => {
    // [w28 P2 fix 2026-11-01] snapshot the owning task once per batch: a hydrate that switches the
    // edited task while a slow upload awaits must not land the remaining files on the NEW task.
    const ownerTaskId = currentTaskId(ctx)
    for (const f of input.files) {
      if (!await uploadOne(ctx, kind, f, ownerTaskId)) break
    }
  }
  input.click()
}

export async function onDescPaste (ctx, e) {
  // [w28 P2 fix] same ownership snapshot discipline as the batch loops (see pickFiles)
  const ownerTaskId = currentTaskId(ctx)
  const items = e.clipboardData ? e.clipboardData.items : []
  // P0 fix (2026-09-25): DataTransferItemList is an indexed collection with NO .filter — calling
  // items.filter threw a TypeError before preventDefault could run, so image paste was dead.
  // Convert to a real array first.
  // The same clipboard image often carries multiple format entries (png/jpeg/bmp coexist); accepting all would upload duplicate image tiles; take only the first usable bitmap, png preferred
  const imgItems = Array.from(items).filter(i => i.type.startsWith('image/'))
  if (!imgItems.length) return
  e.preventDefault()
  const pick = imgItems.find(i => i.type === 'image/png') || imgItems[0]
  const f = pick.getAsFile()
  if (f) await uploadOne(ctx, 'img', new File([f], f.name || 'clipboard.' + (pick.type.split('/')[1] || 'png'), { type: pick.type }), ownerTaskId)
  ctx.scrollImgsIntoView()
}

export async function onDescDrop (ctx, e) {
  // [w28 P2 fix] snapshot before the await-loop, abort the remainder on task switch
  const ownerTaskId = currentTaskId(ctx)
  const files = e.dataTransfer ? e.dataTransfer.files : []
  for (const f of files) {
    if (f.type.startsWith('image/')) {
      if (!await uploadOne(ctx, 'img', f, ownerTaskId)) break
      ctx.scrollImgsIntoView()
    } else {
      // P2 fix (2026-09-25): non-image files were silently swallowed — route them to the
      // file-attachment list instead of pretending the drop never happened
      if (!await uploadOne(ctx, 'file', f, ownerTaskId)) break
    }
  }
}

// [w28 P2 fix 2026-11-01] the edit-panel edit state (`ctx.e`) is re-hydrated wholesale when the
// user switches tasks; `_uploadOne` used to re-read `ctx.e.taskId` AFTER each file's async
// arrayBuffer/base64 work, so files 2..n of a batch could be attributed to whichever task was
// open by the time their turn came. Every upload in a batch now carries the taskId captured at
// batch entry and aborts if the panel has moved on.
function currentTaskId (ctx) { return ctx.e ? ctx.e.taskId : undefined }

export async function uploadOne (ctx, kind, f, ownerTaskId) {
  try {
    return await _uploadOne(ctx, kind, f, ownerTaskId)
  } catch (err) {
    reportError('upload:' + f.name, err)
    ctx.$message.error(ctx.$t('statsJ.EditPanel.uploadFailedMsg') + f.name)
    return true // a failed upload must not strand the rest of the batch (pre-existing semantics)
  }
}

// [maint-0925 A7/C7] mirrors src/main/attachments.js MAX_BYTES (50MB): reject oversize files in the
// renderer BEFORE reading arrayBuffer / hitting IPC — the old path base64-encoded a 65MB paste into
// memory just to have the main process throw it away
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

async function _uploadOne (ctx, kind, f, ownerTaskId) {
  if (f && f.size > MAX_UPLOAD_BYTES) {
    throw new Error('attachment too large (max 50MB): ' + f.name)
  }
  const taskId = ownerTaskId !== undefined ? ownerTaskId : currentTaskId(ctx)
  const buf = new Uint8Array(await f.arrayBuffer())
  let binary = ''
  for (let i = 0; i < buf.length; i += 0x8000) binary += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000))
  // Ownership re-check AFTER the async work: if the panel switched tasks while we awaited,
  // this file belongs to the OLD task's batch — drop it rather than mis-attribute it.
  if (currentTaskId(ctx) !== taskId) return false
  const res = await window.todoAPI.uploadAttachment({ taskId, name: f.name, dataBase64: btoa(binary), type: f.type })
  const item = { url: res.url, name: f.name, size: res.size }
  if (kind === 'img') { ctx.imgList.push(item); ctx.markDirty('imgs') } else { ctx.fileList.push(item); ctx.markDirty('files') }
  ctx.queueSave({})
  return true
}
