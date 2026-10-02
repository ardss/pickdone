/**
 * Domain-A security wave (2026-10-02): protocol + CSP hardening regression tests.
 *
 * Covers:
 *  - sec-app-protocol-serves-whole-install-tree: the app:// handler now allowlists its roots
 *    (renderer-dist / assets / node_modules); stray install-tree files 404, traversal 403.
 *    Tested against a TEMP fixture tree (protocol.js copied to <tmp>/src/main so __dirname-derived
 *    root = <tmp>), with electron stubbed to capture the registered handler.
 *  - sec-local-protocol-serves-bookkeeping-and-tmp: local:// must 404 aliases.json and .att-tmp-*
 *    bookkeeping (via the extracted pure isLocalBookkeepingFile decision, and end-to-end through
 *    the captured handler on a real fixture dir).
 *  - sec-renderer-csp-unsafe-inline-and-open-connect: BOTH index.html copies drop script-src
 *    'unsafe-inline', drop img-src https:, and allowlist connect-src to the six weather/geocoding
 *    hosts (style-src keeps 'unsafe-inline' — element-plus/driver inject runtime styles).
 *
 * Run: node --test tests/unit/main/domainA-protocol-hardening.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Module = require('module')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'domainA-proto-'))
// fixture install tree: <TMP>/renderer-dist/index.html, <TMP>/assets/vendor-lib/x.js, <TMP>/files/...
for (const d of ['renderer-dist', 'assets/vendor-lib', 'files']) fs.mkdirSync(path.join(TMP, d), { recursive: true })
fs.writeFileSync(path.join(TMP, 'renderer-dist', 'index.html'), '<html>fixture</html>')
fs.writeFileSync(path.join(TMP, 'assets', 'vendor-lib', 'x.js'), 'export {}')
fs.writeFileSync(path.join(TMP, '.drill-a.err'), 'stray root file')
fs.writeFileSync(path.join(TMP, 'outside.txt'), 'outside')
fs.writeFileSync(path.join(TMP, 'files', 'aliases.json'), '{"secret":"alias-map"}')
fs.writeFileSync(path.join(TMP, 'files', '.att-tmp-123-456'), 'atomic-write temp')
fs.writeFileSync(path.join(TMP, 'files', 't1_1_report.png'), 'png-bytes')

// electron stub: capture protocol.handle callbacks; app.getPath('userData') → TMP
// (attachments.attachDir appends /files itself, so the store is <TMP>/files)
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

// copy protocol.js + its top-level dependency chain into <TMP>/src/main so the handler's
// __dirname-derived root is the fixture tree (lazy inner requires are never invoked on these paths)
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
async function statusOfLocal (key) {
  const res = await captured.local({ url: 'local://' + key })
  return res.status
}

/* ---- sec-app-protocol-serves-whole-install-tree ---- */

test('app:// serves the allowlisted roots', async () => {
  assert.equal(await statusOf('app://app/renderer-dist/index.html'), 200)
  assert.equal(await statusOf('app://app/assets/vendor-lib/x.js'), 200)
})

test('app:// 404s stray install-tree root files (was 200 octet-stream before the fix)', async () => {
  assert.equal(await statusOf('app://app/.drill-a.err'), 404, 'stray root file must not be served')
  assert.equal(await statusOf('app://app/outside.txt'), 404, 'non-allowlisted root file must not be served')
  assert.equal(await statusOf('app://app/package.json'), 404, 'install metadata must not be served')
})

test('app:// traversal stays forbidden', async () => {
  // WHATWG URL normalizes '..' in the pathname BEFORE the handler sees it, so a plain ../ form
  // degrades to a root-relative request for the target — which the root allowlist now 404s.
  // The percent-encoded form survives decoding into '../' and hits the containment guard (403).
  assert.notEqual(await statusOf('app://app/../outside.txt'), 200, 'traversal target must not be served')
  assert.equal(await statusOf('app://app/%2e%2e%2foutside.txt'), 403, 'encoded ../ must not slip past')
})

/* ---- sec-local-protocol-serves-bookkeeping-and-tmp ---- */

test('isLocalBookkeepingFile: the extracted decision (pure)', () => {
  assert.equal(protocol.isLocalBookkeepingFile('aliases.json'), true)
  assert.equal(protocol.isLocalBookkeepingFile('.att-tmp-123-456'), true)
  assert.equal(protocol.isLocalBookkeepingFile('noise-custom.mp3'), false, 'white-noise custom file stays served')
  assert.equal(protocol.isLocalBookkeepingFile('t1_1_report.png'), false, 'real attachment keys stay served')
})

test('local:// 404s bookkeeping/tmp and serves real attachments (end-to-end through the handler)', async () => {
  assert.equal(await statusOfLocal('aliases.json'), 404, 'alias map must never be served (red before the fix: 200)')
  assert.equal(await statusOfLocal('.att-tmp-123-456'), 404, 'atomic-write temp files must never be served')
  assert.equal(await statusOfLocal('t1_1_report.png'), 200, 'a real saved attachment key still serves')
})

/* ---- sec-renderer-csp-unsafe-inline-and-open-connect ---- */

const WEATHER_HOSTS = ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'nominatim.openstreetmap.org', 'wttr.in', 'ipapi.co', 'photon.komoot.io']

for (const copy of ['renderer/index.html', 'renderer-dist/index.html']) {
  test('CSP gate: ' + copy, () => {
    const html = read(copy)
    const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)
    assert.ok(m, copy + ': CSP meta tag present')
    const dirs = {}
    for (const dir of m[1].split(';')) {
      const i = dir.trim().indexOf(' ')
      if (i < 0) continue
      dirs[dir.trim().slice(0, i)] = dir.trim().slice(i + 1)
    }
    assert.ok(!/\bunsafe-inline\b/.test(dirs['script-src'] || ''), 'script-src must drop unsafe-inline')
    assert.ok(/\bunsafe-inline\b/.test(dirs['style-src'] || ''), 'style-src KEEPS unsafe-inline (runtime-injected styles)')
    assert.ok(!/(^|\s)https:(\s|$)/.test(dirs['img-src'] || ''), 'img-src must not allow the open https:')
    assert.ok(!/(^|\s)https:(\s|$)/.test(dirs['connect-src'] || ''), 'connect-src must not allow the open https:')
    for (const h of WEATHER_HOSTS) {
      assert.ok(dirs['connect-src'].includes('https://' + h), 'connect-src must include ' + h)
    }
    // the migrated sortablejs tag must not reference the install node_modules tree
    assert.ok(!html.includes('app://app/node_modules/'), copy + ': no script tag reaches the node_modules install tree')
  })
}
