/* W31 P1: About/diagnostics build fingerprint (version + git SHA + channel).
 * Red case: the About section in the settings modal used to render ONLY the version —
 * the user could not tell which build (commit, channel) they were running, and the
 * diagnostic payload carried nothing that identifies the build either.
 * Contract (user-observable):
 *  - the About section renders a fingerprint string containing version, git SHA and channel;
 *  - the main-process diagnostic payload ('app:build-info') contains the SAME fingerprint
 *    (same pure builder, all three fields);
 *  - the SHA is never hardcoded in source — it comes from build-time injection
 *    (vite define / env) or a live git description.
 * Run: node --test tests/unit/main/w31-about-build-fingerprint.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const Module = require('module')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

/* ---- shared pure builder (both the About UI and the diagnostic handler use it) ---- */
const { buildFingerprint, channelFromVersion } = await import(
  'file://' + path.join(ROOT, 'shared/build-fingerprint.mjs').replace(/\\/g, '/')
)

test('buildFingerprint: contains version, git SHA and channel', () => {
  const fp = buildFingerprint({ version: '0.4.0', gitSha: 'ab12cd3', channel: 'beta' })
  assert.ok(fp.includes('0.4.0'), `fingerprint missing version: ${fp}`)
  assert.ok(fp.includes('ab12cd3'), `fingerprint missing git SHA: ${fp}`)
  assert.ok(fp.includes('beta'), `fingerprint missing channel: ${fp}`)
})

test('channelFromVersion: derives the update channel from the version prerelease suffix', () => {
  assert.equal(channelFromVersion('0.4.0-beta.21'), 'beta')
  assert.equal(channelFromVersion('1.0.0-alpha.1'), 'alpha')
  assert.equal(channelFromVersion('1.0.0'), 'stable')
})

/* ---- About section renders the fingerprint (structural source assertion, same
 * pattern as tests/unit/components/*: the SFC's user-visible output is source-locked) ---- */
test('SettingsModal About section renders version + git SHA + channel fingerprint', () => {
  const src = read('renderer/js/components/SettingsModal.vue')
  assert.ok(src.includes('buildFingerprint'), 'SettingsModal must render a build fingerprint')
  // the template must reference the fingerprint data (user-visible), not just import the helper
  assert.ok(/\{\{[^}]*buildFingerprint[^}]*\}\}/.test(src), 'template must render the fingerprint string')
  // SHA must not be hardcoded in the component — it comes from build-time injection or git
  assert.ok(!/[0-9a-f]{40}/.test(src), 'SettingsModal must not embed a literal git SHA')
  // the component must use the SAME pure builder as the diagnostic payload
  assert.ok(src.includes('shared/build-fingerprint.mjs'), 'SettingsModal must use the shared fingerprint builder')
})

/* ---- main diagnostic payload carries the same fingerprint ---- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'w31-fingerprint-'))
const ELECTRON_STUB = {
  app: { getPath: () => TMP, getVersion: () => '9.9.9-test' },
  Notification: class { show () {} },
  shell: { openExternal: async () => {}, openPath: async () => '' }
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB
  if (request === 'electron-updater') return { autoUpdater: { on: () => {}, checkForUpdates: async () => {}, downloadUpdate: async () => {}, quitAndInstall: () => {}, isUpdaterActive: () => false } }
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

test("diagnostic payload 'app:build-info' contains the same three-field fingerprint", async () => {
  process.env.APP_VERSION = '9.9.9-test'
  process.env.APP_GIT_SHA = 'deadbee'
  process.env.APP_CHANNEL = 'beta'
  const systemHandlers = require('../../../src/main/handlers/system.js')
  const ctxBase = {
    isLocked: () => false,
    allowWithinRate: () => true,
    i18n: { t: k => k },
    app: ELECTRON_STUB.app,
    getMainWindow: () => null,
    isSafeExternal: () => true
  }
  const handlers = systemHandlers(ctxBase)
  assert.ok(handlers['app:build-info'], "system handlers must register 'app:build-info'")
  const info = handlers['app:build-info']()
  assert.equal(info.version, '9.9.9-test')
  assert.equal(info.gitSha, 'deadbee')
  assert.equal(info.channel, 'beta')
  // SAME builder output as the About section renders
  assert.equal(info.fingerprint, buildFingerprint({ version: '9.9.9-test', gitSha: 'deadbee', channel: 'beta' }))
  assert.ok(info.fingerprint.includes('deadbee') && info.fingerprint.includes('beta'))
  delete process.env.APP_GIT_SHA
  delete process.env.APP_CHANNEL
  delete process.env.APP_VERSION
})

test('build-info SHA source: env injection first, live git description fallback, never a hardcoded literal', async () => {
  const src = read('src/main/build-info.cjs')
  assert.ok(!/[0-9a-f]{40}/.test(src), 'build-info must not embed a literal git SHA')
  assert.ok(src.includes('APP_GIT_SHA'), 'build-info must honor build-time env injection')
  assert.ok(/rev-parse/.test(src), 'build-info must fall back to a live git description (rev-parse)')
})
