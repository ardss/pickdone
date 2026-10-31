/**
 * W23 (2026-10-31) paste-image render chain — end-to-end regression for the beta.22
 * "粘贴图片上去还是列图" report. Covers every hop of the packaged paste path plus the two
 * W23 fixes:
 *   1. upload: saveAttachment mints a PATH-form local:// url (W16) → attachmentKeyOfUrl
 *      roundtrips it → isRenderableAttachmentUrl accepts it (renderer gate).
 *   2. serve: localAttachmentHeaders answers a per-extension Content-Type for that minted
 *      file (the ae922caf octet-stream fix) — png/jpeg/gif must be image/*, not octet-stream.
 *   3. registration: 'local' scheme privileges registered at module top (before 'ready') and
 *      handleAppProtocol() runs before createMainWindow() in index.js (packaged included).
 *   4. fix 1: EpAttachments non-local placeholder cell is labeled (filename + attachmentMissing
 *      hint) — no longer a featureless gray block.
 *   5. fix 2: TodoItem listThumbs computed renders ONLY local:// urls (beacon contract) with a
 *      count badge; non-local synced rows never get a :src.
 *
 * Run: node --test tests/unit/components/w23-paste-render-chain.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { Module, createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/* ---------- electron stub (same pattern as tests/unit/main/attachments-micro-coverage) ---------- */
const TMP = fs_mkdtemp()
function fs_mkdtemp () { return mkdtempSync(path.join(os.tmpdir(), 'w23-chain-')) }
const ELECTRON_STUB = {
  app: { getPath: () => TMP, isPackaged: false, getVersion: () => '0.0.0-test' },
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} }
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const require = createRequire(import.meta.url)

/* renderer core.js touches window/localStorage at module load (i18n chain) — stub first */
globalThis.window = globalThis.window || { location: { hash: '' } }
globalThis.localStorage = globalThis.localStorage || {
  getItem: () => null, setItem: () => {}, removeItem: () => {}
}

const A = await import('../../../src/main/attachments.js')
const P = await import('../../../src/main/protocol.js')
const core = await import('../../../renderer/js/utils/core.js')

/* ---------- 1. upload hop: paste-shaped payload → path-form local:// url ---------- */
// 1x1 png bytes
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('chain/upload: saveAttachment (the upload-attachment IPC backend) mints a renderable path-form local:// url', async () => {
  const res = await A.saveAttachment({ taskId: 't_w23', name: 'clipboard.png', dataBase64: PNG_B64 })
  assert.match(res.url, /^local:\/\/\//, 'W16 path form: key in the URL path component')
  const key = A.attachmentKeyOfUrl(res.url)
  assert.equal(key, res.key, 'attachmentKeyOfUrl roundtrips the minted url to the on-disk name')
  assert.ok(core.isRenderableAttachmentUrl(res.url), 'renderer gate accepts the minted url — <img> will render it')
  // legacy host-form rows must keep resolving through the same rules
  assert.equal(A.attachmentKeyOfUrl('local://' + encodeURIComponent(res.key)), res.key)
})

/* ---------- 2. serve hop: Content-Type per extension (ae922caf fix regression) ---------- */
test('chain/serve: localAttachmentHeaders answers per-extension image Content-Type, not octet-stream', () => {
  const { attachDir } = A
  for (const [name, want] of [['clipboard.png', 'image/png'], ['pic.jpg', 'image/jpeg'], ['pic.jpeg', 'image/jpeg'], ['anim.gif', 'image/gif'], ['shot.webp', 'image/webp']]) {
    const p = path.join(attachDir(), name)
    require('fs').writeFileSync(p, 'x')
    const { mime, extraHeaders } = P.localAttachmentHeaders(p)
    assert.equal(mime, want, name + ' must serve as ' + want)
    assert.deepEqual(extraHeaders, {}, 'plain images carry no download disposition')
  }
  // unknown ext keeps the honest octet-stream fallback
  const bin = path.join(A.attachDir(), 'blob.bin')
  require('fs').writeFileSync(bin, 'x')
  assert.equal(P.localAttachmentHeaders(bin).mime, 'application/octet-stream')
})

/* ---------- 3. registration hop: scheme privileges + handler ordering (packaged path) ---------- */
test('chain/registration: local:// privileges load at module top; handleAppProtocol runs before createMainWindow', () => {
  const idxSrc = readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8')
  assert.match(idxSrc, /require\('\.\/protocol-privileges'\)/, 'privileges registered before app ready (module top)')
  const privSrc = readFileSync(path.join(ROOT, 'src/main/protocol-privileges.js'), 'utf8')
  assert.match(privSrc, /scheme:\s*'local'/, 'local scheme is in the privileged list')
  assert.match(privSrc, /standard:\s*true/, 'local is standard (path component preserved — W16)')
  // ordering: inside the whenReady chain, the handleAppProtocol() call must precede createMainWindow()
  const readyAt = idxSrc.indexOf('app.whenReady()')
  assert.ok(readyAt !== -1, 'whenReady entry found')
  const callAt = idxSrc.indexOf('handleAppProtocol()', readyAt)
  const winAt = idxSrc.indexOf('createMainWindow()', readyAt)
  assert.ok(callAt !== -1 && winAt !== -1, 'both calls exist')
  assert.ok(callAt < winAt, 'protocol handler registered BEFORE the first window loads (packaged included)')
  const protoSrc = readFileSync(path.join(ROOT, 'src/main/protocol.js'), 'utf8')
  assert.match(protoSrc, /protocol\.handle\('local'/, 'local:// protocol handler is registered')
})

/* ---------- 4. fix 1: the synced non-local placeholder cell is labeled ---------- */
async function loadEpComponent () {
  const src = readFileSync(path.join(ROOT, 'renderer/js/components/edit-panel/EpAttachments.vue'), 'utf8')
  const m = src.match(/<script lang="ts">([\s\S]*?)<\/script>/)
  assert.ok(m, 'script block found')
  let js = m[1].replace(/ as (any|HTMLElement)\b/g, '')
  const dir = mkdtempSync(path.join(os.tmpdir(), 'w23-ep-'))
  writeFileSync(path.join(dir, 'logger-stub.mjs'), `
const calls = []
export const logger = { info: () => {}, warn: () => {}, error: () => {}, flush: () => {} }
export const __calls = calls
`)
  js = js.replace("from '../../utils/logger.js'", "from './logger-stub.mjs'")
  js = js.replace(/from '((?:\.\.\/)+[^']+)'/g,
    (_, rel) => `from '${pathToFileURL(path.join(ROOT, 'renderer/js/components/edit-panel', rel)).href}'`)
  writeFileSync(path.join(dir, 'component.mjs'), js)
  const mod = await import(pathToFileURL(path.join(dir, 'component.mjs')).href)
  return mod.default
}

