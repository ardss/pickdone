/* H8 leftover-tail fixes:
 *  1. [P2] Import error codes now reach the renderer. Electron's invoke() rejection serialization
 *     strips custom Error props (.code) — only name+message survive the context bridge. The main
 *     handler therefore encodes the code INTO the message ('[CODE] original') and the renderer
 *     (SettingsDataTab.importFromCsv) branches on the prefix to show friendly copy.
 *  2. [P2] Restore paths (SettingsDataTab restoreFromAutoBackup / restoreFromBackup) isolate each
 *     segment in try/catch, run the heavy todo segment LAST, and report failed segments honestly.
 *  3. [P2] SettingsShortcutsTab.saveShortcuts goes through settings/update, whose action commits
 *     updateSettings (store memory + LS persist + DB mirror via persist()) AND calls
 *     window.todoAPI.updateSettings → 'notify-settings-updated' → writeConfig(Object.assign full
 *     merged config incl. shortcutKeySettings) + applyShortcuts re-registration. Closed loop.
 * Run: node --test tests/unit/main/h8-import-errcode-renderer.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { Worker } from 'worker_threads'
import { createRequire } from 'module'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const readSrc = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8')
const require_ = createRequire(import.meta.url)
const importer = require_('../../../cli/import.js')

/* ---- 1: worker really emits the codes the renderer branches on ---- */
function runWorker (text, format = 'auto') {
  return new Promise((resolve, reject) => {
    const w = new Worker(path.join(ROOT, 'src', 'main', 'import-worker.js'), { workerData: { text, format } })
    w.on('message', m => { w.terminate(); resolve(m) })
    w.on('error', reject)
  })
}

test('h8-1a: unrecognized header -> worker replies ok:false with code FORMAT_UNKNOWN', async () => {
  const m = await runWorker('Foo,Bar\r\n1,2\r\n')
  assert.equal(m.ok, false)
  assert.equal(m.code, 'FORMAT_UNKNOWN')
})

test('h8-1b: empty text -> worker replies ok:false with code EMPTY_FILE', async () => {
  const m = await runWorker('')
  assert.equal(m.ok, false)
  assert.equal(m.code, 'EMPTY_FILE')
})

test('h8-1c: USAGE only exists on the CLI importFile path (worker never emits it, renderer still tolerates it)', () => {
  const tmp = path.join(ROOT, 'tests', '.tmp-h8-usage.csv')
  fs.writeFileSync(tmp, 'List Name,Title\r\nInbox,x\r\n')
  try {
    assert.throws(() => importer.importFile(tmp, { format: 'nope' }), /unknown format/)
    try { importer.importFile(tmp, { format: 'nope' }) } catch (e) { assert.equal(e.code, 'USAGE') }
  } finally { fs.rmSync(tmp, { force: true }) }
})

test('h8-1d: csv-import handler encodes the code into the Error message (Electron strips custom props across invoke)', () => {
  const src = readSrc('src/main/handlers/csv-import.js')
  assert.match(src, /\[' \+ m\.code \+ '\] '/, "worker error message must carry a '[CODE] ' prefix")
  // the prefix branch in the renderer recognizes exactly these codes
  const vue = readSrc('renderer/js/components/settings/SettingsDataTab.vue')
  assert.match(vue, /FORMAT_UNKNOWN\|EMPTY_FILE\|USAGE/)
  assert.match(vue, /importErrFormatUnknown/)
  assert.match(vue, /importErrEmptyFile/)
})

test('h8-1e: friendly-copy i18n keys exist bilingually', () => {
  for (const f of ['renderer/js/i18n/locales/en-US-E.js', 'renderer/js/i18n/locales/zh-CN-E.js']) {
    const src = readSrc(f)
    assert.match(src, /"importErrFormatUnknown"/)
    assert.match(src, /"importErrEmptyFile"/)
    assert.match(src, /"restorePartialFail"/)
  }
})

/* ---- 2: restore per-segment isolation, todo LAST, honest toast ---- */
test('h8-2: restore pipeline is shared (applyRestoreDump), isolates segments, orders todo last, reports via restorePartialFail', () => {
  const vue = readSrc('renderer/js/components/settings/SettingsDataTab.vue')
  // P3 (2026-09-12) dedup: both paths funnel through ONE applyRestoreDump pipeline
  assert.equal((vue.match(/applyRestoreDump\s*\(/g) || []).length, 3, 'declaration + two call sites')
  assert.equal((vue.match(/reportRestoreResult\(rows\.length, failed\)/g) || []).length, 1, 'single report funnel')
  // todo segment runs after settings/category/habits inside the shared pipeline
  const body = (vue.match(/seg\('settings'.*?(?=reportRestoreResult)/s) || [])[0] || ''
  assert.ok(body, 'shared pipeline contains the segment chain')
  const iTodo = body.indexOf("failed.push('todo')")
  assert.ok(iTodo > body.indexOf("seg('settings'"), 'todo must run after settings')
  assert.ok(iTodo > body.indexOf("seg('category'"))
  assert.ok(iTodo > body.indexOf("seg('habits'"))
  assert.match(vue, /restorePartialFail', \{ n, s: failed\.join\(', '\) \}/)
})

/* ---- 3: shortcuts save closed loop through settings/update ---- */
test('h8-3: settings/update commits the full patch (store+persist) and forwards it to the main config writer which re-applies shortcuts', () => {
  const store = readSrc('renderer/js/store/settings.js')
  // update action commits updateSettings with the whole patch (shortcutKeySettings included -> persist LS + DB mirror)
  assert.match(store, /async update \(\{ commit \}, patch\) \{\s*commit\('updateSettings', patch\)/)
  assert.match(store, /await window\.todoAPI\.updateSettings\(patch\)/)
  const tab = readSrc('renderer/js/components/settings/SettingsShortcutsTab.vue')
  assert.match(tab, /dispatch\('settings\/update', \{ shortcutKeySettings: snap \}\)/)
  // main side: writeConfig merges the full patch (so shortcutKeySettings lands in config.json) and re-registers shortcuts
  const h = readSrc('src/main/handlers/settings.js')
  assert.match(h, /c\.shortcutKeySettings/)
  assert.match(h, /applyShortcuts\(c\.shortcutKeySettings\)/)
})
