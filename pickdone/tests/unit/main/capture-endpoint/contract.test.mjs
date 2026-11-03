/**
 * [S4 capture-endpoint RED→GREEN] endpoint contract — single source of truth for the
 * extension→desktop delivery URL.
 *
 * Guards the exact defect QA rejected: the extension defaulted to a WRONG endpoint
 * (`127.0.1:8741/api/capture`) while the desktop server actually binds 127.0.0.1:7789 and
 * answers POST /capture. Both sides must agree, literally, forever.
 *
 * Run: node --test tests/unit/main/capture-endpoint/contract.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import { DEFAULT_CAPTURE_ENDPOINT as EXT_ENDPOINT } from '../../../../extension/shared/endpoint-contract.js'

const require = createRequire(import.meta.url)
const { DEFAULT_CAPTURE_ENDPOINT: MAIN_ENDPOINT, CAPTURE_HOST, CAPTURE_PORT, CAPTURE_PATH } =
  require('../../../../src/main/capture-endpoint/contract.cjs')

test('contract: extension and main declare the SAME default endpoint', () => {
  assert.equal(EXT_ENDPOINT, MAIN_ENDPOINT)
})

test('contract: the shared literal is the real server surface (127.0.0.1:7789 + POST /capture)', () => {
  assert.equal(MAIN_ENDPOINT, 'http://127.0.0.1:7789/capture')
  assert.equal(CAPTURE_HOST, '127.0.0.1') // loopback ONLY, never 0.0.0.0
  assert.equal(CAPTURE_PORT, 7789)
  assert.equal(CAPTURE_PATH, '/capture')
})
