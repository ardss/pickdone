#!/usr/bin/env node
/**
 * CSS migration inventory — read-only analysis for the "component absorption" refactor.
 * 用法: node scripts/css-inventory.mjs [--md]
 * 产出:
 *   - 控制台摘要(--md 时输出 markdown 台账到 stdout,重定向到 analysis/css-迁移台账.md)
 * 规则:
 *   - 解析 assets/css/theme-dark.css 的全部顶层规则(含 @media 内层);style-1..4 已退役
 *   - 家族 = 首个 class 的 BEM block 前缀(首个 `__`/修饰符之前)
 *   - 主归属 = 家族类名在各 .vue 文件(模板+脚本)中出现次数最多的文件;分散(≥3 文件且最大占比 <50%)判为共享
 *   - 死代码 = 家族内全部类名在所有 .vue 中零出现
 *   - 依赖 = 家族规则体引用的 var(--x) 清单
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const FILES = ['theme-dark.css']
  .map(f => path.join(ROOT, 'assets', 'css', f))

// ---- naive CSS block parser (handles comments, strings, @media nesting) ----
// Stricter: tokenize top-level; for @media recurse one level.
function extractRules (css, media = '') {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = []
  let i = 0
  while (i < css.length) {
    const open = css.indexOf('{', i)
    if (open < 0) break
    const header = css.slice(i, open).trim()
    // find matching close brace
    let depth = 1, j = open + 1
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++
      else if (css[j] === '}') depth--
      j++
    }
    const body = css.slice(open + 1, j - 1)
    if (header.startsWith('@media')) {
      rules.push(...extractRules(body, header))
    } else if (header.startsWith('@')) {
      // keyframes/font-face etc: keep whole as one opaque rule
      rules.push({ selector: header, body, media })
    } else if (header) {
      header.split(',').forEach(h => rules.push({ selector: h.trim(), body, media }))
    }
    i = j
  }
  return rules
}

function blockOf (selector) {
  const m = selector.match(/\.([A-Za-z][\w-]*)/)
  if (!m) return null
  let name = m[1]
  const cut = name.search(/__[A-Za-z]|--[A-Za-z]|--/)
  if (cut > 0) name = name.slice(0, cut)
  return name
}

function classNamesIn (selector) {
  return selector.match(/\.[A-Za-z][\w-]*/g) || []
}

// ---- gather vue usage ----
const vueFiles = []
const walk = dir => {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p)
    else if (f.endsWith('.vue') || f.endsWith('.js')) vueFiles.push(p)
  }
}
walk(path.join(ROOT, 'renderer', 'js'))

const fileUsage = new Map() // className -> Map(file -> count)
for (const f of vueFiles) {
  const src = fs.readFileSync(f, 'utf8')
  const classes = src.match(/[A-Za-z][\w-]*/g) || []
  for (const c of classes) {
    if (!fileUsage.has(c)) fileUsage.set(c, new Map())
    const m = fileUsage.get(c)
    m.set(f, (m.get(f) || 0) + 1)
  }
}
const shortName = f => path.relative(path.join(ROOT, 'renderer', 'js'), f)

// ---- build families ----
const families = new Map() // block -> {rules:[{file,selector,body,media}], files:Set}
for (const file of FILES) {
  const css = fs.readFileSync(file, 'utf8')
  for (const r of extractRules(css)) {
    const block = blockOf(r.selector)
    if (!block) continue
    if (!families.has(block)) families.set(block, { rules: [], files: new Set() })
    const fam = families.get(block)
    fam.rules.push({ file: path.basename(file), ...r })
    fam.files.add(path.basename(file))
  }
}

