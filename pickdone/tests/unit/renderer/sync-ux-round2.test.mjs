/**
 * Sync UX round 2 regression tests (2026-09-19 review):
 *   P1-2  LAN-sync-applied rounds reload WITHOUT wiping the local undo stack
 *   P1-3  external settings patches are sanitized (unknown/type junk dropped, numerics coerced)
 *   P2b   conflict toasts: singleton + 30s rate limit (source anchors)
 *   P2c   unpaired-by-remote peer state (pure helper + i18n parity)
 *   P2d   confirm dialog focuses its cancel button (Escape reachable)
 *   P2e   attachments-arrived events are filtered by the current todo's keys
 *   P2f   remote tomato chip cleared when sync is off
 *   P1-4i/k/j/h release-chain: updater channel pin, live-stage ceilings, linux verify step,
 *         CHANGELOG 0.4.0-beta.15 section present in BOTH locales
 *
 * Run: node --test tests/unit/renderer/sync-ux-round2.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')
const importSrc = p => import(pathToFileURL(path.join(ROOT, p)).href)

/* ---------------- P1-2: sync-path reload preserves undo history ---------------- */

test('P1-2: todo/init with preserveHistory does NOT commit historyClear (sync apply path)', async () => {
  const store = (await importSrc('renderer/js/store/todo.js')).default
  const commits = []
  const ctx = {
    state: {},
    commit: (m, p) => commits.push([m, p]),
    dispatch: () => Promise.resolve()
  }
  globalThis.window.todoAPI = {
    dbCall: async op => (op === 'getAll' ? [] : '5')
  }
  await store.actions.init.call(ctx, ctx, { preserveHistory: true })
  assert.ok(!commits.some(([m]) => m === 'historyClear'),
    'lan-sync-applied reload must keep the user undo stack (no historyClear)')
  assert.ok(commits.some(([m]) => m === 'setAllRows'), 'rows still reload')

  commits.length = 0
  await store.actions.init.call(ctx, ctx)
  assert.ok(commits.some(([m]) => m === 'historyClear'),
    'default reload (CLI/watcher external write) still clears history')
})

test('P1-2: renderer main.js routes lan-sync-apply reason into the preserving reload', () => {
  const src = read('renderer/js/main.js')
  assert.match(src, /reason === 'lan-sync-apply'/, 'payload reason detected')
  assert.match(src, /preserveHistory/, 'reload entry takes a preserveHistory flag')
})

/* ---------------- P1-3: external settings patch validation ---------------- */

test('P1-3: sanitizeSettingsPatch drops unknown/type-mismatch junk and coerces numerics', async () => {
  const mod = await importSrc('renderer/js/store/settings.js')
  const { sanitizeSettingsPatch } = mod
  const out = sanitizeSettingsPatch({
    tomatoTimeDefault: '25',       // numeric string → coerced
    newTodoCategoryId: '3',        // numeric string id → coerced (CLI legacy shape)
    autoDownloadUpdates: 'not-a-bool', // type mismatch → dropped
    notARealSetting: { junk: true },   // unknown key → dropped
    backupDir: null                // tombstone → dropped
  })
  assert.equal(out.tomatoTimeDefault, 25)
  assert.equal(out.newTodoCategoryId, 3)
  assert.ok(!('autoDownloadUpdates' in out))
  assert.ok(!('notARealSetting' in out))
  assert.ok(!('backupDir' in out))
  assert.deepEqual(sanitizeSettingsPatch(null), {})
  assert.deepEqual(sanitizeSettingsPatch([1, 2]), {})
  // Every CLI-settable key survives sanitization when well-typed (manifest parity guard)
  const wellFormed = sanitizeSettingsPatch({ backupDir: 'D:/x', developerMode: true, dailyTomatoTarget: '8' })
  assert.equal(wellFormed.backupDir, 'D:/x')
  assert.equal(wellFormed.developerMode, true)
  assert.equal(wellFormed.dailyTomatoTarget, 8)
})

