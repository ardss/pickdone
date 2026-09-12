/* eslint-env node */
/**
 * i18n full health check
 *   node renderer/js/i18n/check-i18n.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const LOCALES = path.join(ROOT, 'i18n', 'locales')
const CJK = /[\u4e00-\u9fff]/

// —— Whitelist ——
const ALLOW = [
  /console\./, /dayjs|format\(/, /localStorage|setItem|getItem/,
  /parsed\.|\.label\b/, /repeatType|weekStartDay/, /MEDIA|wmo|WMO/,
  // repeatYearType radio values "solar/lunar" = persisted engine enum values (matched by value in expandRepeatDates), display side goes through $t
  /label="公历"|label="农历"|repeatYearType/,
  // Stripping the "市" (city) suffix from city names (cnCities.js): geocoding data normalization, not display copy
  /replace\(\/市\$\//,
  /'初[一二三四五六七八九十]'|'初一'|\u8282|\u519c\u5386/, /FMT\./,
  /'自定义'|value="顶部"|value="底部"|'最近7天'|'最近30天'|'最近半年'|'最近一年'|'已完成'|'未完成'|'30天'/,
  /aria-label="视图切换"|aria-label="放弃"|title="放弃"|aria-label="关闭"/,
  /'打印时间：'/, /<!--|-->/, /^\s*\*/, /^\s*\/\//,
  // Chinese natural-language date parser: by design only parses Chinese input (nlDate.js), whole file exempt
  /nlDate/,
  // dayjs Chinese format token definitions (FMT.cn*) and runtime user-profile default seed values
  /cnDate|cnMonth|cnFull/,
  // Seed category default names / new category default name: persisted data values, display side goes through i18n (onboarding.renameSeedCats)
  /mk\(1, '工作'|categoryName = '新分类'/,
  // Data values / regexes: city admin-region suffix stripping, legacy Chinese seed category name comparison (not display copy)
  /(市\|地区\|盟\|自治州)|(省\|自治区\|特别行政区)/, /onboarding\.catWork/,
  // Normalization mapping table: key = legacy Chinese persisted value, value = stable enum key (data migration, not display)
  /': '/, /LEGACY/,
  // Defensive Chinese fallbacks (shown only when $t is missing) and i18n call lines
  /statsA\.core\./, /vm\.\$t \?/,
  // Unit values in repeat rules and user data (day/week/month/year, solar), persisted with task data — data values, not UI copy
  /case '(天|周|月|年)'/, /repeatYearType/,
  // confirm.js: $t main path + Chinese fallback (defends against missing i18n context)
  /autoDeleteTail|无标题|onClick: undo \}, '撤销'/
]


// —— Collect source files(SFC 迁移后:递归扫,.vue 模板+script 同扫) ——
const srcFiles = []
for (const dir of ['components', 'views', 'store', 'utils']) {
  const d = path.join(ROOT, dir)
  if (!fs.existsSync(d)) continue
  const walkSrc = (sub) => {
    for (const f of fs.readdirSync(sub)) {
      const p = path.join(sub, f)
      if (fs.statSync(p).isDirectory()) walkSrc(p)
      else if ((f.endsWith('.js') && !f.endsWith('.render.js')) || f.endsWith('.vue')) srcFiles.push(p)
    }
  }
  walkSrc(d)
}
srcFiles.push(path.join(ROOT, 'main.js'), path.join(ROOT, 'layout.vue'))

