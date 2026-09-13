/**
 * Structural guard tests — locks the incidents that actually happened into regression checks:
 *   1. All component/view template strings have balanced tags (the settings modal failing to open was rooted in an unclosed div)
 *   2. Referenced local static assets actually exist (lessons from element font 404s / leftover hashed filenames)
 *   3. CSS forbids circularly self-referencing tokens (--brand: var(--brand) once caused white blocks on selected date cells)
 *   4. Both host index.html files reference identical local asset sets (Electron and browser debug host stay in sync)
 * Run: npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const rel = p => path.join(ROOT, p)
const exists = p => fs.existsSync(rel(p))

/* ---------- 1. template tag balance ---------- */

// .vue SFC 拆解 helper(2026-09-05 SFC 迁移:模板从 JS 字符串迁入 .vue)
const walkVue = (dir, acc = []) => {
  if (!fs.existsSync(rel(dir))) return acc
  for (const f of fs.readdirSync(rel(dir))) {
    const p = dir + '/' + f
    if (fs.statSync(rel(p)).isDirectory()) walkVue(p, acc)
    else if (f.endsWith('.vue')) {
      const src = fs.readFileSync(rel(p), 'utf8')
      const tplM = src.match(/<template>\n([\s\S]*?)\n<\/template>/)
      const scM = src.match(/<script[^>]*>\n([\s\S]*?)\n<\/script>/)
      acc.push({ file: p, tpl: tplM ? tplM[1] : '', script: scM ? scM[1] : '' })
    }
  }
  return acc
}

const VOID_TAGS = new Set(['input', 'img', 'br', 'hr', 'i', 'meta', 'link'])
const scanTemplate = tpl => {
  const stack = []
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g
  let m
  while ((m = re.exec(tpl))) {
    const [, close, tag, attrs] = m
    if (VOID_TAGS.has(tag.toLowerCase()) || attrs.trim().endsWith('/')) continue
    if (!close) stack.push(tag)
    else {
      const top = stack.pop()
      if (top !== tag) return `mismatched close: </${tag}> but stack top is <${top}>`
    }
  }
  return stack.length ? `unclosed: ${stack.join(', ')}` : null
}

test('structure: all .vue template tags balanced', () => {
  const broken = []
  for (const { file, tpl } of walkVue('renderer/js')) {
    const err = scanTemplate(tpl)
    if (err) broken.push(`${file}: ${err}`)
  }
  assert.deepEqual(broken, [], 'template balance failed (once broke the settings modal and all page clicks):\n' + broken.join('\n'))
})

/* ---------- 2. local static asset existence ---------- */

