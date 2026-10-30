/* W16 main-process fixes (2026-10-28) — five regressions, one file:
 * [1] protocol.js app:// allowlist bypass: the root allowlist read its top segment from the RAW
 *     decoded url while path.normalize resolved encoded backslashes (%5C) as separators on
 *     Windows — 'renderer-dist%5C..%5C..%5Csrc%5Cmain%5Cdb.js' passed the guard and served the
 *     whole install tree. The decision now runs on the normalized root-relative path.
 * [2] shared/machine-local-keys.mjs: the durable 'tomatoRunningSession' meta row (tomato-session.js)
 *     was NOT machine-local — it synced to every peer (fake "focus in progress" quit confirm +
 *     reconcile booking an out-of-region session on boot). Added to isMachineLocalMetaKey.
 * [3] local:// attachment keys carry the user file's original case; Chromium lowercases standard-
 *     scheme URL hosts, so an upper-case key 404'd on case-sensitive filesystems. Serve-side
 *     case-insensitive resolve fallback (resolveAttachmentCase), bookkeeping checks still 404.
 * [4] handlers/shared.js FLOAT_FORBIDDEN_SETTINGS_KEYS: a trapped float could silently persist
 *     every other main-window-consumed config key (winBounds, appLocale, enableHardwareAcceleration,
 *     autoDownloadUpdates, ...). Strip list expanded; whiteNoise keys stay allowed.
 * [5] attachments.js claimSlot: a crash between the exclusive 0-byte claim and the publish rename
 *     left a final-named 0-byte phantom — invisible to the D19 .att-tmp-* sweep and counted by
 *     quota forever. 0-byte non-bookkeeping files older than 24h now sweep + stop counting.
 * Run: node --test tests/unit/main/w16-main-fixes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import url from 'node:url'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Module = require('module')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'w16-main-'))
// fixture install tree + attachment store (attachments.attachDir appends /files to userData=TMP)
for (const d of ['renderer-dist', 'assets', 'files']) fs.mkdirSync(path.join(TMP, d), { recursive: true })
fs.writeFileSync(path.join(TMP, 'renderer-dist', 'index.html'), '<html>fixture</html>')
fs.writeFileSync(path.join(TMP, 'outside.txt'), 'outside-secret')
fs.writeFileSync(path.join(TMP, 'files', 'aliases.json'), '{"secret":"alias-map"}')
fs.writeFileSync(path.join(TMP, 'files', 't1_1_Report.PNG'), 'png-bytes-mixed-case')
fs.writeFileSync(path.join(TMP, 'files', 't1_1_report.png'), 'png-bytes')

// electron stub: capture protocol.handle callbacks; app.getPath('userData') → TMP
const captured = {}
const ELECTRON_STUB = {
  app: { getPath: () => TMP, getVersion: () => '0.0.0-test' },
  protocol: { handle: (scheme, cb) => { captured[scheme] = cb } }
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

// copy protocol.js + the whole src/main top level into <TMP>/src/main so the handler's
// __dirname-derived root is the fixture tree (lazy inner requires never fire on these paths;
// src/main/db.js IS copied — it is the exfiltration target of the [1] regression requests)
fs.mkdirSync(path.join(TMP, 'src', 'main'), { recursive: true })
for (const f of fs.readdirSync(path.join(ROOT, 'src', 'main'))) {
  if (f.endsWith('.js')) fs.copyFileSync(path.join(ROOT, 'src', 'main', f), path.join(TMP, 'src', 'main', f))
}
const protocol = require(path.join(TMP, 'src', 'main', 'protocol.js'))
protocol.handleAppProtocol()

async function statusOf (url) {
  const res = await captured.app({ url, headers: {} })
  return res.status
}
async function bodyOfLocal (key) {
  const res = await captured.local({ url: 'local://' + key })
  let body = ''
  if (res.status === 200) body = Buffer.from(await res.arrayBuffer()).toString('utf8')
  return { status: res.status, body }
}

/* ---- [1] sec-app-protocol: %5C-encoded backslash traversal bypass ---- */