// —— 1. Hardcoded ——
const hardcoded = []
for (const f of srcFiles) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/')
  if (rel.endsWith('nlDate.js')) continue // Chinese natural-language date parser: by design only parses Chinese input
  const lines = fs.readFileSync(f, 'utf8').split('\n')
  let inBlock = false // multi-line block comment state: comment body skipped entirely
  lines.forEach((line, i) => {
    let code = line
    if (inBlock) {
      if (code.includes('*/')) { code = code.slice(code.indexOf('*/') + 2); inBlock = false } else return
    }
    // Strip inline block comments segment by segment (e.g. } catch (e) { /* cancel */ })
    while (code.includes('/*')) {
      const a = code.indexOf('/*')
      if (a === -1) break
      const b = code.indexOf('*/', a + 2)
      if (b === -1) { code = code.slice(0, a); inBlock = true; break }
      code = code.slice(0, a) + code.slice(b + 2)
    }
    if (!CJK.test(code)) return
    // Chinese in trailing comments does not count as hardcoded (this codebase's comments consistently use the " // " spaced style)
    if (code.includes(' // ')) code = code.slice(0, code.indexOf(' // '))
    if (!CJK.test(code)) return
    if (/^\s*(\/\/|\*|\/\*)/.test(code)) return
    if (ALLOW.some(p => p.test(code))) return
    hardcoded.push(`[HARDCODED] ${rel}:${i + 1}  ${code.trim().slice(0, 80)}`)
  })
}

// —— Load language packs ——
// Conflict detection: dual forms (same path being both a leaf and a branch) and cross-shard same-key different-value (the L/M incident class)
const dualFormConflicts = new Set()
const valueConflicts = [] // [file, key, oldVal, newVal]
function deepFlat (dst, o, prefix, fromFile) {
  for (const k of Object.keys(o)) {
    const kk = prefix ? `${prefix}.${k}` : k
    if (o[k] && typeof o[k] === 'object') {
      if (Object.prototype.hasOwnProperty.call(dst, kk)) dualFormConflicts.add(kk) // this path is already a leaf yet also has branches
      deepFlat(dst, o[k], kk, fromFile)
    } else {
      if (Object.prototype.hasOwnProperty.call(dst, kk)) {
        // Existing value: either from flattening of a nested form, or a cross-shard value conflict
        if (dst[kk] !== o[k]) {
          const srcFile = keyToFile[kk]
          valueConflicts.push(`[VALUE-CONFLICT] ${kk}: '${dst[kk]}' (${srcFile}) ≠ '${o[k]}' (${fromFile})`)
        } else if (keyToFile[kk] && keyToFile[kk] !== fromFile) {
          // 同值跨文件重复定义:mergeDeep 后写者静默胜出,任何一侧单独改文案即无告警漂移(statsA.core 事故形态,2026-09-05)
          valueConflicts.push(`[DUP-SHARD] ${kk}: 同时定义于 ${keyToFile[kk]} 与 ${fromFile}(值相同)——删掉一侧,单一事实源`)
        }
      } else {
        keyToFile[kk] = fromFile
      }
      dst[kk] = o[k]
    }
  }
}
const keyToFile = {}
function loadLang (lang) {
  const m = {}
  try {
    const src = fs.readFileSync(path.join(ROOT, 'i18n', lang + '.js'), 'utf8')
    const body = src.slice(src.indexOf('export default') + 'export default'.length)
    const obj = (new Function('return ' + body))()
    deepFlat(m, obj, '', lang + '.js')
  } catch (e) { console.error('[i18n] 主语言文件读取失败(空表会让 diff 全等假绿):', e.message) }
  const ORDER = ['A', 'B', 'C', 'D', 'E', 'G', 'H', 'I', 'J', 'K', 'N', 'P', 'Q', 'R', 'T'] // matches index.js import order, keeping "later shard wins" semantics identical to runtime
  for (const f of fs.readdirSync(LOCALES).filter(x => x.startsWith(lang)).sort((a, b) => {
    const ra = ORDER.indexOf(a.match(/-([A-Z])\.js$/)?.[1] || '')
    const rb = ORDER.indexOf(b.match(/-([A-Z])\.js$/)?.[1] || '')
    return ra - rb
  })) {
    const src = fs.readFileSync(path.join(LOCALES, f), 'utf8')
    const body = src.slice(src.indexOf('export default') + 'export default'.length)
    const obj = (new Function('return ' + body))()
    deepFlat(m, obj, '', f)
  }
  return m
}

