/**
 * Sync v2 UX wave 1 (2026-10-10) — two verified fixes, source-structure regression guards
 * following device-center-sync-tab.test.mjs conventions (pure source assertions, offline).
 * 1) syncPairRequest resolving means pairing was ACCEPTED by the peer: the toast must be
 *    the success message (pairOkMsg), not "request sent, waiting for confirmation". The
 *    inline pairWaiting hint keeps showing for the whole in-flight window.
 * 2) refresh() must NOT prefill connectHost from peers[0].host — one click on the
 *    connect button would then silently dial a stale paired host and rotate the shared
 *    secret (repair flow) without the user typing an address.
 * Run: node --test tests/unit/renderer/fix-20261010-syncv2-ux.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const SFC = 'renderer/js/components/settings/SettingsSyncTab.vue'
const src = fs.readFileSync(path.join(ROOT, SFC), 'utf8')

const method = (name) => {
  const m = src.match(new RegExp(`${name} \\([^)]*\\) \\{[\\s\\S]*?\\n {4}\\},`))
  assert.ok(m, `${name} method present in ${SFC}`)
  return m[0]
}

/* ---------- Fix 1: success toast after syncPairRequest resolves ---------- */

// Robust extraction: from the syncPairRequest call up through the following .catch — this is
// exactly the "resolve" branch whose toast we are locking in (independent of method indent).
const resolveBranch = (call) => {
  const m = src.match(new RegExp(call.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + String.raw`\.then\(\(\) => \{[\s\S]*?\}\)\.catch`))
  assert.ok(m, `resolve branch after ${call} present in ${SFC}`)
  return m[0]
}

test('connectPeer: resolve shows pairOkMsg success, not "sent, awaiting" (时序错误回归)', () => {
  const body = resolveBranch('syncPairRequest(parsed.host, parsed.port)')
  assert.match(body, /\$message\.success\(this\.\$t\('sync\.pairOkMsg'\)\)/,
    'resolve = accepted: must toast the pairing-success message')
  assert.doesNotMatch(body, /sync\.connectSent/,
    'must not claim "request sent, waiting for the peer" after the promise already resolved')
})

test('pairDiscovered: same success toast fix applies to the discovered-device path (发现设备配对同样修复)', () => {
  const body = resolveBranch('syncPairRequest(d.host, d.port)')
  assert.match(body, /\$message\.success\(this\.\$t\('sync\.pairOkMsg'\)\)/)
  assert.doesNotMatch(body, /sync\.connectSent/)
})

test('waiting state stays visible during the whole in-flight window (等候提示期间持续显示)', () => {
  // connecting=true drives the inline hint + disabled/spinner button for BOTH paths
  assert.match(src, /v-if="connecting">\{\{ \$t\('sync\.pairWaiting'\) \}\}/,
    'inline waiting hint renders while a pair request is in flight')
  assert.match(src, /'sync-connecting': connecting/, 'button shows the waiting style while connecting')
})

/* ---------- Fix 2: no auto-prefill of connectHost from a paired peer ---------- */

test('refresh: does not prefill connectHost from peers[0].host (禁止用已配对地址预填)', () => {
  const body = method('async refresh')
  assert.doesNotMatch(body, /connectHost\s*=\s*this\.peers/,
    'auto-dialing a stale paired host rotates the shared secret — prefill removed')
})

test('connect input stays user-owned: no other write of a peer host into connectHost', () => {
  // connectHost is only ever reset to '' or bound to the input via v-model.
  // Wave-2 regex fix: capture the VALUE with the write — m[0] previously stopped at '=',
  // so the every() clear-check tested a value-less fragment and could never pass once any
  // real write existed (the wave-2 success reset exposed this latent test bug).
  const writes = [...src.matchAll(/this\.connectHost\s*=[^\n]*/g)]
  assert.ok(writes.length === 0 || writes.every(m => /^this\.connectHost\s*=\s*''/.test(m[0])),
    'connectHost must only be cleared, never populated from stored peers')
})

/* ---------- i18n: both locales keep the keys this fix depends on ---------- */

test('zh-CN and en-US both define pairOkMsg and pairWaiting (双语文案齐备)', async () => {
  const zh = (await import(pathToFileURL(path.join(ROOT, 'renderer/js/i18n/zh-CN.js')))).default.sync
  const en = (await import(pathToFileURL(path.join(ROOT, 'renderer/js/i18n/en-US.js')))).default.sync
  for (const k of ['pairOkMsg', 'pairWaiting']) {
    assert.ok(zh[k], `zh-CN sync.${k} missing`)
    assert.ok(en[k], `en-US sync.${k} missing`)
  }
  assert.ok(zh.pairOkMsg.includes('配对成功'), 'zh pairOkMsg must state pairing succeeded')
  assert.ok(en.pairOkMsg.toLowerCase().includes('paired'), 'en pairOkMsg must state pairing succeeded')
})