const collectRefs = (text, base) => {
  const refs = []
  // app://app/xxx, /assets/xxx, /node_modules/xxx and relative url(../img/..)
  for (const m of text.matchAll(/app:\/\/app\/([^"')\s]+)/g)) refs.push(m[1].split('?')[0])
  for (const m of text.matchAll(/(?:href|src)=["'](\/(?:assets|node_modules)\/[^"']+)["']/g)) refs.push(m[1].split('?')[0])
  for (const m of text.matchAll(/url\(\s*['"]?(\.\.?\/[^)'"]+)['"]?\s*\)/g)) {
    refs.push(path.posix.normalize(base + '/' + m[1]).replace(/^\//, ''))
  }
  return refs
}

test('structure: all local assets in Electron renderer/index.html exist', () => {
  const html = fs.readFileSync(rel('renderer/index.html'), 'utf8')
  const missing = collectRefs(html, '').filter(r => !exists(r) && !/^https?:/.test(r))
  assert.deepEqual(missing, [], 'renderer/index.html missing assets: ' + missing.join(', '))
})

test('structure: renderer-dist build output stays in lockstep with source entry (Vite hash 资产形态)', () => {
  // check:all 在本测试前已跑 build:renderer;单独 npm test 无产物时按红计(SKIP=静默零断言绿=假绿红线,2026-09-05 审查)
  if (!fs.existsSync(rel('renderer-dist/index.html'))) {
    assert.fail('renderer-dist/index.html 不存在——先运行 npm run build:renderer 再跑本门禁')
  }
  const dist = fs.readFileSync(rel('renderer-dist/index.html'), 'utf8')
  assert.ok(!dist.includes('/js/main.js'), 'dist 入口必须被 Vite 重写为 hash 资产,不得残留源形态')
  assert.ok(/renderer-dist\/assets\d*\/[\w-]+\.js/.test(dist), 'dist 必须引用打包 chunk')
  for (const vendor of ['vue3.global.prod.js', 'element-plus.full.min.js', 'vuex4.global.prod.js', 'vue-router4.global.prod.js']) {
    assert.ok(dist.includes(vendor), 'vendor 经典脚本必须在 dist html 中原样保留: ' + vendor)
  }
})

test('structure: all local assets in browser-dev/index.html exist', () => {
  // The browser-dev debug host is not committed (intranet tool); skip when missing (CI lacks this directory)
  if (!fs.existsSync(rel('browser-dev/index.html'))) return
  const html = fs.readFileSync(rel('browser-dev/index.html'), 'utf8')
  const missing = collectRefs(html, '').filter(r => !exists(r) && !/^https?:/.test(r))
  assert.deepEqual(missing, [], 'browser-dev/index.html missing assets: ' + missing.join(', '))
})

test('structure: all local assets referenced by CSS url() exist', () => {
  const missing = []
  const cssDir = rel('assets/css')
  for (const f of fs.readdirSync(cssDir)) {
    if (!f.endsWith('.css')) continue
    const css = fs.readFileSync(path.join(cssDir, f), 'utf8')
    for (const m of css.matchAll(/url\(\s*['"]?([^)'"]+)['"]?\s*\)/g)) {
      let u = m[1]
      if (/^https?:|^data:/.test(u)) continue
      if (u.includes('*')) continue // wildcard in a comment example
      u = u.replace(/^app:\/\/app\//, '').split('?')[0]
      const p = u.startsWith('../../../') || u.startsWith('.') ? path.posix.normalize('assets/css/' + u) : u
      if (!exists(p)) missing.push(`${f} -> ${u}`)
    }
  }
  assert.deepEqual(missing, [], 'CSS missing assets: ' + missing.join(', '))
})

test('structure: Element Plus runtime in place (icons are inline SVG, theme-chalk font no longer needed)', () => {
  assert.ok(exists('assets/vendor-lib/element-plus.full.min.js'))
  assert.ok(exists('assets/vendor-lib/element-plus/index.css'))
  assert.ok(!exists('assets/vendor-lib/theme-chalk/index.css'), 'legacy theme-chalk layer should have been removed')
})

/* ---------- 3a. CSS files contain no raw control characters ---------- */


test('structure: CSS files contain no raw control characters (one stray control char made CSSOM silently swallow the whole .modal-container rule, 2026-09-01)', () => {
  const bad = []
  const cssDir = rel('assets/css')
  const BS = String.fromCharCode(92) // single backslash so the \uXXXX escapes survive string concatenation into RegExp
  const CTRL = new RegExp('[' + BS+'u0000-' + BS+'u0008' + BS+'u000B' + BS+'u000C' + BS+'u000E-' + BS+'u001F]', 'g')
  for (const f of fs.readdirSync(cssDir)) {
    if (!f.endsWith('.css')) continue
    const css = fs.readFileSync(path.join(cssDir, f), 'utf8')
    for (const m of css.matchAll(CTRL)) {
      bad.push(`${f}@line${css.slice(0, m.index).split('\n').length}: ${JSON.stringify(m[0])}`)
    }
  }
  assert.deepEqual(bad, [], 'raw control characters in CSS (CSSOM drops surrounding rules): ' + bad.join(', '))
})

/* ---------- 3. CSS tokens must not self-reference circularly ---------- */

test('structure: CSS has no --x: var(--x) circular self-reference (once broke --brand entirely)', () => {
  const bad = []
  const cssDir2 = rel('assets/css')
  for (const f of fs.readdirSync(cssDir2)) {
    if (!f.endsWith('.css')) continue
    const css = fs.readFileSync(path.join(cssDir2, f), 'utf8')
    for (const m of css.matchAll(/(--[\w-]+)\s*:\s*var\(\1[\s,)]/g)) bad.push(`${f}: ${m[1]}`)
  }
  assert.deepEqual(bad, [], 'circularly self-referencing tokens: ' + bad.join(', '))
})

test('structure: every CSS custom property referenced is defined (:root or dark)', () => {
  const defined = new Set()
  const used = new Set()
  for (const f of ['base.css', 'theme-dark.css']) {
    const css = fs.readFileSync(path.join(rel('assets/css'), f), 'utf8')
    for (const m of css.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1])
    for (const m of css.matchAll(/var\((--[\w-]+)/g)) used.add(m[1])
  }
  // --ico is injected via inline component styles (mask icons); --el-* are Element Plus built-ins
  const missing = [...used].filter(u => !defined.has(u) && !/^--el-/.test(u) && !['--ev-color', '--ev-text', '--panel', '--ico'].includes(u))
  assert.deepEqual(missing, [], 'undefined CSS variables: ' + missing.join(', '))
})

/* ---------- 4. dual-host asset reference consistency ---------- */

test('structure: both index.html files share the same local vendor/css script sets', () => {
  const localDeps = file => {
    const html = fs.readFileSync(rel(file), 'utf8')
    const names = []
    for (const m of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
      const u = m[1].replace(/^app:\/\/app\//, '/').split('?')[0]
      if (/^\/(assets|node_modules)\//.test(u)) names.push(path.posix.basename(u))
    }
    return names.sort()
  }
  const a = localDeps('renderer/index.html')
  // browser-dev is not committed; when missing, degrade to validating only the Electron host's self-consistency
  if (!fs.existsSync(rel('browser-dev/index.html'))) return
  const b = localDeps('browser-dev/index.html')
  const onlyA = a.filter(x => !b.includes(x))
  const onlyB = b.filter(x => !a.includes(x))
  assert.deepEqual(
    { onlyA, onlyB },
    { onlyA: [], onlyB: [] },
    `dual-host dependency mismatch - Electron only: ${onlyA} / browser-dev only: ${onlyB}`
  )
})

/* ---------- 5. shape guards for known incidents ---------- */

test('structure: settings modal Data Management tab not duplicated (parallel merges once produced twin panels)', () => {
  // STRUCTURAL LOCK: twin-data-panel merge incident — refactor will false-red, real bugs stay green; candidate for
  // behavior conversion (needs a Vue mount harness; counting `tab==='data'` occurrences is the cheapest reliable guard)
  const src = fs.readFileSync(rel('renderer/js/components/SettingsModal.vue'), 'utf8')
  const count = (src.match(/tab==='data'/g) || []).length
  assert.ok(count <= 2, `Data Management appears ${count} times; suspected duplicated template merge`)
})

/* ---------- 6. main-process environment fault-tolerance guard (2026-08-30 EPIPE P0: parent shell exit took the stdout pipe,
   electron-log writes raised uncaught exceptions popping the main-process error dialog. This protection must not be removed) ---------- */
test('structure: main process keeps stdout/stderr EPIPE tolerance and uncaughtException pipe-error filtering', () => {
  // STRUCTURAL LOCK: 2026-08-30 EPIPE P0 (parent shell exit took the stdout pipe; electron-log writes raised uncaught
  // exceptions popping the main-process error dialog) — refactor will false-red, real bugs stay green; candidate for
  // behavior conversion (would require spawning the packaged Electron binary against a closed pipe; no such harness today)
  const src = fs.readFileSync(rel('src/main/index.js'), 'utf8')
  assert.ok(src.includes("stream.on('error'"), 'stdout/stderr missing error swallowing - a broken pipe will crash the main process')
  assert.ok(src.includes("uncaughtException"), 'missing uncaughtException filter')
  assert.ok(src.includes("e.code === 'EPIPE'"), 'uncaughtException does not filter EPIPE')
})


/* ---------- 3.5 theme style integrity (from the 2026-08-30 incident: theme-dark.css was accidentally truncated to 3 lines while all gates stayed green,
   breaking both light and dark themes. Three invariants: dark token block present / rule-count floor / zero light-theme pollution) ---------- */

test('structure: theme-dark.css dark token block present (anti-truncation; core surface variables must be dark-covered)', () => {
  const css = fs.readFileSync(path.join(rel('assets/css'), 'theme-dark.css'), 'utf8')
  const required = ['--text-1', '--text-2', '--line', '--gray-bg', '--hover-bg', '--brand-light', '--bg', '--panel']
  const missing = required.filter(t => {
    const re = new RegExp('html\\[data-theme="dark"\\]\\s*\\{[^}]*' + t.replace(/-/g, '\\-') + '\\s*:')
    return !re.test(css)
  })
  assert.deepEqual(missing, [], 'dark token block missing variables: ' + missing.join(', '))
})

test('structure: theme-dark.css rule-count floor (truncation-incident defense; currently ~276 prefixed rules)', () => {
  const css = fs.readFileSync(path.join(rel('assets/css'), 'theme-dark.css'), 'utf8')
  const n = (css.match(/html\[data-theme="dark"/g) || []).length
  assert.ok(n >= 150, 'theme-dark.css has only ' + n + ' dark-prefixed rules (threshold 150); file may be truncated')
})

test('structure: theme-dark.css zero light-theme pollution (top-level selectors outside the token block must carry the dark prefix)', () => {
  const css = fs.readFileSync(path.join(rel('assets/css'), 'theme-dark.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '') // strip comments
  const isDarkScoped = sel => sel.startsWith('html[data-theme="dark"]') || sel.startsWith('html.dark')
  const bad = []
  let depth = 0
  let sel = ''
  for (const ch of css) {
    if (ch === '{') {
      if (depth === 0 && sel.trim() && !isDarkScoped(sel.trim())) bad.push(sel.trim().slice(0, 60))
      depth++
      sel = ''
    } else if (ch === '}') {
      depth--
      sel = ''
    } else if (depth === 0) {
      sel += ch
    }
  }
  assert.deepEqual(bad, [], 'theme-dark.css top-level rules without the dark prefix (light theme polluted): ' + bad.join(' | '))
})
/* ---------- 4. zero tolerance for Vue2 leftovers (from the 2026-08-31 incident: the .x-enter classes of the collapse/fade/pop/slide-right/listfade
   transitions were all Vue2 names, so enter animations never worked in Vue3; DayRail's beforeDestroy timer was never cleared.
   Such issues pass all gates and can only be caught by proactive scanning, so they are locked in as structural checks) ---------- */

const VUE2_JS_PATTERNS = [
  [/beforeDestroy\s*\(/, 'Vue2 beforeDestroy (Vue3 uses beforeUnmount; never executes)'],
  [/(^|[^\w$.])destroyed\s*\(/, 'Vue2 destroyed (Vue3 uses unmounted)'],
  [/\$children/, '$children (removed in Vue3)'],
  [/\$listeners/, '$listeners (removed in Vue3; use $attrs)'],
  [/\$scopedSlots/, '$scopedSlots (removed in Vue3; use $slots)'],
  [/\$on\(/, '$on (event-bus API removed in Vue3)'],
  [/\$off\(/, '$off (removed in Vue3)'],
  [/\$once\(/, '$once (removed in Vue3)'],
  [/\.native\b/, '.native modifier (removed in Vue3)'],
  [/slot-scope/, 'slot-scope (legacy Vue2 slot syntax)'],
  [/\$set\(|\$delete\(/, '$set/$delete (unnecessary with Vue3 reactivity)']
]

test('structure: renderer has zero Vue2 legacy APIs (lifecycle/event bus/slot syntax)', () => {
  const offenders = []
  const walk = dir => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name)
      if (f.isDirectory()) walk(p)
      else if (f.name.endsWith('.js')) {
        const src = fs.readFileSync(p, 'utf8')
        for (const [re, why] of VUE2_JS_PATTERNS) {
          if (re.test(src)) offenders.push(path.relative(ROOT, p) + ' → ' + why)
        }
      }
    }
  }
  walk(rel('renderer/js'))
  assert.deepEqual(offenders, [], 'Vue2 legacy APIs found:\n' + offenders.join('\n'))
})

test('structure: CSS has zero Vue2 transition class names (.x-enter must be written .x-enter-from, otherwise enter animations never run)', () => {
  const offenders = []
  const walk = dir => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name)
      if (f.isDirectory()) walk(p)
      else if (f.name.endsWith('.css')) {
        const css = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
        // .foo-enter must not be directly followed by a selector boundary (-from/-enter-active are legitimate);
        // exclude custom classes ending in --enter (e.g. td-item--enter)
        const re = /\.([a-z][a-z0-9]*(?:-[a-z0-9]+)*)-enter(?![a-z-])/g
        let m
        while ((m = re.exec(css))) {
          if (m[1].endsWith('-') ) continue
          offenders.push(path.relative(ROOT, p) + ' → .' + m[1] + '-enter')
        }
      }
    }
  }
  walk(rel('assets/css'))
  assert.deepEqual(offenders, [], 'Vue2 transition class names found (enter animations broken):\n' + offenders.join('\n'))
})

test('structure: el-date-picker/el-time-picker must not bind @change (this EP build only emits update:model-value on pick; @change silently never fires)', () => {
  const offenders = []
  const walk = dir => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name)
      if (f.isDirectory()) walk(p)
      else if (f.name.endsWith('.js')) {
        const src = fs.readFileSync(p, 'utf8')
        const re = /<el-(?:date|time)-picker[^>]*@change=/s
        if (re.test(src)) offenders.push(path.relative(ROOT, p))
      }
    }
  }
  walk(rel('renderer/js'))
  assert.deepEqual(offenders, [], 'pickers bound to @change (use @update:model-value instead): ' + offenders.join('; '))
})

/* ---------- 5. template bound identifiers must resolve to component declarations ---------- */
/* SideNav 曾因 computed 缺失 hierarchical/categories 而整块分类列表静默不渲染（v-for 遍历 undefined 零报错）。
   本测试提取模板内引用的根标识符，与组件声明集（data/computed/methods/props/模块绑定）做差集，非空即红。 */

const GLOBAL_TEMPLATE_OK = new Set([
  'if', 'else', 'true', 'false', 'null', 'undefined', 'typeof', 'in', 'of', 'new', 'String', 'Number', 'Math', 'Date', 'JSON', 'Array', 'Object', 'Boolean', 'isNaN', 'parseInt', 'parseFloat', 'Infinity',
  '$t', '$te', '$store', '$emit', '$route', '$router', '$el', '$refs', '$slots', '$attrs', '$nextTick', '$event', 'return', 'this',
  'app-icon', 'AppIcon', 'transition', 'keep-alive', 'component', 'slot', 'template', 'teleport'
])

/** 从组件源码收集声明集：computed/methods 键、data 返回键、props 键（各形态）、import 绑定、模块级名字 */
function collectDeclared (src) {
  const declared = new Set()
  for (const m of src.matchAll(/^\s{2,}(?:async\s+)?([a-zA-Z_$][\w$]*)\s*\(/gm)) declared.add(m[1])
  for (const m of src.matchAll(/^\s{2,}([a-zA-Z_$][\w$]*)\s*:[^:]/gm)) declared.add(m[1])
  for (const m of src.matchAll(/(?:const|let|var|function)\s+([a-zA-Z_$][\w$]*)/g)) declared.add(m[1])
  for (const m of src.matchAll(/import\s+(?:\{([^}]*)\}|(\w+))[^\n]*from/g)) {
    if (m[1]) m[1].split(',').forEach(x => declared.add(x.trim().split(/\s+as\s+/).pop().trim()))
    if (m[2]) declared.add(m[2])
  }
  // props：平衡括号扫描 props: { ... } 体，收顶层键（覆盖 { x: {type:...} } / { x: String } / { x: Boolean } 各形态）
  const pi = src.search(/\bprops\s*:\s*/)
  if (pi >= 0) {
    const ob = src.indexOf('{', pi)
    let depth = 0, end = src.length - 1
    for (let i = ob; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') { depth--; if (!depth) { end = i; break } }
    }
    const body = src.slice(ob + 1, end)
    const arrNames = [...body.matchAll(/['"]([a-zA-Z_$][\w$]*)['"]/g)].map(m => m[1])
    const objKeys = [...body.matchAll(/(?:^|[{,]\s*|\s)([a-zA-Z_$][\w$]*)\s*:/gm)].map(m => m[1])
    for (const n of [...arrNames, ...objKeys]) declared.add(n)
  }
  // data 单行形态：data () { return { maxed: false } } 与箭头形态 data: () => ({ pos: {...} })
  for (const m of src.matchAll(/data\s*\(\)\s*\{\s*return\s*\{([^}]*)\}/g)) {
    for (const k of m[1].matchAll(/([a-zA-Z_$][\w$]*)\s*:/g)) declared.add(k[1])
  }
  for (const m of src.matchAll(/data:\s*\(\)\s*=>\s*\(\{([\s\S]*?)\}\)/g)) {
    for (const k of m[1].matchAll(/([a-zA-Z_$][\w$]*)\s*:/g)) declared.add(k[1])
  }
  // data 多行 return { ... } 形态（宽收集：多声明的键只影响漏报率不影响误报）
  for (const m of src.matchAll(/return\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
    for (const k of m[1].matchAll(/([a-zA-Z_$][\w$]*)\s*:/g)) declared.add(k[1])
  }
  return declared
}

/** 提取模板根标识符（剥字符串/成员访问/对象键/箭头参数；v-for 与 slot 别名视作局部声明） */
function collectUsed (tpl) {
  const used = new Set()
  const scanExpr = expr => {
    const clean = expr.replace(/'[^']*'|"[^"]*"/g, '').replace(/\.\s*[\w$]+/g, '')
    for (const m of clean.matchAll(/[a-zA-Z_$][\w$]*/g)) used.add(m[0])
  }
  for (const m of tpl.matchAll(/\{\{([\s\S]*?)\}\}/g)) scanExpr(m[1])
  for (const m of tpl.matchAll(/\s(?:v-|:|@)[a-z:.]+\s*=\s*"([^"]*)"/g)) scanExpr(m[1])
  // 局部作用域：v-for 别名 / v-slot 解构
  for (const m of tpl.matchAll(/v-for\s*=\s*"([^"]*)"/g)) {
    for (const w of m[1].split(/\bin\b|\bof\b/)[0].matchAll(/[a-zA-Z_$][\w$]*/g)) used.delete(w[0])
  }
  for (const m of tpl.matchAll(/v-slot(?::[\w-]+)?\s*=\s*"([^"]*)"/g)) {
    for (const w of m[1].matchAll(/[a-zA-Z_$][\w$]*/g)) used.delete(w[0])
  }
  // 对象字面量键（:class="{rest:isRest}" 的 rest 是类名 / :style="{color:x}" 的 color 是样式属性）与箭头参数
  for (const u of [...used]) {
    const keyRe = new RegExp('[{,]\\s*' + u.replace(/[$]/g, '\\$&') + '\\s*:[^=]')
    const arrowRe = new RegExp('[\\s(,(=\'"]' + u.replace(/[$]/g, '\\$&') + '\\s*=>')
    if (keyRe.test(tpl) || arrowRe.test(tpl)) used.delete(u)
  }
  return used
}

test('structure: template bound identifiers all declared on the component (silent-undefined render guard)', () => {
  const broken = []
  for (const { file, tpl, script } of walkVue('renderer/js')) {
    const declared = collectDeclared(script)
    const missing = [...collectUsed(tpl)].filter(u => !GLOBAL_TEMPLATE_OK.has(u) && !declared.has(u))
    if (missing.length) broken.push(`${file}: ${missing.join(', ')}`)
  }
  assert.deepEqual(broken, [], 'template identifiers not declared on component (renders as undefined silently — the SideNav incident class):\n' + broken.join('\n'))
})

function walkVueRaw (dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walkVueRaw(p))
    else if (e.name.endsWith('.vue')) out.push({ file: p, src: fs.readFileSync(p, 'utf8') })
  }
  return out
}

test('structure: SFC style blocks must never be scoped (global cascade contract — scoped would hash selectors and silently orphan relocated rules)', () => {
  const bad = []
  for (const { file, src } of walkVueRaw('renderer/js')) {
    for (const m of src.matchAll(/<style([^>]*)>/g)) {
      if (/\sscoped(\b)?/.test(m[1])) bad.push(file)
    }
  }
  assert.deepEqual(bad, [], '<style scoped> found (breaks global cascade contract):\n' + bad.join('\n'))
})
