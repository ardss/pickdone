#!/usr/bin/env node
/**
 * CSS finisher — final pass of the component-absorption refactor.
 * 把 style-1..4.css 的全部剩余规则按归属 relocate,目标清空并退役这四个文件:
 *   - el-*            → base.css(Element Plus 覆盖区,EP 运行时类,全局必须)
 *   - fc-* / cal-*    → CalendarView.vue(FullCalendar 生成 DOM)
 *   - pop-*           → base.css(Vue transition 类,模板以 name="pop" 隐式引用)
 *   - tour-*          → Onboarding.vue   qa-* → QuickAdd.vue
 *   - 其余:按 .vue/.js 引用频次定主归属;主归属是 .vue → 该 SFC;否则 → base.css
 * 不删除任何规则(零风险);@media 结构原样保留;注释随所在规则整体移动。
 * 用法: node scripts/css-finish.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CSS = f => path.join(ROOT, 'assets', 'css', f)
const SRCS = ['style-1.css', 'style-2.css', 'style-3.css', 'style-4.css'].map(CSS)
const BASE = CSS('base.css')
const JS = path.join(ROOT, 'renderer', 'js')

// ---- comment/string-aware brace scanner ----
function nextMeaningful (css, from) {
  let i = from
  while (i < css.length) {
    if (css.startsWith('/*', i)) { const e = css.indexOf('*/', i + 2); if (e < 0) return -1; i = e + 2; continue }
    const ch = css[i]
    if (ch === '"' || ch === "'") { const e = css.indexOf(ch, i + 1); if (e < 0) return -1; i = e + 1; continue }
    if (ch === '{') return i
    i++
  }
  return -1
}
function matchEnd (css, open) {
  let depth = 1, j = open + 1
  while (j < css.length && depth > 0) {
    if (css.startsWith('/*', j)) { const e = css.indexOf('*/', j + 2); if (e < 0) return css.length; j = e + 2; continue }
    const ch = css[j]
    if (ch === '"' || ch === "'") { const e = css.indexOf(ch, j + 1); if (e < 0) return css.length; j = e + 1; continue }
    if (ch === '{') depth++
    else if (ch === '}') depth--
    j++
  }
  return j
}

// ---- usage index across .vue/.js ----
const usage = new Map() // className -> Map(relFile -> count)
const walk = dir => {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    if (fs.statSync(p).isDirectory()) walk(p)
    else if (/\.(vue|js)$/.test(f)) {
      const rel = path.relative(JS, p).replace(/\\/g, '/')
      const classes = fs.readFileSync(p, 'utf8').match(/[A-Za-z][\w-]*/g) || []
      for (const c of classes) {
        if (!usage.has(c)) usage.set(c, new Map())
        const m = usage.get(c)
        m.set(rel, (m.get(rel) || 0) + 1)
      }
    }
  }
}
walk(JS)

function firstClass (selector) {
  const m = selector.match(/\.([A-Za-z][\w-]*)/)
  return m ? m[1] : null
}
function blockOf (cls) {
  const cut = cls.search(/__[A-Za-z]|--[A-Za-z]/)
  return cut > 0 ? cls.slice(0, cut) : cls
}

// ---- routing ----
const JS_OWNER_MAP = {
  'utils/onboardingTours.js': 'components/Onboarding.vue'
}
function routeFor (block, selector) {
  if (/^el-/.test(block)) return { target: 'base', section: 'EP' }
  if (/^fc-/.test(block)) return { target: 'views/CalendarView.vue', section: 'cal' }
  if (/^cal-/.test(block)) return { target: 'views/CalendarView.vue', section: 'cal' }
  if (/^pop-/.test(block)) return { target: 'base', section: 'transition' }
  if (/^tour-/.test(block)) return { target: 'components/Onboarding.vue', section: 'onboarding' }
  if (/^qa-/.test(block)) return { target: 'components/QuickAdd.vue', section: 'quickadd' }
  // owner by usage of the block name across sources
  const m = usage.get(block)
  if (m) {
    const owners = [...m.entries()].sort((a, b) => b[1] - a[1])
    const top = owners[0]
    if (top && /\.vue$/.test(top[0])) return { target: top[0], section: 'component' }
    if (top && JS_OWNER_MAP[top[0]]) return { target: JS_OWNER_MAP[top[0]], section: 'component' }
  }
  return { target: 'base', section: 'shared' }
}

// ---- single-pass relocation per source file ----
const targets = new Map() // 'rel|media|section' -> [raw]
function walkRelocate (css, file, media) {
  let result = ''
  let i = 0
  while (i < css.length) {
    const open = nextMeaningful(css, i)
    if (open < 0) { result += css.slice(i); break }
    const header = css.slice(i, open).trim()
    const end = matchEnd(css, open)
    const body = css.slice(open + 1, end - 1)
    if (header.startsWith('@media')) {
      result += header + ' {' + walkRelocate(body, file, header) + '}'
      i = end
      continue
    }
    if (header.startsWith('@') || !header) {
      // keyframes/font-face/whitespace: keep in place (keyframes are global by nature)
      result += css.slice(i, end)
      i = end
      continue
    }
    const cls = firstClass(header)
    const block = cls ? blockOf(cls) : null
    if (!block) { result += css.slice(i, end); i = end; continue }
    const { target, section } = routeFor(block, header)
    const key = target + '|' + media + '|' + section
    if (!targets.has(key)) targets.set(key, [])
    targets.get(key).push((media ? '  ' : '') + css.slice(i, end).trim())
    i = end
  }
  return result
}

for (const file of SRCS) {
  const css = fs.readFileSync(file, 'utf8')
  const rest = walkRelocate(css, file, '')
  const stripped = rest.replace(/\n{3,}/g, '\n\n').trim()
  fs.writeFileSync(file, stripped ? stripped + '\n' : '')
  console.log(`${path.basename(file)}: drained`)
}

// ---- write targets ----
const HEADER = '\n/* ===== 迁移自全局沉积文件(scripts/css-finish.mjs):随组件/分区生灭 ===== */\n'
for (const [key, rules] of targets) {
  const [target, media, section] = key.split('|')
  let chunk = (media ? media + ' {\n' : '') + rules.join('\n') + (media ? '\n}\n' : '\n')
  if (target === 'base') {
    let base = fs.readFileSync(BASE, 'utf8')
    const tag = '/* == absorbed:' + section + ' == */'
    if (!base.includes(tag)) base = base.trimEnd() + '\n\n' + tag + HEADER + chunk
    else {
      // append into the existing section
      const i = base.indexOf(tag)
      const j = base.indexOf('\n/* == absorbed:', i + 10)
      const at = j < 0 ? base.length : j
      base = base.slice(0, at) + chunk + base.slice(at)
    }
    fs.writeFileSync(BASE, base)
  } else {
    const sfc = path.join(JS, target)
    let s = fs.readFileSync(sfc, 'utf8')
    const idx = s.lastIndexOf('</style>')
    if (idx >= 0) s = s.slice(0, idx) + chunk + s.slice(idx)
    else s = s.trimEnd() + '\n<style>' + chunk + '</style>\n'
    fs.writeFileSync(sfc, s)
  }
}
console.log('targets updated:', [...targets.keys()].map(k => k.split('|')[0] + '#' + k.split('|')[2]).join(', '))
