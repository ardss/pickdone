/** app:// and local:// custom protocol handlers — moved verbatim from index.js (content unchanged)
 *  app://   maps the app root directory (with path traversal protection)
 *  local:// maps the userData/files attachment directory */
const path = require('path')
const fs = require('fs')
const { attachDir, attachmentPath, resolveAttachmentCase } = require('./attachments')

// F3 (2026-10-19): cached realpath of the attachment dir for the local:// symlink-escape check
// (see the handler comment). Null until first resolved; recomputed on transient failure.
let realRoot = null

/* Media elements (audio/video) in newer Chromium (confirmed on Electron 39) require Range support from custom protocols:
   replying with a whole-file 200 makes <audio> fail outright with MEDIA_ERR_SRC_NOT_SUPPORTED (code 4) — white noise/confirm sounds all mute.
   Everything goes through this responder: no Range = 200 full body + Accept-Ranges; with Range = 206 slice. */
async function fileResponse (file, mime, request, extraHeaders) {
  const stat = await fs.promises.stat(file)
  const total = stat.size
  const range = request.headers.Range || request.headers.range
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(String(range).trim())
  const headers = Object.assign({
    'Content-Type': mime,
    'Cache-Control': 'no-cache',
    'Accept-Ranges': 'bytes'
  }, extraHeaders || {})
  if (m && (m[1] !== '' || m[2] !== '')) {
    let start = m[1] === '' ? NaN : parseInt(m[1], 10)
    let end = m[2] === '' ? NaN : parseInt(m[2], 10)
    if (isNaN(start)) { // bytes=-N → tail N bytes
      start = Math.max(0, total - (parseInt(m[2], 10) || 0))
      end = total - 1
    }
    if (isNaN(end) || end >= total) end = total - 1
    if (start > end || start >= total) {
      return new Response('range not satisfiable', { status: 416, headers: { 'Content-Range': 'bytes */' + total } })
    }
    const buf = Buffer.allocUnsafe(end - start + 1)
    const fh = await fs.promises.open(file, 'r')
    // P2 2026-09-12 TOCTOU: stat-then-read raced a concurrent truncation — read()'s bytesRead was
    // discarded and the tail of buf was UNINITIALIZED heap memory sent straight to the renderer.
    let bytesRead = 0
    try { bytesRead = (await fh.read(buf, 0, buf.length, start)).bytesRead } finally { await fh.close() }
    // P2 2026-09-19: the file shrank between stat and read (concurrent truncate/replace) — bytesRead
    // is 0, and the previous header math produced the invalid range "bytes start-(start-1)/total"
    // with an empty 206 body. Range semantics say the request is no longer satisfiable: 416.
    if (bytesRead === 0) {
      return new Response('range not satisfiable', { status: 416, headers: { 'Content-Range': 'bytes */' + total } })
    }
    const out = buf.subarray(0, bytesRead)
    // W18 fix: `total` used to stay the stale stat size even after a concurrent shrink, so the
    // Content-Range could claim "bytes start-end/<old-larger-total>" with a body that stops short —
    // the header then disagrees with reality. The bytes in hand are the ground truth: the resource
    // as served is exactly start + bytesRead long (this is the same contract the 200 path's
    // Content-Length fix below already uses — headers must describe the body actually sent).
    const totalServed = start + bytesRead
    headers['Content-Range'] = 'bytes ' + start + '-' + (start + bytesRead - 1) + '/' + totalServed
    headers['Content-Length'] = String(out.length)
    return new Response(out, { status: 206, headers })
  }
  const data = await fs.promises.readFile(file)
  // P2 2026-09-17 TOCTOU: Content-Length must come from the bytes actually read, not the earlier
  // stat — a concurrent truncate/append between stat and readFile made the header disagree with
  // the body (truncated media / hung downloads). Same fix as the 206 path above.
  headers['Content-Length'] = String(data.length)
  return new Response(data, { status: 200, headers })
}

