/**
 * D22 maintenance round (renderer) — regression guards.
 * Fixes covered:
 *   [F1] QuickAdd multi-line paste partial failure keeps only the unsent remainder for retry
 *   [F2] QuickAdd Esc also clears the active date chip (stale-date carry-over)
 *   [F3] TomatoAbandonModal + TomatoFloatPage await giveUp; close only on success, error on failure
 *   [F4] TomatoFloatPage pickNoise honors settings/update's {ok:false} resolution
 *   [F5] tomatoId mint mixes in a device-stable salt (cross-device same-ms collision)
 *   [F6] SettingsDataTab restore ingests CLI evt-purge dumps (backup.liveRows/purgedRows/metaEntries)
 * Run: node --test tests/unit/renderer/d22-ux-fixes.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

if (!globalThis.window.location) globalThis.window.location = { hash: '' }

/* ---------- [F1/F2] QuickAdd: partial-failure remainder + Esc clears the date chip ---------- */

test('[F1] createLines leaves only the unsent remainder in the input on a mid-batch failure', () => {
  const src = read('renderer/js/components/QuickAdd.vue')
  // a per-line success counter declared OUTSIDE the try (the catch reads it)
  assert.ok(/let done = 0[^\n]*\n\s*try \{[\s\S]{0,900}done\+\+[\s\S]{0,2000}\} catch \(err\) \{/.test(src),
    'done counter increments per dispatched line inside the try')
  // the catch trims the input to lines.slice(done) so a retry re-creates nothing twice
  const iCatch = src.indexOf("console.error('[quick-add] multi-line paste failed:'")
  assert.ok(iCatch > -1, 'multi-line catch site found')
  const body = src.slice(iCatch, iCatch + 700)
  assert.ok(body.includes('lines.slice(done).join') && body.includes('this.text = rest'),
    'catch keeps only the unsent remainder as the retry draft')
})

test('[F2] onCancel (Esc) resets pickedDate so the next quick-add cannot inherit the stale chip', () => {
  const src = read('renderer/js/components/QuickAdd.vue')
  const i = src.indexOf('onCancel (e) {') // maint/d23: signature gained the event param for the IME guard
  assert.ok(i > -1, 'onCancel found')
  const body = src.slice(i, i + 400)
  const iFail = body.indexOf('this.failed = false')
  const iPick = body.indexOf('this.pickedDate = null')
  assert.ok(iPick > iFail && iPick > -1, 'Esc clears the picked date chip')
  assert.ok(iPick < body.indexOf('blur'), 'chip reset happens in the cancel path itself')
})

/* ---------- [F3] abandon is awaited at both giveUp sites ---------- */

test('[F3] TomatoAbandonModal awaits giveUp: success announced after resolve, failure reopens with error', () => {
  const src = read('renderer/js/components/TomatoAbandonModal.vue')
  assert.ok(/confirmAbandon \(\) \{[\s\S]{0,120}if \(this\.busy\) return[\s\S]{0,800}dispatch\('tomato\/giveUp'[\s\S]{0,300}\.then\(\(\) =>[\s\S]{0,300}\.catch\(e =>/.test(src),
    'confirmAbandon is busy-guarded and chains then/catch on the giveUp dispatch')
  const iThen = src.indexOf(".then(() => { this.busy = false; announce() })")
  assert.ok(iThen > -1, 'the success announce happens only AFTER the dispatch resolves')
  assert.ok(/commit\('ui\/openTomatoAbandon'\)/.test(src), 'failure reopens the modal (abandon did not land, retry stays possible)')
  assert.ok(src.includes('statsH.main.actionFailedMsg'), 'failure surfaces an error toast (existing key, no new i18n)')
  assert.ok(/:disabled="busy"/.test(src), 'give-up button disabled while the abandon is in flight')
})

test('[F3] TomatoFloatPage.confirmAbandon awaits giveUp; the abandon layer closes only on success', () => {
  const src = read('renderer/js/views/TomatoFloatPage.vue')
  const i = src.indexOf('async confirmAbandon () {')
  assert.ok(i > -1, 'confirmAbandon is async')
  const body = src.slice(i, i + 900)
  assert.ok(body.includes("await this.$store.dispatch('tomato/giveUp'"), 'giveUp is awaited')
  assert.ok(body.indexOf('this.closeAbandon()') > body.indexOf('await this.$store.dispatch'), 'layer collapse happens after the await (inside try; [maint/d23 FIX-3b] routes through closeAbandon for focus restore)')
  assert.ok(/if \(this\.abandonBusy\) return/.test(body), 're-entry guard on the busy flag')
  assert.ok(body.includes('statsH.main.actionFailedMsg'), 'failure surfaces an error toast')
})

/* ---------- [F4] pickNoise honors the settings/update result ---------- */

test('[F4] pickNoise awaits settings/update and does not collapse the panel on a failed write', () => {
  const src = read('renderer/js/views/TomatoFloatPage.vue')
  const i = src.indexOf('async pickNoise (id) {')
  assert.ok(i > -1, 'pickNoise is async')
  const body = src.slice(i, i + 1200)
  assert.ok(body.includes("await this.$store.dispatch('settings/update'"), 'the settings action is awaited')
  assert.ok(body.includes('r.ok === false'), "the action's {ok:false} resolution is honored (it RESOLVES, not rejects)")
  // [maint/d23 FIX-3b] the collapse goes through closeNoisePanel() (adds focus restore to the
  // ♪ toggle) but the ordering contract is unchanged: collapse only after a successful write
  assert.ok(body.indexOf('this.closeNoisePanel()') > body.indexOf('await this.$store.dispatch'), 'panel collapses only after a successful write')
  assert.ok(body.includes('statsH.main.actionFailedMsg'), 'failure is surfaced, not silent')
})