test('w16[1a]: app:// serves the allowlisted roots and keeps 404 on stray root files', async () => {
  assert.equal(await statusOf('app://app/renderer-dist/index.html'), 200)
  assert.equal(await statusOf('app://app/outside.txt'), 404, 'stray install-tree file must 404')
})

test('w16[1b]: table — encoded backslash and traversal variants can never read outside the allowlist', async () => {
  const cases = [
    // the reported bypass: top segment read from raw u said 'renderer-dist' while normalize
    // resolved the %5C backslashes and escaped to <root>/src/main/db.js
    'app://app/renderer-dist%5C..%5C..%5Csrc%5Cmain%5Cdb.js',
    // same shape, one hop only
    'app://app/renderer-dist%5C..%5Coutside.txt',
    // percent-encoded forward-slash traversal
    'app://app/renderer-dist/..%2F..%2Fsrc%2Fmain%2Fdb.js',
    // plain traversal segments
    'app://app/../src/main/db.js',
    'app://app/renderer-dist/../../src/main/db.js',
    // allowlist-adjacent lookalikes
    'app://app/src/main/db.js',
    'app://app/renderer-distX/../../outside.txt'
  ]
  for (const url of cases) {
    const res = await captured.app({ url, headers: {} })
    assert.notEqual(res.status, 200, 'must not serve: ' + url)
    assert.ok([403, 404].includes(res.status), '403/404 expected, got ' + res.status + ' for ' + url)
    if (res.status === 200) return
  }
})

/* ---- [2] tomatoRunningSession is machine-local meta ---- */

test('w16[2]: isMachineLocalMetaKey covers tomatoRunningSession and stays tighten-only', async () => {
  const { isMachineLocalMetaKey } = await import(url.pathToFileURL(path.join(ROOT, 'shared', 'machine-local-keys.mjs')))
  assert.equal(isMachineLocalMetaKey('tomatoRunningSession'), true,
    'the durable running-session row must never egress/ingress (quit-guard + reconcile state)')
  // tighten-only contract: previously-classified keys stay machine-local
  for (const k of ['sync.identity', '_stamp', 'securityLock.v1', 'cliTomatoStatus', 'cliSyncCmd',
    'todosVersion', 'categoryLsMigrated', 'firedReminders:2026-10-28', 'reminderLastSeenAt',
    'db.tomatoState', 'tomatoFloatClosedByUser', 'schemaVersion', 'metaConflictBackup.x']) {
    assert.equal(isMachineLocalMetaKey(k), true, 'regression (loosened): ' + k)
  }
  // a normal user-data meta key must still NOT match (a loosened predicate would silently stop syncing it)
  assert.equal(isMachineLocalMetaKey('weatherCityCache'), false)
})

/* ---- [3] local:// case-insensitive key resolve fallback ---- */

test('w16[3]: a host-lowercased local:// key still resolves to the original-case file', async () => {
  // disk has t1_1_Report.PNG (mint preserves the user's case); Chromium's standard-scheme host
  // lowercasing turns the url into t1_1_report.png — which COLLIDES with a different real file,
  // so use a disjoint pair for the unambiguous assertion
  fs.writeFileSync(path.join(TMP, 'files', 'CaseSensitive.PNG'), 'upper-case-bytes')
  const r = await bodyOfLocal('casesensitive.png')
  assert.equal(r.status, 200, 'case-mismatched key must resolve via the fallback, not 404')
  assert.equal(r.body, 'upper-case-bytes')
  // exact-case keys keep working
  const exact = await bodyOfLocal('CaseSensitive.PNG')
  assert.equal(exact.status, 200)
  assert.equal(exact.body, 'upper-case-bytes')
})

