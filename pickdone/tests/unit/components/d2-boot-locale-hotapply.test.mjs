/* d2-crosscutting-auditor (round-2 journey audit, 2026-10-22):
 * [D2-LOC] the BOOT channel never hot-applies appLocale. main.js bootstrap's dual-channel
 * fallback ("restore known keys from config.json when localStorage was cleared") commits
 * settings/updateSettings — a bare Object.assign+persist mutation — so a config-carried locale
 * reached the store while LS (i18n's boot cache) and i18n.global.locale stayed stale.
 * LIVE-PROVEN: an isolated boot with config.json appLocale:'en-US' dumped
 * { ls: null, store: 'en-US', htmlLang: 'zh-CN', $i18n.locale: 'zh-CN' } — the whole UI
 * rendered Chinese. restore()'s F9 block and the update action's Y1 path both hot-apply;
 * the mutation every OTHER path shares was the one miss. Same contract as restore: enum-gated,
 * changed-only, fire-and-forget, LS write-through.
 * Run: node --test tests/unit/components/d2-boot-locale-hotapply.test.mjs */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')
const importSrc = p => import(pathToFileURL(path.join(ROOT, p)).href)

const settingsStoreSrc = read('renderer/js/store/settings.js')

test('D2-LOC: settings/updateSettings mutation hot-applies a changed appLocale (boot-channel F9 sibling)', async () => {
  const mod = await importSrc('renderer/js/store/settings.js')
  const mut = mod.default.mutations.updateSettings
  const { DEFAULT_SETTINGS } = mod
  const mkState = () => ({ ...DEFAULT_SETTINGS, appLocale: 'zh-CN', shortcutKeySettings: { ...DEFAULT_SETTINGS.shortcutKeySettings } })

  // changed locale: LS boot cache is written synchronously (a config-carried locale reaches the UI at boot)
  globalThis.localStorage.setItem('appLocale', 'zh-CN')
  const st = mkState()
  mut(st, { appLocale: 'en-US' })
  assert.equal(st.appLocale, 'en-US', 'config patch lands in live state')
  assert.equal(globalThis.localStorage.getItem('appLocale'), 'en-US', 'LS boot cache write-through')

  // i18n hot-apply fires (fire-and-forget import — give the task queue a beat)
  await new Promise(r => setTimeout(r, 80))
  const i18n = await importSrc('renderer/js/i18n/index.js')
  assert.equal(i18n.default.global.locale, 'en-US', 'i18n global locale follows the boot-channel patch')

  // unchanged locale: no LS churn (sentinel survives)
  globalThis.localStorage.setItem('appLocale', 'zh-CN-sentinel')
  const st2 = mkState()
  mut(st2, { weatherCity: 'Shanghai' })
  assert.equal(globalThis.localStorage.getItem('appLocale'), 'zh-CN-sentinel', 'no locale churn when the patch does not change the locale')

  // junk locale: neither LS nor i18n move (same enum gate as restore's [restore-locale-enum fix])
  globalThis.localStorage.setItem('appLocale', 'zh-CN-sentinel')
  const st3 = mkState()
  st3.appLocale = 'zh-CN'
  mut(st3, { appLocale: 'xx-YY' })
  assert.equal(globalThis.localStorage.getItem('appLocale'), 'zh-CN-sentinel', 'a junk locale never reaches the LS boot cache')

  // source pin: the mutation itself carries the F9-family locale path (not only restore/update)
  const m = settingsStoreSrc.match(/ {4}updateSettings \(state, patch\) \{[\s\S]*?\n {4}\},/)
  assert.ok(m, 'updateSettings mutation found')
  assert.match(m[0], /localStorage\.setItem\('appLocale', loc\)/)
  assert.match(m[0], /import\('\.\.\/i18n\/index\.js'\)/)
})

test('D2-HTMLLANG: i18n/index.js applies the html lang attribute at MODULE LOAD (not only inside setLocale)', () => {
  // live evidence: an en-US boot (LS seeded) dumped { i18n: 'en-US', htmlLang: 'zh-CN' } — the
  // static index.html lang survived the whole session because setLocale() is the only writer and
  // nothing calls it at boot. Screen readers + CJK/Latin font selection read this attribute.
  // setLocale is defined before the i18n const in this file, so pin by COUNT: one application
  // inside setLocale + at least one at module scope (the D2-HTMLLANG block reads i18n.global.locale).
  const src = read('renderer/js/i18n/index.js')
  const hits = (src.match(/documentElement\.setAttribute\('lang'/g) || []).length
  assert.ok(hits >= 2, `module-scope lang application missing (found ${hits} of >=2; setLocale's alone cannot cover boot)`)
  const modScope = src.slice(Math.max(0, src.indexOf('// D2-HTMLLANG')))
  assert.ok(modScope.includes("documentElement.setAttribute('lang'") && modScope.includes('i18n.global.locale'), 'the module-scope D2-HTMLLANG application must read the resolved i18n locale')
})