test('fix1: remote placeholder shows filename + attachmentMissing hint (no more blank gray cell)', async () => {
  const comp = await loadEpComponent()
  const tpl = readFileSync(path.join(ROOT, 'renderer/js/components/edit-panel/EpAttachments.vue'), 'utf8')
  assert.match(tpl, /ep-img-remote__name/, 'placeholder renders a filename line')
  assert.match(tpl, /ep-img-remote__hint/, 'placeholder renders a hint line')
  assert.match(tpl, /attachmentMissing/, 'hint reuses the existing not-synced-yet i18n key')
  // the placeholder must NOT bind :src (beacon contract) and must not emit preview
  const elseBranch = tpl.match(/v-else class="ep-img-btn ep-img-remote"[\s\S]*?<b class="x close-x/)[0]
  assert.ok(!/:src=/.test(elseBranch), 'placeholder keeps no :src binding — no network beacon')
  assert.ok(!/\$emit\('preview'/.test(elseBranch), 'placeholder emits no preview')
  // name resolution: stored name first, decoded url basename as fallback
  assert.equal(comp.methods.remotePlaceholderName({ name: '截图.png', url: 'https://x/y.png' }), '截图.png')
  assert.equal(comp.methods.remotePlaceholderName({ url: 'https://cdn.example.com/a%20b.png' }), 'a b.png')
  assert.equal(comp.methods.remotePlaceholderName({ url: 'local:///%E5%9B%BE.png' }), '图.png')
  assert.equal(comp.methods.remotePlaceholderName({ url: 'local://bad%zz.png' }), 'bad%zz.png', 'malformed encoding falls back to raw')
})

/* ---------- 5. fix 2: list-row thumbnail gate + count badge ---------- */
function loadTodoItemComputed () {
  const src = readFileSync(path.join(ROOT, 'renderer/js/components/TodoItem.vue'), 'utf8')
  const m = src.match(/listThumbs \(\) \{([\s\S]*?)\n\s{4}\},/)
  assert.ok(m, 'listThumbs computed found')
  return new Function('isRenderableAttachmentUrl', 'todo', 'return (function () {' + m[1] + '}).call({ todo })')
    .bind(null, core.isRenderableAttachmentUrl)
}

test('fix2: listThumbs renders only local:// urls (beacon contract) — first image + count', () => {
  const run = loadTodoItemComputed()
  const row = {
    image: JSON.stringify([
      { url: 'https://evil.example/track.png', name: 'track.png' },
      { url: 'local:///a.png', name: 'a.png' },
      { url: 'data:image/png;base64,AAAA', name: 'inline.png' },
      { url: 'local:///b.jpg', name: 'b.jpg' }
    ])
  }
  const thumbs = run(row)
  assert.equal(thumbs.length, 2, 'non-local / data: urls never become list thumbnails (no beacon)')
  assert.equal(thumbs[0].url, 'local:///a.png')
  // badge count derives from the same list: template shows listThumbs.length when >1
  assert.equal(thumbs.length > 1, true)
  assert.equal(run({ image: 'not-json' }).length, 0)
  assert.equal(run({ image: null }).length, 0)
  // the dead computed is gone and the template actually renders the thumb
  const tpl = readFileSync(path.join(ROOT, 'renderer/js/components/TodoItem.vue'), 'utf8')
  assert.match(tpl, /td-imgthumb/, 'row renders an inline thumbnail')
  assert.match(tpl, /td-imgthumb__n/, 'multi-image count badge present')
  assert.match(tpl, /is-broken/, 'broken-load fallback class present')
  assert.doesNotMatch(tpl, /img \(\) \{ return firstImageOfList/, 'the dead img computed is removed')
})
