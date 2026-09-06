#!/usr/bin/env node
/**
 * Sanitized-fingerprint check (SOP-02 automation) — greps six fingerprint classes; any non-whitelisted hit exits non-zero
 * Usage: node cli/check-fingerprint.js
 * Whitelist: this file itself, self-referential "must not appear" phrases in comments, test assertions
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SCAN_DIRS = ['src', 'renderer', 'cli', 'assets/css', 'browser-dev']
const EXT = new Set(['.js', '.css', '.json', '.html', '.vue'])

// Fingerprint classes (regex + description). To add a new fingerprint pattern: add a line here.
const RULES = [
  [/com\.eve\b/i, '遗留包名'],
  [/\btdChannel(Code)?\b/i, '遗留渠道字段'],
  [/原样拷贝|逐条拷贝|逐项拷贝|逐像素/, '不当措辞'],
  [/\bindex\.25f4ae00\b|\bchunk-common\.18eac467\b|\bwidget\.fdb3c04f\b|\bchunk-vendors\.5cacfce0\b/i, '遗留构建产物文件名'],
  [/e1b2d6ce|c93bd561|022fdf96|0fa4a437/, '遗留音频 hash 文件名'],
  [/\bdata-v-[0-9a-f]{8}\b/, '遗留 Vue scoped hash'],
  [/Todo\s?清单|Day\s?Todo|序事/, '遗留品牌名'],
  // 开发者本机盘符绝对路径（K:\tmp 等）会随 cli/** 进安装包——例示文案一律用 $env:TEMP / /tmp 相对形态
  // \\{1,2}：源码里的 JS 转义形态（"K:\\tmp"，字节为双反斜杠）与原始单反斜杠形态都要抓（复核轮实锤单杠正则漏报）
  [/["'`]([A-Za-z]):\\{1,2}(?:tmp|temp|Users)\\{1,2}[^"'`]*["'`]/i, '本机绝对路径'],
]

const hits = []
function walk (dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    const st = fs.statSync(p)
    if (st.isDirectory()) { if (f !== 'node_modules' && f !== 'vendor' && f !== 'dist') walk(p); continue }
    if (!EXT.has(path.extname(f))) continue
    if (/check-fingerprint|SOURCES\.md/.test(f)) continue
    const text = fs.readFileSync(p, 'utf8')
    for (const [re, label] of RULES) {
      const m = text.match(re)
      if (m) hits.push({ file: path.relative(ROOT, p), label, snippet: text.slice(Math.max(0, m.index - 30), m.index + 50).replace(/\n/g, ' ') })
    }
  }
}
SCAN_DIRS.forEach(d => { const p = path.join(ROOT, d); if (fs.existsSync(p)) walk(p) })

if (hits.length) {
  console.error(`✗ 检出 ${hits.length} 处指纹（发布阻塞）：`)
  hits.slice(0, 20).forEach(h => console.error(`  - [${h.label}] ${h.file}: ${h.snippet}`))
  process.exit(1)
}
console.log('✓ 指纹扫描通过（八类规则 0 命中，含旧版品牌名与本机绝对路径）')
