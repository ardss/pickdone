/* W26 fix 2 (2026-11-01): config-store mergeConfig shallow merge × readConfig's key-by-key
 * default back-fill — a partial writeConfig({shortcutKeySettings:{oneKey}}) wholesale-replaced
 * the (defaults+on-disk) shortcut object the inner readConfig had just assembled, silently
 * resetting every omitted custom shortcut to its factory default on the next read (and
 * re-registering it via applyShortcuts). shortcutKeySettings is the only nested key readConfig
 * back-fills, so mergeConfig now merges it ONE level deep. Run:
 *   node --test tests/unit/main/w26-config-store-nested-merge.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const cfg = require_('../../../src/main/config-store.js')

test('w26[2a]: a partial shortcutKeySettings patch keeps sibling custom shortcuts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w26-cfg-'))
  cfg.__setConfigDir(dir)
  try {
    // First write establishes a CUSTOM shortcut table (non-default values for siblings).
    cfg.writeConfig({ shortcutKeySettings: { ...cfg.DEFAULT_SHORTCUTS, sync: 'ctrl+shift+s', addEvent: 'ctrl+alt+e' } })
    // Partial patch: change ONE key only. Red before the fix: the shallow merge replaced the
    // whole object and the omitted custom keys fell back to DEFAULT_SHORTCUTS on the next read.
    const merged = cfg.writeConfig({ shortcutKeySettings: { quickAddGlobal: 'ctrl+alt+q' } })
    assert.equal(merged.shortcutKeySettings.quickAddGlobal, 'ctrl+alt+q')
    assert.equal(merged.shortcutKeySettings.sync, 'ctrl+shift+s', 'red before the fix: sibling custom shortcut reset to default')
    assert.equal(merged.shortcutKeySettings.addEvent, 'ctrl+alt+e', 'red before the fix: sibling custom shortcut reset to default')
    // Persisted state agrees with the in-memory merge.
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))
    assert.equal(onDisk.shortcutKeySettings.sync, 'ctrl+shift+s')
    assert.equal(onDisk.shortcutKeySettings.quickAddGlobal, 'ctrl+alt+q')
    assert.equal(cfg.readConfig().shortcutKeySettings.addEvent, 'ctrl+alt+e')
  } finally {
    cfg.__setConfigDir(null)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('w26[2b]: defaults still back-fill for keys absent from BOTH disk and patch; non-object patches keep replace semantics', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w26-cfg2-'))
  cfg.__setConfigDir(dir)
  try {
    // A config on disk with a sparse shortcut table: readConfig back-fills defaults, so a partial
    // patch must merge over the back-filled table, not just the sparse disk keys.
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ shortcutKeySettings: { sync: 'ctrl+shift+s' }, locale: 'zh' }), 'utf8')
    const merged = cfg.writeConfig({ shortcutKeySettings: { pinEvent: 'ctrl+p' } })
    assert.equal(merged.shortcutKeySettings.sync, 'ctrl+shift+s', 'disk custom key survives')
    assert.equal(merged.shortcutKeySettings.pinEvent, 'ctrl+p', 'patched key lands')
    assert.equal(merged.shortcutKeySettings.quickAddGlobal, cfg.DEFAULT_SHORTCUTS.quickAddGlobal, 'untouched keys keep their back-filled default')
    // Non-object shortcutKeySettings patch (garbage via a hostile channel): replace semantics,
    // no crash — the returned merged object carries the patch as-is and the next readConfig
    // back-fills the defaults again.
    cfg.writeConfig({ shortcutKeySettings: null })
    assert.equal(cfg.readConfig().shortcutKeySettings.sync, cfg.DEFAULT_SHORTCUTS.sync, 'a null patch resets to the back-filled defaults (old replace behavior preserved)')
    // Flat keys stay flat (winBounds etc. must keep exact replace semantics).
    const flat = cfg.writeConfig({ locale: 'en' })
    assert.equal(flat.locale, 'en')
  } finally {
    cfg.__setConfigDir(null)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
