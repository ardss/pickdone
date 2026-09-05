/**
 * Unit-test environment shims - must load before the modules under test:
 * the renderer's utils take dayjs from window.dayjs (browser UMD global); injected manually under Node,
 * plus the isoWeek plugin (the repeat engine depends on startOf('isoWeek')/isoWeekday) and the zh-cn locale.
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

const dayjs = require('dayjs')
const isoWeek = require('dayjs/plugin/isoWeek')
require('dayjs/locale/zh-cn')
dayjs.extend(isoWeek)
dayjs.locale('zh-cn')

if (!globalThis.window) globalThis.window = {}
globalThis.window.dayjs = dayjs
globalThis.window.pinyinPro = require('pinyin-pro') // core.js reads the UMD global from window.pinyinPro
// i18n shim: i18n/index.js calls window.VueI18n.createI18n at module level (provided by the vue-i18n UMD in browsers)
if (!globalThis.window.VueI18n) {
  // Shim upgrade: wired to the real zh-CN lexicon for lookup + interpolation (previously it only returned key names, so i18n-ized utils tests got key-name strings)
  // Lexicon = main package deep-merged with all locales chunks (isomorphic with runtime i18n/index.js; previously only the main package was read,
  // so chunk entries like statsA.core.calToday were not found -> the tests were actually exercising the missing-key fallback path)
  const fs = require('fs')
  const path = require('path')
  const zhMain = require('../renderer/js/i18n/zh-CN.js').default
  const mergeDeep = (dst, src) => {
    for (const [k, v] of Object.entries(src || {})) {
      dst[k] = (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object')
        ? mergeDeep(dst[k], v)
        : v
    }
    return dst
  }
  const shardDir = path.resolve(import.meta.dirname, '../renderer/js/i18n/locales')
  const shards = fs.readdirSync(shardDir).filter(f => f.startsWith('zh-CN') && f.endsWith('.js'))
    .sort((a, b) => a.length - b.length || (a < b ? -1 : 1)) // isomorphic with index.js's import order (later positions override)
  const zh = mergeDeep({}, zhMain)
  for (const f of shards) mergeDeep(zh, require('../renderer/js/i18n/locales/' + f).default)
  const lookup = k => k.split('.').reduce((o, seg) => (o && o[seg] != null ? o[seg] : null), zh)
  const translate = (k, params) => {
    let t = lookup(k)
    if (t == null) return k
    if (params) for (const [pk, pv] of Object.entries(params)) t = t.replaceAll('{' + pk + '}', String(pv))
    return t
  }
  globalThis.window.VueI18n = { createI18n: () => ({ global: { t: translate, te: k => lookup(k) != null }, mergeLocaleMessage: () => {} }) }
}
if (!globalThis.localStorage) {
  const mem = new Map()
  globalThis.localStorage = {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: k => mem.delete(k)
  }
}
