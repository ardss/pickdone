#!/usr/bin/env node
/**
 * i18n hardcoded-string scan (SOP-05 automation) — scans user-visible APIs for Chinese constants that bypass the $t language pack
 * Usage: node cli/check-i18n.js [--all]
 * By default scans only uncommitted git changes (incremental mode, fast); --all scans the whole repo
 * Whitelist: comment lines, the i18n language-pack files themselves
 */
const { execFileSync } = require('child_process')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const CN_RE = /[\u4e00-\u9fff]/
// User-visible API surface (extend on false negatives): messages/popups/placeholders/label/title/aria
// Known debt: list of legacy hardcoded copy, to be moved out one by one once absorbed by an i18n migration batch
const KNOWN_DEBT = ['renderer/js/components/TomatoAbandonModal.vue']
const VISIBLE_RE = /\$?(message|msgbox|confirm|alert|success|error|warning|info)\s*\(|placeholder=|aria-label=|\btitle=|\blabel=/i
const IGNORE_FILES = /i18n[/\\]|check-i18n/

function scanFile (p, text) {
  const hits = []
  const lines = text.split('\n')
  lines.forEach((ln, i) => {
    if (!CN_RE.test(ln)) return
    if (ln.trim().startsWith('//') || ln.trim().startsWith('*') || ln.trim().startsWith('/*')) return
    if (!VISIBLE_RE.test(ln)) return
    if (/console\.(log|error|warn|info)\(/.test(ln)) return // console.* is developer logging, not user-visible
    if (KNOWN_DEBT.some(f => p.replace(/\\/g, '/').endsWith(f))) return // legacy utils copy, pending an i18n migration batch
    if (/\$t\(|i18n\.t\(|\bt\(/.test(ln)) return // defensive fallback already routed through an i18n t() helper
    hits.push(`${path.relative(ROOT, p)}:${i + 1}: ${ln.trim().slice(0, 100)}`)
  })
  return hits
}

let files = []
if (process.argv.includes('--all')) {
  const walk = d => {
    for (const f of require('fs').readdirSync(d)) {
      const p = path.join(d, f)
      if (require('fs').statSync(p).isDirectory()) { if (!/node_modules|vendor|i18n/.test(f)) walk(p); continue }
      if ((f.endsWith('.js') || f.endsWith('.vue')) && !IGNORE_FILES.test(p)) files.push(p)
    }
  }
  walk(path.join(ROOT, 'renderer', 'js'))
} else {
  const diff = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: ROOT, encoding: 'utf8' })
    + '\n' + execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }) // 未跟踪新文件一并查,否则新建文件绕过检查(2026-09-05 复核 P2)
  files = diff.split('\n').filter(f => (f.endsWith('.js') || f.endsWith('.vue')) && f.startsWith('pickdone'))
    .map(f => path.join(ROOT, f)).filter(p => { try { return require('fs').statSync(p).isFile() } catch { return false } })
  if (!files.length) { console.log('无未提交 js/vue 改动，退出（--all 可全仓扫）'); process.exit(0) }
}

const hits = []
for (const p of files) {
  if (IGNORE_FILES.test(p)) continue
  hits.push(...scanFile(p, require('fs').readFileSync(p, 'utf8')))
}

if (hits.length) {
  console.error(`✗ 检出 ${hits.length} 行硬编码中文文案（应走 $t 语言包）：`)
  hits.slice(0, 20).forEach(h => console.error('  - ' + h))
  console.error('提示: 仅注释/非用户可见面误报可直接在 VISIBLE_RE/白名单调整')
  process.exit(1)
}
console.log('✓ i18n 硬编码扫描通过（扫了 ' + files.length + ' 个文件）')