const zhMsgs = loadLang('zh-CN')
const enMsgs = loadLang('en-US')
// 自保断言:两边全空/近全空 = 语言包读取整体失败,diff 全等会零报错假绿(cssom 基线同款教训)
const KEY_FLOOR = 800
for (const [lang, m] of [['zh-CN', zhMsgs], ['en-US', enMsgs]]) {
  if (Object.keys(m).length < KEY_FLOOR) {
    console.error(`[i18n] FAIL: ${lang} 仅 ${Object.keys(m).length} 个键(< 下限 ${KEY_FLOOR})——语言包读取失败或大面积丢键,diff 结果不可信`)
    process.exit(1)
  }
}

// —— Shard prefix purity check (manifest = i18n/manifest.mjs, single source of truth) ——
// Each shard's actual top-level keys must fall within the declared prefixes; unregistered new shards or entries placed in the wrong shard are caught here
import { SHARDS } from './manifest.mjs'
const shardPurityIssues = []
{
  const byBatch = Object.fromEntries(SHARDS.map(s => [s.batch, s.prefixes]))
  for (const lang of ['zh-CN', 'en-US']) {
    for (const f of fs.readdirSync(LOCALES).filter(x => x.startsWith(lang))) {
      const batch = f.match(/-([A-Z])\.js$/)?.[1] || 'master'
      const allowed = byBatch[batch]
      if (!allowed) { shardPurityIssues.push(`[SHARD] ${f}: 未在 manifest.mjs 登记`); continue }
      if (!allowed.length) continue // master legacy-baseline mixed content exempt
      const src = fs.readFileSync(path.join(LOCALES, f), 'utf8')
      const obj = (new Function('return ' + src.slice(src.indexOf('export default') + 'export default'.length)))()
      for (const top of Object.keys(obj)) {
        const hit = allowed.some(p => top === p || top.startsWith(p + '.') || top.startsWith(p))
        if (!hit) shardPurityIssues.push(`[SHARD] ${f}: 顶层前缀 '${top}' 不在声明 [${allowed.join(', ')}]`)
      }
    }
  }
}

