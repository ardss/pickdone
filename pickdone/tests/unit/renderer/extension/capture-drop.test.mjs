// S6 drag-drop minimal loop: a browser URL dropped on the desktop window must produce the
// SAME capture payload the MV3 door ingests (normalize + fingerprint + reference rows) —
// no parallel capture grammar. Pure functions, Node-testable.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { uriListFromDataTransfer, captureUrlPayload } from '../../../../renderer/js/utils/captureDrop.js'
import { normalizeUrl, fingerprint } from '../../../../extension/shared/capture-url.js'

test('uriListFromDataTransfer: picks the first URL line, skips comments, rejects non-http', () => {
  const get = k => k === 'text/uri-list' ? '# comment\nhttps://example.com/a?utm_source=x' : ''
  assert.equal(uriListFromDataTransfer(['text/uri-list'], get), 'https://example.com/a?utm_source=x')
  assert.equal(uriListFromDataTransfer(['text/plain'], () => 'https://example.com'), null)
  const file = ['text/uri-list', () => 'file:///C:/x.txt']
  assert.equal(uriListFromDataTransfer(file[0], file[1]), null)
})

test('captureUrlPayload mirrors the door grammar: content=canonical, sourceUrl, dedupeFingerprint in family', async () => {
  const p = await captureUrlPayload('https://www.youtube.com/watch?v=abc&utm_source=x&t=90')
  assert.equal(p.content, 'https://www.youtube.com/watch?v=abc&t=90')
  assert.equal(p.sourceUrl, p.content)
  assert.ok(/^[A-Za-z0-9._:\-/@+#]{1,256}$/.test(p.dedupeFingerprint), 'fingerprint must pass the door family regex')
  const expected = await fingerprint(normalizeUrl('https://www.youtube.com/watch?v=abc&utm_source=x&t=90').canonicalUri)
  assert.equal(p.dedupeFingerprint, expected, 'payload fingerprint must equal the shipped pure function output')
})

test('captureUrlPayload rejects garbage', async () => {
  await assert.rejects(() => captureUrlPayload('not a url'))
})
