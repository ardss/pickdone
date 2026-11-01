import test from 'node:test'
import assert from 'node:assert/strict'
import { checkPrTitle, findLeaks, isScannedPath } from '../../../cli/check-environment-boundary.mjs'

test('deployment host information is not allowed in portable source', () => {
  assert.ok(findLeaks('product/AGENTS.md', 'Example C:\\Users\\dev\\AppData\\Roaming\\app').length)
  assert.ok(findLeaks('product/install.ps1', 'ssh ops@192.168.8.7 echo ok').length)
  assert.ok(findLeaks('product/install.ps1', 'Target DESKTOP-EXAMPLE123').length)
  assert.ok(findLeaks('product/config.mjs', 'D:\\PickDone\\PickDone.exe').length)
  assert.equal(findLeaks('product/config.mjs', 'const path = process.env.APPDATA').length, 0)
  assert.equal(findLeaks('product/config.mjs', 'const url = "http://127.0.0.1:3000"').length, 0)
})

test('source guard covers agent rules, workflows and ops, but not test fixtures', () => {
  assert.equal(isScannedPath('pickdone/AGENTS.md'), true)
  assert.equal(isScannedPath('.github/workflows/ci.yml'), true)
  assert.equal(isScannedPath('pickdone/scripts/deploy.ps1'), true)
  assert.equal(isScannedPath('pickdone/tests/unit/cli/fixtures.js'), false)
  assert.equal(isScannedPath('pickdone/vendor/something.js'), false)
})

test('PR gate rejects free-form titles and accepts repository commit convention', () => {
  assert.equal(checkPrTitle('Add minimal Windows A/B installed-app check'), false)
  assert.equal(checkPrTitle('fix(ops): enforce portable deployment boundaries'), true)
  assert.equal(checkPrTitle('docs: explain public installation'), true)
  assert.equal(checkPrTitle('chore(deps): update dependencies'), true)
})
