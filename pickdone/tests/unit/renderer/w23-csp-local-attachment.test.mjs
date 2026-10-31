/**
 * W23 regression: the renderer CSP must keep the app's own attachment protocol `local:`
 * in img-src / connect-src / media-src / default-src.
 *
 * Root cause (裂图 2026-10-03 → 10-31): 74cb8378 tightened renderer/index.html's CSP and
 * dropped `local:` — every pasted/attached image was CSP-blocked in the renderer BEFORE the
 * local:// protocol handler ever ran (upload + disk write + url all fine; the <img> just
 * errored). Verified end-to-end via CDP on the packaged build: upload → RENDER-ERR with a
 * CSP violation log; after this fix → RENDER-OK. Source-shape test (same style as the other
 * index.html anchors) so the next CSP tightening cannot drop it again.
 * Run: node --test tests/unit/renderer/w23-csp-local-attachment.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..')
const html = readFileSync(join(ROOT, 'renderer', 'index.html'), 'utf8')
const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)
const csp = meta ? meta[1] : ''

test('renderer CSP exists and is the meta tag we pin', () => {
  assert.ok(meta, 'the CSP meta tag must be present in renderer/index.html')
})

test('local: stays allowed for images (pasted/attached thumbnails)', () => {
  const imgSrc = (csp.match(/img-src [^;]+/) || [])[0] || ''
  assert.match(imgSrc, /\blocal:/, `img-src must contain local: — got "${imgSrc}"`)
})

test('local: stays allowed for fetch (attachment upload/preview channels)', () => {
  const connectSrc = (csp.match(/connect-src [^;]+/) || [])[0] || ''
  assert.match(connectSrc, /\blocal:/, `connect-src must contain local: — got "${connectSrc}"`)
})

test('local: stays allowed for media (audio/video attachments) and default-src', () => {
  const mediaSrc = (csp.match(/media-src [^;]+/) || [])[0] || ''
  assert.match(mediaSrc, /\blocal:/, `media-src must contain local: — got "${mediaSrc}"`)
  assert.match(csp, /default-src [^;]*\blocal:/, 'default-src must contain local:')
})

test('script-src must NOT gain local: (the containment boundary stays)', () => {
  const scriptSrc = (csp.match(/script-src [^;]+/) || [])[0] || ''
  assert.doesNotMatch(scriptSrc, /\blocal:/, 'script-src must never allow local:')
})
