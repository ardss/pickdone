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
  input.onchange = async () => { for (const f of input.files) await uploadOne(ctx, kind, f) }
  input.click()
}

export async function onDescPaste (ctx, e) {
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
  if (f) await uploadOne(ctx, 'img', new File([f], f.name || 'clipboard.' + (pick.type.split('/')[1] || 'png'), { type: pick.type }))
  ctx.scrollImgsIntoView()
}

export async function onDescDrop (ctx, e) {
  const files = e.dataTransfer ? e.dataTransfer.files : []
  for (const f of files) {
    if (f.type.startsWith('image/')) {
      await uploadOne(ctx, 'img', f)
      ctx.scrollImgsIntoView()
    } else {
      // P2 fix (2026-09-25): non-image files were silently swallowed — route them to the
      // file-attachment list instead of pretending the drop never happened
      await uploadOne(ctx, 'file', f)
    }
  }
}

export async function uploadOne (ctx, kind, f) {
  try {
    await _uploadOne(ctx, kind, f)
  } catch (err) { reportError('upload:' + f.name, err); ctx.$message.error(ctx.$t('statsJ.EditPanel.uploadFailedMsg') + f.name) }
}

// [maint-0925 A7/C7] mirrors src/main/attachments.js MAX_BYTES (50MB): reject oversize files in the
// renderer BEFORE reading arrayBuffer / hitting IPC — the old path base64-encoded a 65MB paste into
// memory just to have the main process throw it away
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

async function _uploadOne (ctx, kind, f) {
  if (f && f.size > MAX_UPLOAD_BYTES) {
    throw new Error('attachment too large (max 50MB): ' + f.name)
  }
  const buf = new Uint8Array(await f.arrayBuffer())
  let binary = ''
  for (let i = 0; i < buf.length; i += 0x8000) binary += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000))
  const res = await window.todoAPI.uploadAttachment({ taskId: ctx.e.taskId, name: f.name, dataBase64: btoa(binary), type: f.type })
  const item = { url: res.url, name: f.name, size: res.size }
  if (kind === 'img') { ctx.imgList.push(item); ctx.markDirty('imgs') } else { ctx.fileList.push(item); ctx.markDirty('files') }
  ctx.queueSave({})
}
