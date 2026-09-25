'use strict'
/** Attachment-domain entry guards (C5/C12/C14 architecture wave, 2026-09-25).
 *
 *  Root cause this module answers: the attachment domain had THREE renderer-reachable write
 *  entries (upload-attachment, the white-noise pick copy, delete-file) plus a LAN sync ingress,
 *  and the per-file size cap + storage quota only existed in saveAttachment — the white-noise
 *  pick copied ANY picked file straight into userData/files with no size or quota gate at all.
 *  Every WRITE entry now funnels through assertWriteAllowed here; the caps themselves stay
 *  single-sourced in attachments.js (MAX_BYTES / MAX_TOTAL_BYTES / MAX_FILES and the pure
 *  withinStorageQuota / dirTotalBytes / dirUsage gates). delete-file is a REMOVE entry and
 *  deliberately needs no size gate.
 *
 *  Pure-node testable: attachments.js tolerates a missing electron (only attachDir touches
 *  app.getPath), so these gates run under plain `node --test` with an explicit dir. */
const fs = require('fs')
const attachments = require('./attachments')

/** Shared write gate: per-file size cap + aggregate storage quota + file-count cap.
 *  Messages mirror the historical saveAttachment wording — renderer + tests match on
 *  /too large/, /storage quota exceeded/, /too many attachment files/. */
function assertWriteAllowed ({ incomingBytes, dir }) {
  if (!Number.isFinite(incomingBytes) || incomingBytes <= 0) throw new Error('attachment: empty')
  if (incomingBytes > attachments.MAX_BYTES) throw new Error('attachment: too large (max 50MB)')
  if (!attachments.withinStorageQuota(attachments.dirTotalBytes(dir), incomingBytes)) throw new Error('attachment: storage quota exceeded (max 64MB total)')
  const { count } = attachments.dirUsage(dir)
  if (count >= attachments.MAX_FILES) throw new Error('attachment: too many attachment files (max 200)')
}

/** C5: white-noise pick entry. The picked source file is stat'd BEFORE the copy so an
 *  over-size (or vanished / non-regular) source is refused while NOTHING has landed in the
 *  attachment dir — the old code went straight to copyFile with zero checks. */
function assertWhiteNoiseCopyAllowed (srcPath, dir) {
  const st = fs.statSync(srcPath) // ENOENT for a vanished pick: same failure copyFile would hit, just earlier
  if (!st.isFile()) throw new Error('white-noise: not a regular file')
  assertWriteAllowed({ incomingBytes: st.size, dir })
}

module.exports = { assertWriteAllowed, assertWhiteNoiseCopyAllowed }