// —— 2. Collect keys referenced by code (with interpolation params, for placeholder mismatch detection) ——
const usedKeys = new Set()
const usedCalls = [] // [key, Set(paramNames), file]
for (const f of srcFiles) {
  const src = fs.readFileSync(f, 'utf8')
  for (const m of src.matchAll(/\$t\(\s*'([^']+)'\s*[,)]/g)) usedKeys.add(m[1]) // only followed by , or ) counts as a complete key; 'xxx.' + k dynamic concatenation not counted
  // $t(expr || 'fallback.key') fallback form: previously missed by scans, leaving dangling fallback keys (achMax) undefined long-term so runtime tooltips showed the raw key name
  for (const m of src.matchAll(/\$t\([^)]*?\|\|\s*'([a-zA-Z][\w]*(?:\.[\w]+)+)'/g)) usedKeys.add(m[1])
  for (const m of src.matchAll(/\$t\(\s*'([^']+)'\s*,\s*\{([^}]*)\}\s*\)/g)) {
    // Support shorthand { n } and named { n: x }; expression values may contain parentheses, so split only on top-level commas
    const params = new Set(m[2].split(',').map(s => (s.split(':')[0] || '').trim()).filter(Boolean))
    usedCalls.push([m[1], params, path.relative(ROOT, f).split(path.sep).join('/')])
  }
  for (const m of src.matchAll(/labelKey:\s*'([^']+)'/g)) usedKeys.add(m[1])
}

// —— 3. Missing ——
const missing = []
for (const k of usedKeys) {
  if (!(k in zhMsgs)) missing.push(`[MISSING zh] ${k}`)
  if (!(k in enMsgs)) missing.push(`[MISSING en] ${k}`)
}

// —— 4. en=zh untranslated ——
const untranslated = []
for (const k of Object.keys(zhMsgs)) {
  if (enMsgs[k] !== undefined && enMsgs[k] === zhMsgs[k] && CJK.test(enMsgs[k])) untranslated.push(k)
}
// —— 4b. Chinese residue in en shards (does not require equality with the Chinese value: mixed text like '已Add一个番茄' once slipped past the checks) ——
const enCjk = []
for (const [k, v] of Object.entries(enMsgs)) {
  if (typeof v === 'string' && CJK.test(v)) enCjk.push(`[EN-CJK] ${k} = ${String(v).slice(0, 60)}`)
}

// —— 5. Interpolation placeholder mismatch ——
// A {p} in the value not supplied by call params → {p} leaks through verbatim at runtime (the 'MMM D' incident class)
const paramIssues = []
for (const [k, params, file] of usedCalls) {
  for (const langVal of [zhMsgs[k], enMsgs[k]]) {
    if (typeof langVal !== 'string') continue
    for (const m of langVal.matchAll(/\{(\w+)\}/g)) {
      if (!params.has(m[1])) paramIssues.push(`[PARAM-MISSING] ${k} 需要 {${m[1]}} 但 ${file} 调用未提供（值为 '${langVal}'）`)
    }
  }
}

// —— 6. User-visible Chinese in main/preload layers ——
// Renderer i18n does not cover main; Chinese in tray/dialogs/notifications can only come from src/main/i18n.js
const MAIN_ALLOW = [/console\./, /log\.(info|warn|error)/, /broadcastTodosChanged/, /^\s*(\/\/|\*|\/\*)/, / \/\//]
const mainHardcoded = []
const MAIN_DIRS = [path.join(ROOT, '../../src/main'), path.join(ROOT, '../../src/preload')]
for (const d of MAIN_DIRS) {
  if (!fs.existsSync(d)) continue
  for (const f of fs.readdirSync(d)) {
    if (!f.endsWith('.js')) continue
    const rel = path.relative(ROOT, path.join(d, f)).split(path.sep).join('/')
    const lines = fs.readFileSync(path.join(d, f), 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (!CJK.test(line)) return
      let code = line.includes(' // ') ? line.slice(0, line.indexOf(' // ')) : line
      code = code.replace(/\/\*[^*]*\*\//g, '') // inline block comment (e.g. } catch (e) { /* empty */ })
      if (!CJK.test(code)) return
      if (/^\s*(\/\/|\*|\/\*)/.test(code)) return
      if (MAIN_ALLOW.some(p => p.test(code))) return
      // Only care about copy assigned to user-visible outlets; pure comments/logs are already exempt
      if (!/(label|title|message|body|detail|buttons|setToolTip|value\s*=|c1\.value|filters)/.test(code)) return
      mainHardcoded.push(`[MAIN-HARDCODED] ${rel}:${i + 1}  ${code.trim().slice(0, 80)}`)
    })
  }
}

// —— Output ——
console.log(`硬编码: ${hardcoded.length} | 缺失: ${missing.length} | 未翻译(en=zh): ${untranslated.length} | 占位符失配: ${paramIssues.length} | 双形态键: ${dualFormConflicts.size} | 跨分片异值: ${valueConflicts.length} | 主进程中文: ${mainHardcoded.length}`)
if (hardcoded.length) { console.log('--- 硬编码 ---'); hardcoded.forEach(h => console.log('  ' + h)) }
if (missing.length) { console.log('--- 缺失 ---'); missing.forEach(m => console.log('  ' + m)) }
if (paramIssues.length) { console.log('--- 占位符失配 ---'); paramIssues.forEach(x => console.log('  ' + x)) }
if (dualFormConflicts.size) { console.log('--- 双形态键 ---'); [...dualFormConflicts].forEach(k => console.log('  [DUAL-FORM] ' + k)) }
if (valueConflicts.length) { console.log('--- 跨分片异值 ---'); valueConflicts.forEach(x => console.log('  ' + x)) }
if (mainHardcoded.length) { console.log('--- 主进程中文 ---'); mainHardcoded.forEach(x => console.log('  ' + x)) }
if (shardPurityIssues.length) { console.log('--- 分片前缀纯度（见 manifest.mjs）---'); shardPurityIssues.forEach(x => console.log('  ' + x)) }
if (enCjk.length) { console.log('--- en 分片中文残留 ---'); enCjk.forEach(x => console.log('  ' + x)) }

process.exit(hardcoded.length || missing.length || paramIssues.length || dualFormConflicts.size || valueConflicts.length || mainHardcoded.length || shardPurityIssues.length || enCjk.length ? 1 : 0)
