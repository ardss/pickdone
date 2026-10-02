/* D15 A4 regression — the config-quarantine notice must be locale-aware.
   quarantine-notice.js used to hardcode English body + 'PickDone' title while the app is
   zh-CN-default with full locales. It now resolves strings through the main process's
   existing locale source of truth (src/main/i18n.js currentLocale — config.json appLocale,
   falling back to system language). Fails without the fix (no locale resolution / no zh-CN
   strings existed). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const qn = require_('../../../src/main/quarantine-notice.js')
const i18n = require_('../../../src/main/i18n.js')

test('zh-CN (app default) gets the Chinese notice, not the English one', () => {
  const m = qn.noticeMessages('zh-CN')
  assert.equal(m.title, '拾事')
  assert.ok(/config\.json/.test(m.body), 'body names the corrupted file')
  assert.ok(/config\.json\.bad/.test(m.body), 'body names the preserved copy')
  assert.ok(/应用锁/.test(m.body), 'body explains the security-lock side effect in Chinese')
  assert.ok(!/^Your config file/.test(m.body), 'must not fall back to the old hardcoded English')
})

test('en-US keeps the English notice', () => {
  const m = qn.noticeMessages('en-US')
  assert.equal(m.title, 'PickDone')
  assert.ok(/^Your config file \(config\.json\) was corrupted/.test(m.body))
  assert.ok(/security lock is disabled/.test(m.body))
})

test('unknown locale falls back to zh-CN (app default language)', () => {
  const m = qn.noticeMessages('fr-FR')
  assert.equal(m.title, '拾事')
  assert.ok(/config\.json/.test(m.body))
})

test('resolved path uses i18n currentLocale — i18n.setLocale drives the message', () => {
  try {
    i18n.setLocale('en-US')
    assert.equal(qn.noticeMessages().title, 'PickDone')
    i18n.setLocale('zh-CN')
    assert.equal(qn.noticeMessages().title, '拾事')
  } finally {
    i18n.setLocale('zh-CN')
  }
})