test('P1-3: external-settings-changed is routed through settings/updateExternal', () => {
  const src = read('renderer/js/main.js')
  assert.match(src, /settings\/updateExternal/, 'hot-apply dispatches the sanitized variant')
  assert.ok(!/onExternalSettingsChanged[\s\S]{0,400}settings\/update'/.test(src),
    'raw settings/update must no longer be dispatched directly from the external channel')
})

/* ---------------- P2b: conflict toast singleton + rate limit ---------------- */

test('P2b: conflict toast path reuses one instance and rate-limits to 30s', () => {
  const src = read('renderer/js/main.js')
  assert.match(src, /_conflictToast/, 'singleton toast handle exists')
  assert.match(src, /_conflictToast\.close\(\)/, 'previous instance is closed, not stacked')
  assert.match(src, /30 \* 1000/, '30s minimum interval between shows')})

/* ---------------- P2c: unpaired-by-remote peer card ---------------- */

test('P2c: peerUnpairedByRemote maps lastError markers to the dedicated state', () => {
  const src = read('renderer/js/components/settings/SettingsSyncTab.vue')
  const m = src.match(/function peerUnpairedByRemote[\s\S]*?\n\}/)
  assert.ok(m, 'pure helper present')
  // eslint-disable-next-line no-new-func
  const fn = new Function(m[0] + '\nreturn peerUnpairedByRemote')()
  assert.equal(fn('unpaired by peer'), true)
  assert.equal(fn('peer-unauthorized'), true)
  assert.equal(fn('auth rejected: bad secret'), true)
  assert.equal(fn('round timed out waiting for peer ack'), false)
  assert.equal(fn(''), false)
  assert.equal(fn(null), false)
})

test('P2c: unpaired card renders dedicated copy and hides the Unpair button (both locales)', () => {
  const vue = read('renderer/js/components/settings/SettingsSyncTab.vue')
  assert.match(vue, /v-if="isUnpairedByRemote\(p\)"/)
  assert.match(vue, /v-if="!isUnpairedByRemote\(p\)".*askUnpair/, 'unpair button hidden for zombie peer')
  for (const loc of ['renderer/js/i18n/zh-CN.js', 'renderer/js/i18n/en-US.js']) {
    const s = read(loc)
    assert.match(s, /unpairedByRemote/, `${loc} has the key`)
  }
  assert.match(read('renderer/js/i18n/zh-CN.js'), /已被对方解除配对/)
  assert.match(read('renderer/js/i18n/en-US.js'), /Unpaired by the other device/)
})

/* ---------------- P2d: confirm dialog Escape reachable ---------------- */

test('P2d: askConfirm focuses the cancel button so the overlay keydown can fire', () => {
  const vue = read('renderer/js/components/settings/SettingsSyncTab.vue')
  const m = vue.match(/askConfirm \(titleKey[\s\S]*?\n {4}\},/)
  assert.ok(m, 'askConfirm body')
  assert.match(m[0], /confirmCancelBtn/, 'focus lands on the safe default (cancel)')
  assert.match(vue, /restoreConfirmFocus/, 'focus is restored on close')
})

/* ---------------- P2e: attachments-arrived key filter ---------------- */

test('P2e: arrivals only bump arriveTick for keys of the current todo', () => {
  const src = read('renderer/js/components/edit-panel/EpAttachments.vue')
  const m = src.match(/function arrivalTouchesCurrent[\s\S]*?\n\}/)
  assert.ok(m, 'pure helper present')
  // eslint-disable-next-line no-new-func
  const fn = new Function(m[0] + '\nreturn arrivalTouchesCurrent')()
  const lists = [[{ key: 'a.png', url: 'file:///d/files/a.png' }], [{ key: 'doc.pdf', url: 'file:///d/files/doc.pdf' }]]
  assert.equal(fn(lists, 'a.png'), true, 'own key refreshes')
  assert.equal(fn(lists, 'other.png'), false, 'foreign key ignored (no flicker)')
  assert.equal(fn([[], []], 'a.png'), false, 'empty local list never refreshes')
  assert.equal(fn(lists, ''), true, 'key-less event keeps legacy behavior')
  assert.equal(fn([[{ url: 'file:///d/files/enc%2Fa.png' }]], 'enc%2Fa.png'), true, 'url basename matches encoded key')
})

