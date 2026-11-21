import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_CAPTURE_ENDPOINT,
  validateCaptureEndpoint
} from '../../../../extension/shared/endpoint-contract.js'

test('capture override only accepts explicit loopback endpoints and an exact /capture path', () => {
  assert.equal(DEFAULT_CAPTURE_ENDPOINT, 'http://127.0.0.1:7789/capture')
  assert.equal(validateCaptureEndpoint(DEFAULT_CAPTURE_ENDPOINT), DEFAULT_CAPTURE_ENDPOINT)
  assert.equal(validateCaptureEndpoint('http://localhost:7790/capture'), 'http://localhost:7790/capture')
  for (const unsafe of [
    '', 'http://127.0.0.1/capture', 'http://127.0.0.1:0/capture',
    'http://192.168.1.4:7790/capture', 'http://127.0.0.1.evil.example:7790/capture',
    'https://127.0.0.1:7790/capture', 'file:///capture',
    'http://127.0.0.1:7790/other', 'http://127.0.0.1:7790/capture?token=x',
    'http://user:pass@127.0.0.1:7790/capture',
    'http://[::1]:7790/capture'
  ]) {
    assert.throws(() => validateCaptureEndpoint(unsafe), undefined, unsafe)
  }
})
