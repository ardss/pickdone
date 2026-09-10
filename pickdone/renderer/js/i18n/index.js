/** i18n progressive adoption (vue-i18n@9 UMD, window.VueI18n global)
 *  Conventions:
 *  1. Language packs live in locales/ shards in this directory (zh-CN-*.js / en-US-*.js), keys named `<module>.<element>`;
 *  2. Component templates use $t('key'); zh-CN values must match the existing Chinese text verbatim (pixel-level unchanged);
 *  3. Missing keys fall back to zh-CN; unmigrated components keep hardcoded Chinese and migrate module by module;
 *  4. Switch language via i18n.setLocale(locale) (persisted in localStorage 'appLocale').
 */

// Sharded language packs: each batch's component copy lives in its own shard (locales/*.js) to avoid parallel-migration conflicts
import zhMaster from './zh-CN.js'
import enMaster from './en-US.js'
import zhA from './locales/zh-CN-A.js'
import zhB from './locales/zh-CN-B.js'
import zhC from './locales/zh-CN-C.js'
import zhD from './locales/zh-CN-D.js'
import zhE from './locales/zh-CN-E.js'
import zhF from './locales/zh-CN-F.js'
import zhG from './locales/zh-CN-G.js'
import zhH from './locales/zh-CN-H.js'
import zhI from './locales/zh-CN-I.js'
import zhJ from './locales/zh-CN-J.js'
import zhK from './locales/zh-CN-K.js'
import zhN from './locales/zh-CN-N.js'
import zhP from './locales/zh-CN-P.js'
import zhQ from './locales/zh-CN-Q.js'
import zhR from './locales/zh-CN-R.js'
import enA from './locales/en-US-A.js'
import enB from './locales/en-US-B.js'
import enC from './locales/en-US-C.js'
import enD from './locales/en-US-D.js'
import enE from './locales/en-US-E.js'
import enF from './locales/en-US-F.js'
import enG from './locales/en-US-G.js'
import enH from './locales/en-US-H.js'
import enI from './locales/en-US-I.js'
import enJ from './locales/en-US-J.js'
import enK from './locales/en-US-K.js'
import enN from './locales/en-US-N.js'
import enP from './locales/en-US-P.js'
import enQ from './locales/en-US-Q.js'
import enR from './locales/en-US-R.js'

function mergeDeep (base, extra) {
  for (const k of Object.keys(extra)) {
    if (extra[k] && typeof extra[k] === 'object' && !Array.isArray(extra[k])) base[k] = mergeDeep(base[k] || {}, extra[k])
    else base[k] = extra[k]
  }
  return base
}
const zhAll = [zhMaster, zhA, zhB, zhC, zhD, zhE, zhF, zhG, zhH, zhI, zhJ, zhK, zhN, zhP, zhQ, zhR].reduce((m, x) => mergeDeep(m, x), {})
const enAll = [enMaster, enA, enB, enC, enD, enE, enF, enG, enH, enI, enJ, enK, enN, enP, enQ, enR].reduce((m, x) => mergeDeep(m, x), {})

const LS_KEY = 'appLocale'
export const SUPPORTED = [['zh-CN', '简体中文'], ['en-US', 'English']]

export function getLocale () {
  try {
    const saved = localStorage.getItem(LS_KEY)
    if (SUPPORTED.some(s => s[0] === saved)) return saved
    // No language chosen on first run: preselect by system language (still explicitly changeable in the wizard)
    const nav = (navigator.language || 'zh-CN').toLowerCase()
    return nav.startsWith('en') ? 'en-US' : 'zh-CN'
  } catch (e) { return 'zh-CN' } // stub environments (cli smoke tests) have no localStorage/navigator
}

export function setLocale (locale) {
  if (!SUPPORTED.some(s => s[0] === locale)) return
  localStorage.setItem(LS_KEY, locale)
  if (i18n.global) i18n.global.locale = locale
  document.documentElement.setAttribute('lang', locale === 'en-US' ? 'en' : 'zh-CN')
  try { window.todoAPI && window.todoAPI.setAppLocale && window.todoAPI.setAppLocale(locale) } catch (e) { /* browser host lacks this channel */ }
  // document.title 固定为浏览器入口 <title>(无路由 afterEach 机制——曾标注的动态更新机制不存在,2026-09-05 审查核实后删除了依赖它的死代码 pageTitle)
}

// Environment guard: stub environments like cli smoke tests only have a bare window without VueI18n — degrade to a minimal lookup stub (tt has its own flat-table fallback)
const i18n = (window.VueI18n && window.VueI18n.createI18n)
  ? window.VueI18n.createI18n({
    legacy: true,            // Options API: use $t() directly in templates
    globalInjection: true,
    locale: getLocale(),
    fallbackLocale: 'zh-CN', // fall back to the Chinese baseline on missing keys
    messages: { 'zh-CN': zhAll, 'en-US': enAll }
  })
  : { global: { locale: getLocale(), t: (k) => k, setLocale: () => {} } }

// Context-free fallback lookup: when the i18n instance is unavailable (e.g. node unit-test environments), look the key up directly in the flat table
function flatOf (o, prefix, dst) {
  for (const k of Object.keys(o)) {
    const kk = prefix ? prefix + '' + k : k
    if (o[k] && typeof o[k] === 'object') flatOf(o[k], kk, dst)
    else dst[kk] = o[k]
  }
  return dst
}
const ZH_FLAT = flatOf(zhAll, '', {})
const EN_FLAT = flatOf(enAll, '', {})
export function lookupMessage (key, locale = 'zh-CN') {
  return (locale === 'en-US' ? EN_FLAT : ZH_FLAT)[key]
}
export default i18n