const rows = []
for (const [block, fam] of families) {
  const classNames = new Set()
  for (const r of fam.rules) for (const c of classNamesIn(r.selector)) classNames.add(c.slice(1))
  // usage across vue files (template+script identifiers)
  const perFile = new Map()
  let total = 0
  for (const c of classNames) {
    const m = fileUsage.get(c)
    if (!m) continue
    for (const [f, n] of m) {
      perFile.set(f, (perFile.get(f) || 0) + n)
      total += n
    }
  }
  const owners = [...perFile.entries()].sort((a, b) => b[1] - a[1])
  const top = owners[0]
  const topShare = top && total ? top[1] / total : 0
  const vueOwnerCount = new Set(owners.map(([f]) => f)).size
  let status, owner
  if (total === 0) { status = 'DEAD'; owner = '-' }
  else if (vueOwnerCount >= 3 && topShare < 0.5) { status = 'SHARED'; owner = '(共享→base)' }
  else { status = 'MIGRATABLE'; owner = top ? shortName(top[0]) : '(未知)' }
  const vars = new Set()
  for (const r of fam.rules) {
    for (const v of r.body.match(/var\(--[\w-]+/g) || []) vars.add(v.slice(4))
  }
  const lines = fam.rules.reduce((n, r) => n + r.body.split('\n').length + 1, 0)
  rows.push({ block, status, owner, lines, files: [...fam.files].join(','), vars: [...vars].slice(0, 8), varN: vars.size, dark: fam.files.has('theme-dark.css') })
}

rows.sort((a, b) => b.lines - a.lines)
const sum = f => rows.filter(f).reduce((n, r) => n + r.lines, 0)
const totalLines = FILES.reduce((n, f) => n + fs.readFileSync(f, 'utf8').split('\n').length, 0)

const md = []
md.push('# CSS 迁移台账(组件吸收重构)')
md.push('')
md.push(`生成: scripts/css-inventory.mjs · 全局文件总行数: **${totalLines}**(theme-dark)`)
md.push('')
md.push(`| 状态 | 家族数 | 行数 | 占比 |`)
md.push(`|---|---|---|---|`)
md.push(`| 可迁移(有主归属) | ${rows.filter(r => r.status === 'MIGRATABLE').length} | ${sum(r => r.status === 'MIGRATABLE')} | ${Math.round(sum(r => r.status === 'MIGRATABLE') / totalLines * 100)}% |`)
md.push(`| 共享(升入 base) | ${rows.filter(r => r.status === 'SHARED').length} | ${sum(r => r.status === 'SHARED')} | ${Math.round(sum(r => r.status === 'SHARED') / totalLines * 100)}% |`)
md.push(`| 死代码(直接删) | ${rows.filter(r => r.status === 'DEAD').length} | ${sum(r => r.status === 'DEAD')} | ${Math.round(sum(r => r.status === 'DEAD') / totalLines * 100)}% |`)
md.push('')
md.push(`## 可迁移家族(按行数降序,先叶子后容器由人工在批次中把握)`)
md.push('')
md.push(`| 家族 | 行数 | 主归属组件 | 涉及全局文件 | dark 规则 | var 依赖数 | 主要 var |`)
md.push(`|---|---|---|---|---|---|---|`)
for (const r of rows.filter(r => r.status === 'MIGRATABLE')) {
  md.push(`| ${r.block} | ${r.lines} | ${r.owner} | ${r.files} | ${r.dark ? '有' : '-'} | ${r.varN} | ${r.vars.join(' ') || '-'} |`)
}
md.push('')
md.push(`## 共享家族(升入 base.css,不硬塞组件)`)
md.push('')
md.push(`| 家族 | 行数 | 涉及文件 |`)
md.push(`|---|---|---|`)
for (const r of rows.filter(r => r.status === 'SHARED')) md.push(`| ${r.block} | ${r.lines} | ${r.files} |`)
md.push('')
md.push(`## 死代码候选(全 .vue 零引用;删除前人工复核动态拼接类名)`)
md.push('')
md.push(`| 家族 | 行数 | 涉及文件 |`)
md.push(`|---|---|---|`)
for (const r of rows.filter(r => r.status === 'DEAD')) md.push(`| ${r.block} | ${r.lines} | ${r.files} |`)
md.push('')

if (process.argv.includes('--md')) {
  console.log(md.join('\n'))
} else {
  console.log(md.slice(0, 12).join('\n'))
  console.log('... (npm run css:inventory -- --md > analysis/css-迁移台账.md)')
}