test('w16[3b]: bookkeeping files stay 404 even via the case fallback', async () => {
  const r = await bodyOfLocal('ALIASES.JSON')
  assert.notEqual(r.status, 200, 'case-variant aliases.json must not be served')
  assert.equal(await (await captured.local({ url: 'local://no-such-file.png' })).status, 404,
    'unknown keys keep the 404 contract')
})

/* ---- [4] float config write surface ---- */

test('w16[4]: trapped float cannot persist main-window-consumed config keys', async () => {
  const { stripForbiddenSettingsKeys, FLOAT_FORBIDDEN_SETTINGS_KEYS } = require('../../../src/main/handlers/shared.js')
  const mainConsumed = ['winBounds', 'winIsMaximized', 'hideMainWindowOnStartup', 'closeActionMinimize',
    'closeTrayNotified', 'appLocale', 'enableHardwareAcceleration', 'autoDownloadUpdates',
    'enableSecurityLock', 'shortcutKeySettings', 'runWhenComputerStart',
    'securityLockPassword', 'securityLockQuestion']
  for (const k of mainConsumed) {
    assert.ok(FLOAT_FORBIDDEN_SETTINGS_KEYS.has(k), 'strip list must contain ' + k)
    const clean = stripForbiddenSettingsKeys({ [k]: 'injected' }, { float: true })
    assert.equal(clean[k], undefined, 'float write of ' + k + ' must be stripped')
  }
  // the float's LEGITIMATE write surface survives (white-noise selection)
  const legit = stripForbiddenSettingsKeys({ whiteNoiseAudio: 'rain.mp3', whiteNoiseVolume: 0.4 }, { float: true })
  assert.equal(legit.whiteNoiseAudio, 'rain.mp3')
  assert.equal(legit.whiteNoiseVolume, 0.4)
  // main-window senders keep the full surface (settings page legitimately writes these)
  const main = stripForbiddenSettingsKeys({ winBounds: { width: 900 }, appLocale: 'en-US' }, { float: false })
  assert.deepEqual(main, { winBounds: { width: 900 }, appLocale: 'en-US' })
})

/* ---- [5] crash-claim 0-byte phantom sweep + quota exclusion ---- */

test('w16[5]: 0-byte crash-claim phantoms sweep after 24h and stop counting toward quota', () => {
  const att = require('../../../src/main/attachments.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w16-claim-'))
  const now = Date.now()
  const old = new Date(now - 25 * 60 * 60 * 1000)
  const mk = (name, content, mtime) => {
    const p = path.join(dir, name)
    fs.writeFileSync(p, content)
    if (mtime) fs.utimesSync(p, mtime, mtime)
    return p
  }
  mk('t1_100_phantom.png', '', old)      // crash-claim phantom: 0-byte, final-named, old
  mk('t1_101_inflight.png', '', new Date(now - 60 * 1000)) // young claim placeholder: keep
  mk('t1_102_real.png', 'bytes', old)    // real 1-byte attachment: keep
  mk('.att-tmp-1-2', 'spool', old)       // D19 tmp residue: swept
  mk('aliases.json', '', old)            // bookkeeping: keep
  mk('noise-custom.mp3', '', old)        // app-owned noise slot: keep
  const removed = att.sweepTmpResidue(dir, { now, fsMod: fs })
  assert.equal(removed, 2, 'phantom + old .att-tmp removed, everything else untouched')
  assert.equal(fs.existsSync(path.join(dir, 't1_100_phantom.png')), false)
  assert.equal(fs.existsSync(path.join(dir, '.att-tmp-1-2')), false)
  for (const kept of ['t1_101_inflight.png', 't1_102_real.png', 'aliases.json', 'noise-custom.mp3']) {
    assert.equal(fs.existsSync(path.join(dir, kept)), true, 'must survive: ' + kept)
  }
  // quota: the (hypothetically surviving) 0-byte phantom class does not count
  const usage = att.dirUsage(dir)
  assert.equal(usage.bytes, 5, 'only the 1-byte real attachment counts')
  assert.equal(usage.count, 2, 'in-flight claim + real attachment count; bookkeeping/noise slot does not')
})
