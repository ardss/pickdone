/* Domain 2 (settings data tab + settings store) daily 2026-09-24 fixes:
 * [F2] restoreFromBackup must AWAIT todo/writeEventBackup — the event snapshot's dump builder
 *      reads live state only after an internal IPC await, so an un-awaited dispatch raced the
 *      applyRestoreDump commits and the "pre-restore rollback snapshot" could capture
 *      mid/post-restore state (restoreFromAutoBackup already awaited; :384 was the one miss).
 * [F6] writeBackupNow verdict: content-identical readable snapshot after the poll window is
 *      SUCCESS ("already up to date"), not failure — the main process rewrites the snapshot
 *      unconditionally (no dedup) and the store's 5s debounce can land past the window. Only an
 *      unreadable snapshot (null) stays a failure. Verdict extracted into verifySnapshotWritten.
 * [F8] the xlsx export row carries a hint that the export is view/archive-only (no CSV round-trip;
 *      import only accepts the three vendor CSVs). Keys exist in BOTH locales.
 * [F9] settings/restore hot-applies appLocale on the RENDERER side: LS 'appLocale' write-through
 *      (+ live i18n locale) — before, a restored backup left the UI on the old locale until
 *      restart (only main's config.json was pushed).
 * Run: node --test tests/unit/components/dw2-settings-data-tab-fixes.test.mjs */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')
const importSrc = p => import(pathToFileURL(path.join(ROOT, p)).href)

const dataTab = read('renderer/js/components/settings/SettingsDataTab.vue')
const settingsStoreSrc = read('renderer/js/store/settings.js')
const zhE = read('renderer/js/i18n/locales/zh-CN-E.js')
const enE = read('renderer/js/i18n/locales/en-US-E.js')

test('F2: the pre-restore event snapshot dispatch is awaited (no race with applyRestoreDump)', () => {
  // the exact call site must carry await, matching restoreFromAutoBackup's contract
  assert.match(dataTab, /await this\.\$store\.dispatch\('todo\/writeEventBackup', 'restore'\)/)
  // and it lives inside restoreFromBackup (not just the auto-backup path)
  const fn = dataTab.match(/restoreFromBackup \(\) \{[\s\S]*?\n {4}\},/)
  assert.ok(fn, 'restoreFromBackup found')
  assert.match(fn[0], /await this\.\$store\.dispatch\('todo\/writeEventBackup', 'restore'\)/)
})

test('F6: verifySnapshotWritten exists and only an unreadable snapshot verdicts failure', () => {
  assert.match(dataTab, /async verifySnapshotWritten \(\) \{/)
  // writeBackupNow delegates to the helper (no inline poll loop left in the confirm callback)
  const wbn = dataTab.match(/async writeBackupNow \(\) \{[\s\S]*?\n {4}\},/)
  assert.ok(wbn, 'writeBackupNow found')
  assert.match(wbn[0], /await this\.verifySnapshotWritten\(\)/)
  assert.ok(!/while \(Date\.now\(\) < deadline\)/.test(wbn[0]), 'poll loop moved out of writeBackupNow')
  // verdict: unchanged-but-readable content = success (up-to-date toast); only null verdicts failure
  assert.match(dataTab, /if \(txt && txt === before\) return \{ ok: true, unchanged: true \}/)
  assert.match(dataTab, /return \{ ok: false \}/)
  assert.match(dataTab, /snapshotUpToDateMsg/)
})

test('F6: poll window covers the store-side 5s debounce (widened past 5s)', () => {
  assert.match(dataTab, /Date\.now\(\) \+ 7[0-9]00/)
})

test('F8: export row carries the view/archive-only hint; key exists in both locales', () => {
  const row = dataTab.match(/exportExcelLabel[\s\S]*?<\/div><\/div>/)
  assert.ok(row, 'export row found')
  assert.match(row[0], /exportXlsxTip/)
  for (const [name, src] of [['zh-CN', zhE], ['en-US', enE]]) {
    assert.match(src, /"exportXlsxTip": "(?!")/, `${name} locale has exportXlsxTip`)
  }
})

test('F9: settings/restore mutation hot-applies a changed appLocale (LS write-through)', async () => {
  const mod = await importSrc('renderer/js/store/settings.js')
  const restore = mod.default.mutations.restore
  const { DEFAULT_SETTINGS } = mod
  const mkState = () => ({ ...DEFAULT_SETTINGS, appLocale: 'zh-CN', shortcutKeySettings: { ...DEFAULT_SETTINGS.shortcutKeySettings } })

  // changed locale: LS boot cache is written synchronously (UI language no longer waits for restart)
  globalThis.localStorage.setItem('appLocale', 'zh-CN')
  const st = mkState()
  restore(st, { appLocale: 'en-US' })
  assert.equal(st.appLocale, 'en-US', 'restored blob wins in live state')
  assert.equal(globalThis.localStorage.getItem('appLocale'), 'en-US', 'LS boot cache write-through')

  // unchanged locale: no LS write-through churn (sentinel value survives)
  globalThis.localStorage.setItem('appLocale', 'zh-CN-sentinel')
  const st2 = mkState()
  restore(st2, {})
  assert.equal(globalThis.localStorage.getItem('appLocale'), 'zh-CN-sentinel', 'no locale churn when the blob does not change the locale')

  // source pin: the mutation (not only the update action) carries the locale path
  const mut = settingsStoreSrc.match(/ {4}restore \(state, saved\) \{[\s\S]*?\n {4}\}/)
  assert.ok(mut, 'restore mutation found')
  assert.match(mut[0], /localStorage\.setItem\('appLocale', loc\)/)
  assert.match(mut[0], /import\('\.\.\/i18n\/index\.js'\)/)
})

test('F9 scope pin: the tomato mirror is NOT duplicated into restore (already covered by store/index.js subscribe)', () => {
  const mut = settingsStoreSrc.match(/ {4}restore \(state, saved\) \{[\s\S]*?\n {4}\}/)
  assert.ok(mut, 'restore mutation found')
  assert.ok(!/mirrorTomatoLedger/.test(mut[0]), 'no redundant tomato ledger mirror in restore')
})
