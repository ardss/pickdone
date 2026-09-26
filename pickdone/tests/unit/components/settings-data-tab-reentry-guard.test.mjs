/**
 * round3-ux-perf-finding-3: the four danger operations in SettingsDataTab (restoreFromBackup,
 * restoreFromAutoBackup, purgeSeed, purgeRecycle) must follow the same busy-flag re-entry
 * contract importFromCsv/writeBackupNow already follow: an early-return busy check, a flag
 * reset when the pipeline settles, and a matching :disabled binding on the button — otherwise
 * a second confirmed click while the first pipeline awaited IPC ran a second concurrent
 * restore/purge through commitCommand with interleaved _rt/refreshFromDb dispatches.
 *
 * Source-contract style, matching the sibling harness dw2-settings-data-tab-fixes.test.mjs
 * (no component-mount harness exists for this SFC in the node test setup).
 * Run: node --test tests/unit/components/settings-data-tab-reentry-guard.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const dataTab = readFileSync(path.join(ROOT, 'renderer/js/components/settings/SettingsDataTab.vue'), 'utf8')

const handler = (name) => {
  const m = dataTab.match(new RegExp(`async ${name} \\(\\) \\{[\\s\\S]*?\\n {4}\\},?`))
  assert.ok(m, `${name} handler found`)
  return m[0]
}

test('busy flags exist in data() alongside the established importing/backingUp contract', () => {
  const data = dataTab.match(/data \(\) \{\s*return \{[\s\S]*?\n {6}\}/)
  assert.ok(data, 'data() found')
  assert.match(data[0], /restoring: false/)
  assert.match(data[0], /purging: false/)
})

test('restoreFromAutoBackup: early-return busy check + finally reset around the full pipeline', () => {
  const fn = handler('restoreFromAutoBackup')
  assert.match(fn, /if \(this\.restoring\) return/)
  assert.match(fn, /this\.restoring = true/)
  assert.match(fn, /finally \{ this\.restoring = false \}/)
  // the reset wraps the whole confirm→read→apply pipeline, not just the confirm
  const finallyIdx = fn.indexOf('finally { this.restoring = false }')
  assert.ok(finallyIdx > fn.indexOf('applyRestoreDump'), 'finally resets after the apply pipeline in source order')
})

test('restoreFromBackup: busy check + chained reset that spans the confirm→read→apply pipeline', () => {
  // restoreFromBackup is the one non-async handler (kept that shape for the F2 source anchor)
  const m = dataTab.match(/restoreFromBackup \(\) \{[\s\S]*?\n {4}\},/)
  assert.ok(m, 'restoreFromBackup found')
  assert.match(m[0], /if \(this\.restoring\) return/)
  assert.match(m[0], /this\.restoring = true/)
  // reset is chained AFTER the pipeline settles (finally on the promise), not run synchronously
  assert.match(m[0], /\.catch\(\(\) => \{\}\)\.finally\(\(\) => \{ this\.restoring = false \}\)/)
  assert.match(m[0], /await this\.applyRestoreDump\(JSON\.parse\(txt\)\)/, 'apply pipeline unchanged')
})

test('purgeRecycle and purgeSeed: early-return busy check + finally reset', () => {
  for (const name of ['purgeRecycle', 'purgeSeed']) {
    const fn = handler(name)
    assert.match(fn, /if \(this\.purging\) return/, `${name}: re-entry blocked`)
    assert.match(fn, /this\.purging = true/, `${name}: flag set`)
    assert.match(fn, /finally \{ this\.purging = false \}/, `${name}: flag reset on every exit path`)
  }
})

test('all four danger buttons carry the matching :disabled binding', () => {
  assert.match(dataTab, /:disabled="restoring"[^>]*@click="restoreFromBackup"/)
  assert.match(dataTab, /:disabled="restoring"[^>]*@click="restoreFromAutoBackup"/)
  assert.match(dataTab, /:disabled="purging"[^>]*@click="purgeSeed"/)
  assert.match(dataTab, /:disabled="purging"[^>]*@click="purgeRecycle"/)
})
