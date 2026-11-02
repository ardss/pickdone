/**
 * [w30 P1] Attachment state unification — pure mapping tests for
 * renderer/js/utils/attachmentState.js (attachmentStateOf / shouldKickPull / isLocalAttachmentUrl).
 *
 * Pins the four canonical states (ok / syncing / missing / broken) and the W29 one-shot pull-kick
 * guard semantics that moved verbatim out of EpAttachments.onImgErr.
 *
 * Run: node --test tests/unit/renderer/w30-attachment-state.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const { attachmentStateOf, shouldKickPull, isLocalAttachmentUrl } = await import(pathToFileURL(path.join(ROOT, 'renderer/js/utils/attachmentState.js')).href)

test('[w30.2] isLocalAttachmentUrl: local:// only', () => {
  assert.equal(isLocalAttachmentUrl('local:///a.png'), true)
  assert.equal(isLocalAttachmentUrl('local://a.png'), true)
  assert.equal(isLocalAttachmentUrl('https://x/y.png'), false)
  assert.equal(isLocalAttachmentUrl(undefined), false)
  assert.equal(isLocalAttachmentUrl(''), false)
})

test('[w30.2] attachmentStateOf: W29 missing marker wins over everything', () => {
  assert.equal(attachmentStateOf({ url: 'local:///a.png', missing: true }, { broken: true }), 'missing')
  assert.equal(attachmentStateOf({ url: 'https://x', missing: true }, null), 'missing')
})

test('[w30.2] attachmentStateOf: non-local metadata rows are "syncing" (bytes not on this device)', () => {
  assert.equal(attachmentStateOf({ url: 'https://peer/a.png' }, null), 'syncing')
  assert.equal(attachmentStateOf({ url: 'https://peer/a.png' }, { broken: true }), 'syncing', 'a remote row never becomes ok/broken via the img verdict')
})

test('[w30.2] attachmentStateOf: local entry — ok unless the load says broken', () => {
  assert.equal(attachmentStateOf({ url: 'local:///a.png' }, null), 'ok')
  assert.equal(attachmentStateOf({ url: 'local:///a.png' }, { broken: false }), 'ok')
  assert.equal(attachmentStateOf({ url: 'local:///a.png' }, { broken: true }), 'syncing', 'first error: pull chain still in flight')
  assert.equal(attachmentStateOf({ url: 'local:///a.png', __pullTried: true }, { broken: true }), 'broken', 'retry also failed: genuinely broken')
})

test('[w30.2] attachmentStateOf: defensive — non-object entry is broken, never a blind <img>', () => {
  assert.equal(attachmentStateOf(null, null), 'broken')
  assert.equal(attachmentStateOf('x', null), 'broken')
})

test('[w30.2] shouldKickPull: one-shot guard, local-only, marks the entry (W29 semantics preserved)', () => {
  const entry = { url: 'local:///a.png' }
  assert.equal(shouldKickPull(entry), true, 'first local error kicks the pull chain')
  assert.equal(entry.__pullTried, true, 'flag set on the parent-owned entry')
  assert.equal(shouldKickPull(entry), false, 'second error never re-kicks (no retry storm)')
  const remote = { url: 'https://peer/a.png' }
  assert.equal(shouldKickPull(remote), false, 'non-local urls have no pull chain')
  assert.equal(remote.__pullTried, undefined, 'remote entry untouched')
  assert.equal(shouldKickPull(null), false)
})

test('[w30.2] EpAttachments consumes the shared mapping (anchor: template + onImgErr)', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(path.join(ROOT, 'renderer/js/components/edit-panel/EpAttachments.vue'), 'utf8')
  assert.ok(src.includes("imState(im) === 'ok'"), 'template branches on the shared ok state')
  assert.ok(src.includes("imState(im) === 'missing'"), 'template branches on the shared missing state')
  assert.ok(src.includes('shouldKickPull(im)'), 'onImgErr delegates the pull-kick decision to the shared util')
  assert.ok(src.includes('attachmentStateOf'), 'component imports the shared classifier')
  // The task-list thumbnail lives in territory-frozen TodoItem.vue — the anchor documents the
  // known gap instead of pretending both surfaces are unified.
  const todoItem = fs.readFileSync(path.join(ROOT, 'renderer/js/components/TodoItem.vue'), 'utf8')
  assert.ok(!todoItem.includes('attachmentStateOf'), 'TodoItem.vue is territory-frozen: unification gap stays documented in the w30 report')
})