function handleAppProtocol () {
  const { protocol } = require('electron')
  const root = path.join(__dirname, '../..')
  /** sec-app-protocol: the only install-tree subtrees the renderer may fetch through app://.
   *  Exported for the unit gate (root list drift = the gate must be updated consciously). */
  const APP_ROOTS = ['renderer-dist', 'assets', 'node_modules']
  protocol.handle('app', async (request) => {
    try {
      let u = decodeURIComponent(new URL(request.url).pathname) // /index.html
      if (u.startsWith('/')) u = u.slice(1)
      // Guard against path traversal
      const file = path.normalize(path.join(root, u))
      if (!file.startsWith(root + path.sep)) return new Response('forbidden', { status: 403 })
      // sec-app-protocol (2026-10-02): root allowlist. The handler used to serve the WHOLE install
      // tree — any file under the app root (stray logs, .err drop files, anything shipped next to
      // the executable) came back as 200 octet-stream through app://. Only the three trees the
      // renderer actually loads are served now; everything else is 404. src/preload is NOT a root:
      // the preload script is loaded via a filesystem path (windows.js), not app://.
      // W16 (2026-10-28 P1): the allowlist top-segment used to be read from the RAW decoded u, but
      // path.join/normalize below treats an encoded backslash (%5C) as a real separator on Windows —
      // 'renderer-dist%5C..%5C..%5Csrc%5Cmain%5Cdb.js' had top='renderer-dist' while the resolved
      // file escaped to <root>/src/main/db.js, re-opening the whole install tree (the very hole the
      // 2026-10-02 hardening closed). The decision now runs on the NORMALIZED, root-relative path:
      // a relative path whose first segment is not an allowlisted root (incl. any surviving '..'
      // segment or an absolute escape) can never pass. On POSIX %5C stays a literal filename char
      // and the normalized check is equally strict.
      const rel = path.relative(root, file)
      const segs = rel.split(path.sep)
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel) ||
          segs.some(s => s === '..') || !APP_ROOTS.includes(segs[0])) {
        return new Response('not found', { status: 404 })
      }
      const mime = {
        '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript',
        '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
        '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.ico': 'image/x-icon',
        '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav'
      }[path.extname(file).toLowerCase()] || 'application/octet-stream'
      // Vite hash 产物内容寻址,可永久缓存;vendor ?v= 与其余资源维持 no-cache
      if (/\/renderer-dist\/assets\d*\//.test(u)) return await fileResponse(file, mime, request, { 'Cache-Control': 'public, max-age=31536000, immutable' })
      const headers = { 'Cache-Control': 'no-cache' }
      // Audio/video go through the Range responder (see the fileResponse comment); other resources keep whole-file readFile
      if (/\.(ogg|mp3|wav|mp4|webm)$/i.test(file)) return await fileResponse(file, mime, request, headers)
      // async readFile: every app:// resource request previously read disk synchronously on the main-process main thread; large attachments would stall every window's IPC (audit M6)
      const data = await fs.promises.readFile(file)
      return new Response(data, {
        headers: {
          'Content-Type': mime,
          'Cache-Control': 'no-cache'
        }
      })
    } catch (e) {
      return new Response('not found', { status: 404 })
    }
  })
  // local:// local attachment protocol (maps userData/files)
  protocol.handle('local', async (req) => {
    try {
      // W16 (2026-10-28 P1): two url mint forms arrive here. NEW (saveAttachment since this wave):
      // path form `local:///<encoded-key>` — the key lives in the URL's PATH component, which
      // Chromium preserves verbatim (no lowercasing, no IDNA/punycode transcoding), so decoding
      // recovers the exact on-disk name (fixes Chinese/uppercase paste-image 404s). LEGACY (rows
      // already in the DB): host form `local://<encoded-key>` — the host is lowercased (case
      // fallback below) and non-ASCII hosts were punycoded by Chromium (unrecoverable; those
      // stale rows fall back to the case-insensitive scan / 404 as before). Strip one leading
      // '/' to normalize both forms onto the same key.
      let keyRaw = req.url.slice('local://'.length)
      if (keyRaw.startsWith('/')) keyRaw = keyRaw.slice(1)
      const key = decodeURIComponent(keyRaw)
      let resolved = path.resolve(attachmentPath(key))
      const attachRoot = path.resolve(attachDir())
      if (!(resolved === attachRoot || resolved.startsWith(attachRoot + path.sep))) return new Response('forbidden', { status: 403 }) // 带尾分隔符,防同前缀兄弟目录(2026-09-05 终审 hardening)
      // W16 (2026-10-28 P2): Chromium lowercases the HOST of a standard-scheme url, so a local://
      // key with uppercase can arrive lowercased; on a case-sensitive FS the exact path misses and
      // the request 404'd. Resolve to the real on-disk name (exact hit keeps the path untouched;
      // otherwise the unique case-insensitive basename match) BEFORE the bookkeeping/realpath
      // checks so those see the true file name.
      resolved = resolveAttachmentCase(resolved)
      // P3 F3 (2026-10-19): the lexical check above does not follow symlinks — a symlink inside
      // attachDir pointing at e.g. the user's homedir made the containment test pass while
      // readFile served the target bytes (arbitrary read). Resolve BOTH sides with realpath and
      // compare real paths: an escaped resolution is 403; an unresolvable key (missing file /
      // dangling link) keeps the existing 404 contract. attachRoot's realpath is cached — the
      // attachment dir never moves mid-process; one fs syscall per request for the file itself.
      let real = null
      try { real = await fs.promises.realpath(resolved) } catch { return new Response('nf', { status: 404 }) }
      try { realRoot = realRoot || await fs.promises.realpath(attachRoot) } catch { realRoot = null }
      if (!realRoot || !(real === realRoot || real.startsWith(realRoot + path.sep))) return new Response('forbidden', { status: 403 })
      // Serve the REAL path so a symlink swap between check and read cannot race the decision.
      resolved = real
      // sec-local-protocol (2026-10-02): bookkeeping/tmp files are never served. aliases.json is the
      // LAN conflict alias map (internal state), .att-tmp-* are atomic-write temp files from
      // writeAtomic / att-transfer — neither is user content. Attachment keys minted by
      // saveAttachment and conflict renames never start with '.' and never equal aliases.json, so
      // no legitimate local:// url can land here (see isLocalBookkeepingFile for the unit-tested
      // decision).
      if (isLocalBookkeepingFile(path.basename(resolved))) return new Response('nf', { status: 404 })
      // C13/C15 (2026-09-25): single-source mime table + legacy-svg forced download (see the
      // EXT_MIME/localAttachmentHeaders comment at the bottom of this file).
      const { mime, extraHeaders } = localAttachmentHeaders(resolved)
      // P1 2026-09-12 hardening: local:// serves user-uploaded files, including attacker-shaped SVG
      // (script-bearing). Rendered as <img> SVG never executes script, but a top-level/iframe
      // navigation to local://…svg ran it on a same-app-origin-ish document with fetch access to
      // every other attachment. Kill the script surface on ALL local:// responses; image/media/pdf
      // display is unaffected (those load paths do not execute script). nosniff blocks MIME confusion.
      const secureHeaders = {
        'Content-Security-Policy': "default-src 'none'; script-src 'none'",
        'X-Content-Type-Options': 'nosniff',
        ...extraHeaders
      }
      if (/\.(ogg|mp3|wav|mp4|webm)$/i.test(resolved)) return await fileResponse(resolved, mime, req, secureHeaders)
      const data = await fs.promises.readFile(resolved)
      return new Response(data, { headers: { 'Content-Type': mime, ...secureHeaders } })
    } catch { return new Response('nf', { status: 404 }) }
  })
}

