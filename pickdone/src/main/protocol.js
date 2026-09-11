/** app:// and local:// custom protocol handlers — moved verbatim from index.js (content unchanged)
 *  app://   maps the app root directory (with path traversal protection)
 *  local:// maps the userData/files attachment directory */
const path = require('path')
const fs = require('fs')
const { attachDir, attachmentPath } = require('./attachments')

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
    const out = buf.subarray(0, bytesRead)
    headers['Content-Range'] = 'bytes ' + start + '-' + (start + bytesRead - 1) + '/' + total
    headers['Content-Length'] = String(out.length)
    return new Response(out, { status: 206, headers })
  }
  const data = await fs.promises.readFile(file)
  headers['Content-Length'] = String(total)
  return new Response(data, { status: 200, headers })
}

function handleAppProtocol () {
  const { protocol } = require('electron')
  const root = path.join(__dirname, '../..')
  protocol.handle('app', async (request) => {
    try {
      let u = decodeURIComponent(new URL(request.url).pathname) // /index.html
      if (u.startsWith('/')) u = u.slice(1)
      // Guard against path traversal
      const file = path.normalize(path.join(root, u))
      if (!file.startsWith(root + path.sep)) return new Response('forbidden', { status: 403 })
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
      const key = decodeURIComponent(req.url.slice('local://'.length))
      const resolved = path.resolve(attachmentPath(key))
      const attachRoot = path.resolve(attachDir())
      if (!(resolved === attachRoot || resolved.startsWith(attachRoot + path.sep))) return new Response('forbidden', { status: 403 }) // 带尾分隔符,防同前缀兄弟目录(2026-09-05 终审 hardening)
      const extMime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', pdf: 'application/pdf', txt: 'text/plain', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm' }
      const mime = extMime[path.extname(resolved).slice(1).toLowerCase()] || 'application/octet-stream'
      // P1 2026-09-12 hardening: local:// serves user-uploaded files, including attacker-shaped SVG
      // (script-bearing). Rendered as <img> SVG never executes script, but a top-level/iframe
      // navigation to local://…svg ran it on a same-app-origin-ish document with fetch access to
      // every other attachment. Kill the script surface on ALL local:// responses; image/media/pdf
      // display is unaffected (those load paths do not execute script). nosniff blocks MIME confusion.
      const secureHeaders = {
        'Content-Security-Policy': "default-src 'none'; script-src 'none'",
        'X-Content-Type-Options': 'nosniff'
      }
      if (/\.(ogg|mp3|wav|mp4|webm)$/i.test(resolved)) return await fileResponse(resolved, mime, req, secureHeaders)
      const data = await fs.promises.readFile(resolved)
      return new Response(data, { headers: { 'Content-Type': mime, ...secureHeaders } })
    } catch { return new Response('nf', { status: 404 }) }
  })
}

module.exports = { handleAppProtocol }