/* ---------------- P2f: stale remote chip cleared on sync off ---------------- */

test('P2f: tomatoAnnounce clears remote announces when sync is disabled', () => {
  const store = read('renderer/js/store/tomatoAnnounce.js')
  assert.match(store, /clearRemote/, 'clearRemote mutation exists')
  assert.match(store, /syncEnabledNow/, 'reload checks live sync-enabled state')
  const tab = read('renderer/js/components/settings/SettingsSyncTab.vue')
  assert.match(tab, /tomatoAnnounce\/clearRemote/, 'toggle-off drops the chip immediately')
})

/* ---------------- P1-4i: updater channel pin ---------------- */

test('P1-4i: updater pins channel to latest (beta.yml 404 fix)', () => {
  const src = read('src/main/updater.js')
  assert.match(src, /autoUpdater\.channel = 'latest'/)
  assert.match(src, /autoUpdater\.allowPrerelease = true/, 'beta app versions still satisfy the range check')
})

/* ---------------- P1-4k: check-all live stage ceilings ---------------- */

test('P1-4k: every Electron live (③) stage tuple carries an explicit named ceiling', () => {
  const src = read('cli/check-all.js')
  const seg = src.slice(src.indexOf("name: '③ Electron 活体"), src.indexOf('2026-09-07 四路审查'))
  // EOL-agnostic (repo checkouts may be CRLF): strip \r before anchored matches
  const segLines = seg.split('\n').map(l => l.replace(/\r$/, ''))
  const stageLines = segLines.filter(l => l.trim().startsWith("['"))
  assert.ok(stageLines.length >= 9, 'live stages found')
  for (const l of stageLines) {
    assert.match(l, /, 20\],$/, `stage lacks a 20min ceiling: ${l.slice(0, 60)}`)
  }
})

/* ---------------- P1-4j: linux verify-packaged parity ---------------- */

test('P1-4j: release.yml linux job runs verify-packaged.cjs on both arch dirs', () => {
  const yml = read('../.github/workflows/release.yml')
  const linux = yml.slice(yml.indexOf('release-linux:'))
  assert.match(linux, /verify-packaged\.cjs --dir dist\/linux-unpacked/)
  assert.match(linux, /verify-packaged\.cjs --dir dist\/linux-arm64-unpacked/)
})

test('P1-4j: verify-packaged.cjs guards the .cmd shim checks on file existence (linux-safe)', () => {
  const src = read('scripts/verify-packaged.cjs')
  const m = src.match(/const cmdPath[\s\S]*?\n\}/)
  assert.ok(m && /fs\.existsSync\(cmdPath\)/.test(m[0]), 'cmd checks are existence-guarded')
})

/* ---------------- P1-4h: CHANGELOG 0.4.0-beta.15 present in both locales ---------------- */

test('P1-4h: CHANGELOG.md and CHANGELOG.zh.md both have a non-empty 0.4.0-beta.15 section', () => {
  for (const f of ['../CHANGELOG.md', '../CHANGELOG.zh.md']) {
    const s = read(f)
    const m = s.match(/## \[0\.4\.0-beta\.15\][^\n]*\n([\s\S]*?)(?=\n## \[)/)
    assert.ok(m && m[1].trim().length >= 30, `${f} missing/thin 0.4.0-beta.15 section (release body step would exit 1)`)
  }
})

test('P1-4h: package.json + package-lock.json are bumped to 0.4.0-beta.15 (tag-match gate)', async () => {
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.version, '0.4.0-beta.15')
  const lock = JSON.parse(read('package-lock.json'))
  assert.equal(lock.version, '0.4.0-beta.15')
})
