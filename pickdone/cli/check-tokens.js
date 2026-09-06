#!/usr/bin/env node
/**
 * Style token discipline check (SOP-03 automation) — prevents "dark-mode white block" regressions
 * Background: repeated dark-mode failures in 2026-08 (category-page group white cards / EP select white blocks / white notification toasts),
 * all rooted in source CSS hardcoding light values while the theme-dark patch missed them. Rule: panel-type backgrounds must use tokens.
 *
 * Rule set (add new rules as a line in RULES; exemptions go into WHITELIST as file:line or file:selector fragment):
 *  R1 hardcoded white panel background — background(-color): #fff / #ffffff (source CSS, theme-dark excluded)
 *  R2 near-white light backgrounds hardcoded — #fafbfc/#f5f7f7/#f8f9fa class, becomes a bright block in dark mode
 *  R3 scattered gray text values — #333/#000/#6d6d6d/#606266 etc. should use --text-*
 * Usage: node cli/check-tokens.js [--all]   (full scan by default; cheap enough to keep on)
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const FILES = ['assets/css/base.css', 'assets/css/theme-dark.css']

// Exemptions: white that is intentional by design (does not flip with the theme). Substring matching.
const WHITELIST = [
  '纯白定稿', // tomato-float card background: intentionally pure white as marked by a comment (whitelist matches by inline comment)
  'sn-dot.none', // sidebar no-category dot's white center
  'border-radius: 50%; background: #fff', // el-switch knob white circle (standard control shape, contrast against the colored track)
  'xs-printing', // print background
  'ds-today-dot', // white today-dot on brand background
  'td-check-svg', // checkmark stroke
  '--dot:#f2a63b', '--dot:#7ac74f', // Onboarding demo category colors
  '.tomato {', // tomato float card: user-final 2026-08-31 "interior always pure white, never theme-flipped" (context match)
  'tf-abandon', // abandon mini-dialog: forced light-token scope, white card by design (context match)
]

const RULES = [
  [/background(?:-color)?:\s*#fff(?:fff)?\b/i, 'R1 面板白底硬编码 → var(--panel, #fff)'],
  [/background(?:-color)?:\s*#(fafbfc|f5f7f7|f8f9fa|f5f5f5|f0f2f5)\b/i, 'R2 近白浅底 → var(--gray-bg) 或 var(--panel)'],
  [/color:\s*#(3333?33|000|6d6d6d|606266)\b/i, 'R3 文字灰散值 → var(--text-1)/var(--text-2)/var(--text-3)'],
  // R4/R5 档位纪律（2026-09-04 归一）：原 scope 的 style-2/3.css 已在组件吸收重构中退役，
  // 存量散值随规则迁入各组件 <style>，全局层不再拦截（component-level 规则由组件作者维护）
]

const hits = []
for (const rel of FILES) {
  const p = path.join(ROOT, rel)
  if (!fs.existsSync(p)) continue
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/)
  lines.forEach((line, i) => {
    for (const [re, msg, scope] of RULES) {
      if (scope && !scope.includes(rel)) continue
      if (re.test(line)) {
        // match against the line AND its 8-line look-back context, so selector-scoped exemptions survive upstream line drift
      const ctx = lines.slice(Math.max(0, i - 8), i + 1).join('\n')
        if (WHITELIST.some(w => line.includes(w) || ctx.includes(w))) continue
        hits.push(`${rel}:${i + 1}  [${msg}]\n    ${line.trim().slice(0, 120)}`)
      }
    }
  })
}

if (hits.length) {
  console.error(`✗ token 纪律检查失败，${hits.length} 处命中（写死浅色值会在深色模式下破损）：`)
  hits.forEach(h => console.error('  ' + h))
  console.error('\n改法：面板/卡片/弹层背景 → var(--panel, #fff)；页面底 → var(--bg, #fff)；文字 → var(--text-*)；浅灰底 → var(--gray-bg)。')
  console.error('确属功能本意白色的（如滑块圆点），往本文件 WHITELIST 登记并注释原因。')
  process.exit(1)
}
console.log('✓ token 纪律检查通过（0 处写死浅色背景/文字灰散值）')
