/**
 * Sync v2 UX wave 2 (2026-10-10) — sync UI state machine fixes, source-structure regression
 * guards following fix-20261010-syncv2-ux.test.mjs conventions (pure source assertions, offline).
 * 1) Incoming-pair dialog race: when the FIRST pair request had already expired (pairExpired,
 *    2.5s auto-dismiss timer armed), a SECOND pair-request overwrote incomingPair and reset
 *    pairExpired=false — but the first request's _pairExpiryTimer was still armed, and its
 *    dismissIncomingPair() fired 2.5s later, closing the NEW dialog before the user could
 *    answer it. showIncomingPair must clear the stale expiry timer on entry.
 * 2) connectPeer success left the stale host in connectHost — one more click re-dialed the
 *    just-paired address straight into the secret-rotation (repair) flow. The input must be
 *    reset to '' when pairing resolves successfully.
 * Run: node --test tests/unit/renderer/fix-20261010-syncv2-ux-wave2.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const SFC = 'renderer/js/components/settings/SettingsSyncTab.vue'
const src = fs.readFileSync(path.join(ROOT, SFC), 'utf8')

const method = (name) => {
  const m = src.match(new RegExp(`${name} \\([^)]*\\) \\{[\\s\\S]*?\\n {4}\\},`))
  assert.ok(m, `${name} method present in ${SFC}`)
  return m[0]
}

/* ---------- Fix 1: second pair-request must not inherit the first request's expiry timer ---------- */

test('showIncomingPair clears any stale _pairExpiryTimer on entry (新请求不得继承过期对话框的自动关闭定时器)', () => {
  const body = method('showIncomingPair')
  assert.match(body, /clearTimeout\(this\._pairExpiryTimer\)/,
    'the 2.5s auto-dismiss timer of an EXPIRED first request must not survive into a new request')
  assert.match(body, /this\._pairExpiryTimer\s*=\s*null/,
    'cleared timer reference must be nulled so tickIncomingPair can re-arm it cleanly')
})

test('showIncomingPair still resets pairExpired for the new request lifecycle (新请求生命周期完整重启)', () => {
  const body = method('showIncomingPair')
  // order matters: timer cleared BEFORE pairExpired=false, otherwise the old timer could fire in between
  const clearAt = body.indexOf('clearTimeout(this._pairExpiryTimer)')
  const resetAt = body.indexOf('this.pairExpired = false')
  assert.ok(clearAt !== -1 && resetAt !== -1 && clearAt < resetAt,
    'stale timer must be cleared before pairExpired is reset (no window where both are armed)')
})

test('tickIncomingPair arms the auto-dismiss exactly once per expired dialog (过期宽限期内只调度一次)', () => {
  const body = method('tickIncomingPair')
  assert.match(body, /if \(!this\._pairExpiryTimer\)\s*this\._pairExpiryTimer = setTimeout/,
    'guard keeps the 2.5s dismiss timer from being re-armed on every tick')
})

test('dismissIncomingPair still tears down timers + focus (清理不变式保持)', () => {
  const body = method('dismissIncomingPair')
  assert.match(body, /clearInterval\(this\._pairReqTimer\)/)
  assert.match(body, /clearTimeout\(this\._pairExpiryTimer\)/)
  assert.match(body, /this\._pairExpiryTimer\s*=\s*null/)
})

/* ---------- Fix 2: successful connect must reset the host input ---------- */

test('connectPeer: resolve clears connectHost (配对成功后复位输入框，防止一键进入密钥轮换流程)', () => {
  const body = src.match(/syncPairRequest\(parsed\.host, parsed\.port\)\.then\(\(\) => \{[\s\S]*?\}\)\.catch/)
  assert.ok(body, 'connectPeer resolve branch present')
  assert.match(body[0], /this\.connectHost\s*=\s*''/,
    'the just-paired host must not linger in the input as a one-click repair (secret rotation) trap')
})

test('pairDiscovered: no input to reset — must NOT be forced to touch connectHost (发现设备路径无需连带改动)', () => {
  const body = src.match(/syncPairRequest\(d\.host, d\.port\)\.then\(\(\) => \{[\s\S]*?\}\)\.catch/)
  assert.ok(body, 'pairDiscovered resolve branch present')
  assert.doesNotMatch(body[0], /connectHost/,
    'discovered devices have no host input; the wave-2 fix is scoped to the typed-address path only')
})

test('connect input stays user-owned across the wave-2 change: only cleared, never populated (输入框仍只被清空)', () => {
  const writes = [...src.matchAll(/this\.connectHost\s*=[^\n]*/g)]
  assert.ok(writes.length >= 1, 'the wave-2 success reset must exist')
  assert.ok(writes.every(m => /^this\.connectHost\s*=\s*''/.test(m[0])),
    'every connectHost write must be a clear-to-empty; populating from stored peers is forbidden')
})
