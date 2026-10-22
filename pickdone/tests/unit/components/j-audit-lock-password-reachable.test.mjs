/* J-audit 2026-10-22 (config-surface journey audit) — security lock password reachability.
 * P1 live-verified: the lock password row was v-if="st.enableSecurityLock" while onLockToggle
 * refuses to enable the lock until a password is stored (guard: lockNeedsPassword). A fresh user
 * toggling the lock got the warning toast but NO password input anywhere — the feature was
 * unreachable through the UI. Fix: password row always rendered; "Lock now" gated on the enabled
 * lock; a hint (lockNeedsPassword) shows until a password exists.
 * Run: node --test tests/unit/components/j-audit-lock-password-reachable.test.mjs */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

const modal = read('renderer/js/components/SettingsModal.vue')

test('lock password row is reachable while the lock is OFF (not v-if-gated behind enableSecurityLock)', () => {
  // The exact dead form: password form-item gated on the very switch it must precede.
  assert.ok(!/v-if="st\.enableSecurityLock"><span class="form-item__label">\{\{ \$t\('statsE\.SettingsModal\.lockPasswordLabel'\) \}\}/.test(modal),
    'password row must not be gated behind st.enableSecurityLock')
  // The ROW OPENING TAG carries no condition (the lock-now button inside may keep its own v-if).
  const openTag = modal.match(/<div class="form-item"(?:\s[^>]*)?><span class="form-item__label">\{\{ \$t\('statsE\.SettingsModal\.lockPasswordLabel'\) \}\}/)
  assert.ok(openTag, 'password form-item opening tag found')
  assert.ok(!/<div class="form-item"\s+v-if/.test(openTag[0]), 'password row opening tag has no v-if')
  const row = modal.match(/<div class="form-item"(?:\s[^>]*)?><span class="form-item__label">\{\{ \$t\('statsE\.SettingsModal\.lockPasswordLabel'\) \}\}<\/span>[\s\S]*?<\/div><\/div>/)
  assert.match(row[0], /show-password/, 'password input keeps show-password')
  assert.match(row[0], /@change="saveLockPassword\(\$event\)"/, 'password input routes through saveLockPassword')
})

test('"Lock now" only renders while the lock is enabled', () => {
  assert.match(modal, /<button v-if="st\.enableSecurityLock" class="mini" @click="setLockTest">/)
})

test('hint (lockNeedsPassword) shows only until a password is stored', () => {
  const row = modal.match(/<div class="form-item"><span class="form-item__label">\{\{ \$t\('statsE\.SettingsModal\.lockPasswordLabel'\) \}\}<\/span>[\s\S]*?<\/div><\/div>/)
  assert.ok(row, 'password form-item found')
  assert.match(row[0], /v-if="!st\.securityLockPassword"[^>]*class="tip"/, 'tip is gated on !st.securityLockPassword')
  assert.match(row[0], /lockNeedsPassword/, 'tip reuses the existing guard copy, no new i18n key')
})

test('enable-guard intact: no stored password still blocks enabling (lockNeedsPassword)', () => {
  const fn = modal.match(/onLockToggle \(v\) \{[\s\S]*?\n {4}\},/)
  assert.ok(fn, 'onLockToggle found')
  assert.match(fn[0], /if \(v && !this\.st\.securityLockPassword\)/)
  assert.match(fn[0], /lockNeedsPassword/)
  assert.match(fn[0], /return/)
})

test('replay-onboarding comment matches live behavior (runJourney hands-on tour, not a spotlight)', () => {
  const fn = modal.match(/replayOnboarding \(\) \{[\s\S]*?\n {4}\},/)
  assert.ok(fn, 'replayOnboarding found')
  assert.match(fn[0], /runJourney\(true\)/)
  const comment = modal.match(/\/\* Replay onboarding:[\s\S]*?\*\//)
  assert.ok(comment, 'replay comment found')
  assert.match(comment[0], /runJourney/)
  assert.ok(!/today-page spotlight \*\//.test(comment[0]), 'stale "spotlight" wording replaced')
})
