#!/usr/bin/env node
/**
 * CSS family mover — one batch of the component-absorption refactor.
 * 用法: node scripts/css-move.mjs --sfc renderer/js/views/ProjectView.vue --family proj-ms --family proj-ms-row
 *   [--src assets/css/style-3.css ...]  默认搬全部五件全局文件
 * 行为:
 *   1. 从全局文件中切出「选择器里任一 class 以 --family 前缀开头」的顶层规则/@media 内层规则
 *   2. 追加到 --sfc 的 <style> 块(无则创建;@media 规则按原媒体条件重组)
 *   3. 全局文件中原地删除(整段 @media 若被搬空则一并删除)
 * 搬完请:bump 缓存戳 → build:renderer → visual:check → smoke:interact → 提交
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const SFC = path.join(ROOT, argOf('--sfc', ''))
if (!SFC) { console.error('--sfc required'); process.exit(1) }
const FAMILIES = []
for (let i = 0; i < args.length; i++) if (args[i] === '--family') FAMILIES.push(args[i + 1])
if (!FAMILIES.length) { console.error('--family required (repeatable)'); process.exit(1) }
const SRCS = []
for (let i = 0; i < args.length; i++) if (args[i] === '--src') SRCS.push(path.join(ROOT, args[i + 1]))
const DEFAULT_SRCS = ['style-1.css', 'style-2.css', 'style-3.css', 'style-4.css', 'theme-dark.css'].map(f => path.join(ROOT, 'assets', 'css', f))
const files = SRCS.length ? SRCS : DEFAULT_SRCS

const ruleCount = css => (css.replace(/\/\*[\s\S]*?\*\//g, '').match(/\{/g) || []).length

const matches = selector => {
  const classes = selector.match(/\.[A-Za-z][\w-]*/g) || []
  return classes.some(c => FAMILIES.some(fam => c.slice(1) === fam || c.slice(1).startsWith(fam + '__') || c.slice(1).startsWith(fam + '-') || c.slice(1).startsWith(fam + ':')))
}

// Split a stylesheet into top-level segments: {type:'rule'|'media'|'other', header, body, raw}
function topSegments (css) {
  const segs = []
  css = css // keep comments: they move with their block context; leading comments before a moved rule are dropped (acceptable)
  let i = 0
  while (i < css.length) {
    const open = css.indexOf('{', i)
    if (open < 0) { segs.push({ type: 'tail', raw: css.slice(i) }); break }
    if (css.slice(i, open).trim() === '') { // whitespace between segments
      segs.push({ type: 'ws', raw: css.slice(i, open) })
      i = open
    } else {
      segs.push({ type: 'ws', raw: css.slice(i, open).replace(/\S[\s\S]*$/, m => m) })
      i = open
    }
    // recompute: header starts after previous ';'/'}' — simpler: header = text from i back to last } or ;
    const hStart = i
    let depth = 1, j = open + 1
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++
      else if (css[j] === '}') depth--
      j++
    }
    const header = css.slice(hStart, open).trim()
    const body = css.slice(open + 1, j - 1)
    segs.push({ type: header.startsWith('@media') ? 'media' : (header.startsWith('@') ? 'other' : 'rule'), header, body, raw: css.slice(hStart, j) })
    i = j
  }
  return segs
}

function processFile (css, out) {
  const segs = topSegments(css)
  let result = ''
  for (const s of segs) {
    if (s.type === 'rule') {
      if (matches(s.header)) out.moved.push(s.raw.trim()) 
      else result += s.raw
    } else if (s.type === 'media') {
      // recurse one level: split inner rules
      const inner = topSegments(s.body)
      let keep = '', movedAny = false
      for (const t of inner) {
        if (t.type === 'rule' && matches(t.header)) { out.moved.push(t.raw.trim()); movedAny = true }
        else if (t.type === 'media') { // nested media (rare) — keep as-is
          keep += t.raw
        } else keep += (t.raw || '')
      }
      if (movedAny && keep.trim()) result += s.header + ' {' + keep + '}'
      else if (movedAny) out.movedMedia.push({ header: s.header, rules: [] }) // fully moved; inner rules already pushed raw
      else result += s.raw
    } else {
      result += (s.raw || '')
    }
  }
  // collapse 3+ blank lines left by removals
  return result.replace(/\n{3,}/g, '\n\n')
}

// media-wrapped moved rules need their media header preserved: redo with tracking
function nextMeaningful (css, from) {
  // next '{' at top level of text, skipping comments and strings; returns index or -1
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

function moveFrom (css) {
  const moved = [] // {media, raw}
  function walk (css, media) {
    let result = ''
    let i = 0
    while (i < css.length) {
      const open = nextMeaningful(css, i)
      if (open < 0) { result += css.slice(i); break }
      // header text between previous boundary and open (comments preserved in output)
      const header = css.slice(i, open).trim()
      let depth = 1, j = open + 1
      while (j < css.length && depth > 0) {
        if (css.startsWith('/*', j)) { const e = css.indexOf('*/', j + 2); if (e < 0) { j = css.length; break } j = e + 2; continue }
        const ch = css[j]
        if (ch === '"' || ch === "'") { const e = css.indexOf(ch, j + 1); if (e < 0) { j = css.length; break } j = e + 1; continue }
        if (ch === '{') depth++
        else if (ch === '}') depth--
        j++
      }
      const body = css.slice(open + 1, j - 1)
      if (header.startsWith('@media')) {
        result += header + ' {' + walk(body, header) + '}'
      } else if (header.startsWith('@')) {
        result += css.slice(i, j)
      } else if (header) {
        if (matches(header)) moved.push({ media, raw: (media ? '  ' : '') + css.slice(i, j).trim() })
        else result += css.slice(i, j)
      } else {
        result += css.slice(i, open) // whitespace
      }
      i = j
    }
    return result
  }
  const rest = walk(css, '')
  return { moved, rest: rest.replace(/\n{3,}/g, '\n\n') }
}

let totalMoved = 0
const grouped = [] // {media, css}
for (const file of files) {
  const css = fs.readFileSync(file, 'utf8')
  const { moved, rest } = moveFrom(css)
  fs.writeFileSync(file, rest.endsWith('\n') || rest === '' ? rest : rest + '\n')
  totalMoved += moved.length
  console.log(`${path.basename(file)}: moved ${moved.length} rules, remaining ${ruleCount(rest)} blocks`)
  for (const m of moved) {
    let g = grouped.find(x => x.media === m.media)
    if (!g) { g = { media: m.media, css: [] }; grouped.push(g) }
    g.css.push(m.raw)
  }
}

if (!totalMoved) { console.log('nothing matched'); process.exit(0) }

let cssOut = '\n/* ===== 迁移自全局沉积文件(scripts/css-move.mjs):以下规则随组件生灭 ===== */\n'
for (const g of grouped) {
  if (g.media) cssOut += g.media + ' {\n' + g.css.join('\n') + '\n}\n'
  else cssOut += g.css.join('\n') + '\n'
}

let sfc = fs.readFileSync(SFC, 'utf8')
if (/<style[^>]*>/.test(sfc)) {
  sfc = sfc.replace(/<\/style>(\s*)<\/template>|<\/style>/, m => m) // noop guard
  const idx = sfc.lastIndexOf('</style>')
  sfc = sfc.slice(0, idx) + cssOut + sfc.slice(idx)
} else {
  sfc = sfc.replace(/\s*$/, '') + '\n<style>' + cssOut + '</style>\n'
}
fs.writeFileSync(SFC, sfc)
console.log(`SFC ${path.basename(SFC)} <style> += ${totalMoved} rules`)
