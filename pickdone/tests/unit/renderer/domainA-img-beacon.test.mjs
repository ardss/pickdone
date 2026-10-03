/**
 * sec-synced-remote-img-beacon — regression test.
 *
 * Reality: synced remote `image` urls render as <img :src="im.url"> (EpAttachments thumbnails)
 * and the EditPanel preview <img :src="previewImg"> — every paint of a synced row with a remote
 * url was a tracking beacon to the attacker-chosen host. Fix: exported pure
 * isRenderableAttachmentUrl(url) in utils/core.js (local:// only — the ONLY url shape the app
 * mints: saveAttachment returns `local://<encoded-key>`), guarding both render points. The
 * imgList itself must NOT be stripped (EditPanel.vue JSON.stringify's it back into the unified
 * save pipeline — dropping entries would delete the peer's attachment record on next save).
 *
 * Red before the fix: isRenderableAttachmentUrl missing → import fails; :src bound unconditionally.
 * Run: node --test tests/unit/renderer/domainA-img-beacon.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
if (!globalThis.window) globalThis.window = { location: { hash: '' }, todoAPI: {} }

const { isRenderableAttachmentUrl } = await import('../../../renderer/js/utils/core.js')

test('isRenderableAttachmentUrl: local:// only', () => {
  assert.equal(isRenderableAttachmentUrl('local://t1_1_a.png'), true)
  assert.equal(isRenderableAttachmentUrl('local://' + encodeURIComponent('a b.png')), true)
  assert.equal(isRenderableAttachmentUrl('https://evil.example/beacon.png'), false)
  assert.equal(isRenderableAttachmentUrl('http://evil.example/x.png'), false)
  assert.equal(isRenderableAttachmentUrl('//evil.example/x.png'), false, 'protocol-relative is not local')
  assert.equal(isRenderableAttachmentUrl('app://app/assets/img/x.png'), false, 'app resources are not attachments')
  assert.equal(isRenderableAttachmentUrl('data:image/png;base64,AAAA'), false)
  assert.equal(isRenderableAttachmentUrl('img/relative.png'), false)
  assert.equal(isRenderableAttachmentUrl(undefined), false)
  assert.equal(isRenderableAttachmentUrl(null), false)
  assert.equal(isRenderableAttachmentUrl(42), false)
})

test('render path: EpAttachments binds :src only inside the isRenderableAttachmentUrl-gated branch and preview cannot fire for non-local urls', () => {
  const src = read('renderer/js/components/edit-panel/EpAttachments.vue')
  // the imgList v-for cell must gate the real thumbnail on the pure guard
  assert.ok(src.includes('v-if="isRenderableAttachmentUrl(im.url)"'),
    'thumbnail branch must be guarded by isRenderableAttachmentUrl(im.url)')
  // exactly one :src binding for im.url, and it must live on the guarded button
  const srcBindings = src.match(/:src="im\.url"/g) || []
  assert.equal(srcBindings.length, 1, 'exactly one :src="im.url" binding')
  const guardedButton = src.match(/<button v-if="isRenderableAttachmentUrl\(im\.url\)"[\s\S]*?:src="im\.url"/)
  assert.ok(guardedButton, ':src="im.url" must sit on the guarded button')
  // the non-local branch must be an inert placeholder: no src binding, no preview emit
  const elseSpan = src.match(/<span v-else[\s\S]*?>/)
  assert.ok(elseSpan, 'non-local entries get an inert placeholder cell')
  assert.ok(!elseSpan[0].includes(':src'), 'placeholder must not bind :src')
  // preview may only be emitted from the guarded button (which v-if excludes for non-local)
  const previewEmits = src.match(/\$emit\('preview'[^)]*\)/g) || []
  assert.equal(previewEmits.length, 1, "exactly one 'preview' emit site")
  assert.ok(/v-if="isRenderableAttachmentUrl\(im\.url\)"[^`]*@click="\$emit\('preview'/.test(src) ||
    src.indexOf('v-if="isRenderableAttachmentUrl(im.url)"') < src.indexOf("$emit('preview'"),
    "'preview' emit must be inside the guarded branch")
})

test('render path: EditPanel preview <img> is defensively guarded (never binds :src to a non-local url)', () => {
  const src = read('renderer/js/components/EditPanel.vue')
  const imgTag = src.match(/<img [^>]*:src="previewImg"/)
  assert.ok(imgTag, 'preview img tag present')
  // the guarded img must carry v-if="isRenderableAttachmentUrl(previewImg)"
  assert.ok(/<img v-if="isRenderableAttachmentUrl\(previewImg\)" :src="previewImg"/.test(src),
    'preview img must be gated by isRenderableAttachmentUrl(previewImg)')
})

test('render path: imgList is NOT stripped of non-local entries (peer record must survive the save pipeline)', () => {
  const src = read('renderer/js/components/EditPanel.vue')
  assert.ok(src.includes("imgs: { image: JSON.stringify(this.imgList) }"),
    'imgList persists verbatim — the guard is render-only')
  // the guard function must not be used to filter imgList anywhere in the panel
  assert.ok(!/imgList\s*=\s*[^;\n]*isRenderableAttachmentUrl/.test(src),
    'isRenderableAttachmentUrl must never filter imgList itself')
})