/* ---- C13/C15 (2026-09-25): single-source attachment MIME table + legacy-svg downgrade ----
 * The attachment mime map used to exist TWICE (here and a hand-copied subset in
 * handlers/attachments.js 'mime-get-type') and drifted. attachmentMimeFor is now the only
 * table; the handler consumes it. ALLOWED_EXT (attachments.js) remains the STORAGE whitelist
 * and is untouched — this is the SERVING-side policy only.
 * C15 legacy-svg verdict: D6 removed .svg from the upload whitelist, but svg files that
 * arrived via LAN sync before that fix still sit in userData/files, and extMime served them
 * as image/svg+xml — script-capable markup, one nosniff/CSP regression away from execution
 * on an app-origin document. Serving policy is now forced to application/octet-stream +
 * Content-Disposition: attachment (download, never render), CSP/nosniff headers unchanged.
 * Full ban (404) was weighed and rejected: legitimate legacy assets would silently break;
 * download-only keeps the file reachable with zero script surface. */
const EXT_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', pdf: 'application/pdf', txt: 'text/plain', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm' }
/** sec-local-protocol (2026-10-02, pure): which files inside the attachment dir are internal
 *  bookkeeping and must 404 on local:// — the alias map and atomic-write temp files. Keys minted
 *  by saveAttachment (`<taskId>_<ts>_<name>`) and conflict renames never start with '.' and never
 *  equal aliases.json, so this cannot block real user content. noise-custom.* stays served (the
 *  white-noise feature plays it through local://). */
function isLocalBookkeepingFile (base) {
  const b = String(base)
  return b === 'aliases.json' || /^\.att-tmp-/.test(b)
}

/** MIME for an attachment filename/extension (single source; pure). */
function attachmentMimeFor (name) {
  const ext = String(name).split('.').pop().toLowerCase()
  return EXT_MIME[ext] || 'application/octet-stream'
}
/** Serving policy for one local:// file (pure): { mime, extraHeaders }. Legacy .svg is forced
 *  to a download (octet-stream + attachment disposition) instead of image/svg+xml. */
function localAttachmentHeaders (file) {
  const ext = path.extname(String(file)).slice(1).toLowerCase()
  if (ext === 'svg') {
    const safe = path.basename(String(file)).replace(/["\\\r\n]/g, '')
    return { mime: 'application/octet-stream', extraHeaders: { 'Content-Disposition': 'attachment; filename="' + safe + '"' } }
  }
  return { mime: EXT_MIME[ext] || 'application/octet-stream', extraHeaders: {} }
}

module.exports = { handleAppProtocol, fileResponse, attachmentMimeFor, localAttachmentHeaders, isLocalBookkeepingFile } // fileResponse exported for unit tests (Content-Length invariant)
