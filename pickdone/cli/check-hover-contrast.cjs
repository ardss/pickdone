#!/usr/bin/env node
/* Hover contrast gate: a generic button's :hover text-color rule once overrode the white text of solid-background buttons
 * (case: .mini:hover{color:brand blue} × .primary blue bg white text → in batch mode "exit batch" hover showed blue-on-blue invisible text).
 * This check enumerates buttons with multi-class combinations found in templates, simulates the cascade under light/dark themes,
 * takes the winning color and background in the :hover state, and fails when they are the same color (invisible text) or
 * when a solid-background button's white text is rewritten to a non-white color by a hover rule (same class of hazard).
 * Only supports this project's selector vocabulary: .a.b combinations, :hover, html[data-theme="dark"] prefix. */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CSS_FILES = ['base.css', 'style-1.css', 'style-2.css', 'style-3.css', 'style-4.css', 'theme-dark.css']
  .map(f => path.join(ROOT, 'assets', 'css', f));

// 1) Collect static multi-class button combinations from templates; dynamically-bound :class combos (white-text solid-bg variants) are added manually
const TPL_DIR = path.join(ROOT, 'renderer', 'js');
const combos = new Set();
function walk(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p);
    else if (f.name.endsWith('.js') || f.name.endsWith('.vue')) {
      const src = fs.readFileSync(p, 'utf8');
      for (const m of src.matchAll(/class="([^"{}]+)"/g)) {
        const cls = m[1].trim().split(/\s+/).filter(Boolean);
        if (cls.length > 1) combos.add(cls.join(' '));
      }
    }
  }
}
walk(TPL_DIR);
// Combos produced by dynamic binding (not visible to template scanning)
combos.add('mini primary');
combos.add('primary mini-lg');
combos.add('mini danger');
combos.add('ep-mini danger');
combos.add('ob-btn ob-btn--primary');
combos.add('sn-foot-btn sn-foot-btn--danger');
combos.add('btn btn--danger rc-danger-btn');

// Only care about combos "containing solid-bg/white-text or danger variants", avoiding full-volume noise
const INTEREST = /(^|\s)(primary|danger|btn--danger|ob-btn--primary|sn-foot-btn--danger|danger-btn)(\s|$)/;
const targets = [...combos].filter(c => INTEREST.test(c));

// 2) Parse CSS: supports only .a.b(:hover)? with an optional html[data-theme="dark"] prefix
const rules = [];
CSS_FILES.forEach((file, fi) => {
  const css = fs.readFileSync(file, 'utf8');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const decls = {};
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i < 0) continue;
      decls[d.slice(0, i).trim()] = d.slice(i + 1).trim();
    }
    if (!decls.color && !decls.background && !decls['background-color']) continue;
    // Parse comma-separated selector groups segment by segment (guard rules commonly use .a, .a:hover form)
    for (const part of m[1].split(',')) {
      const sel = part.trim().replace(/\s+/g, ' ');
      const dark = sel.startsWith('html[data-theme="dark"]');
      const body = dark ? sel.replace(/^html\[data-theme="dark"\]\s*/, '') : sel;
      if (!body || body.includes('[') || body.includes(' ') || body.includes('>')) continue; // keep pure class combinations only
      const hover = body.includes(':hover');
      const classes = body.replace(':hover', '').split('.').filter(Boolean);
      if (!classes.length) continue;
      rules.push({ dark, hover, classes, decls, spec: classes.length + (hover ? 10 : 0) + (dark ? 100 : 0), order: rules.length });
    }
  }
});

const normColor = c => {
  if (!c) return null;
  c = c.replace(/\s+/g, ' ');
  if (c === '#fff' || c === '#ffffff' || c === 'white' || c === 'rgb(255, 255, 255)') return 'WHITE';
  return c.toLowerCase();
};
const isTransparent = c => !c || c === 'none' || c === 'transparent';

function cascade(clsList, hover, dark) {
  let color = null, bg = null, bestC = -1, bestB = -1;
  for (const r of rules) {
    if (r.dark !== dark || r.hover !== hover) continue;
    if (!r.classes.every(c => clsList.includes(c))) continue;
    if (r.spec >= bestC && r.decls.color) { color = r.decls.color; bestC = r.spec; }
    if (r.spec >= bestB && (r.decls.background || r.decls['background-color'])) { bg = r.decls.background || r.decls['background-color']; bestB = r.spec; }
  }
  return { color, bg };
}

let fail = 0;
for (const combo of targets) {
  const clsList = combo.split(' ');
  for (const dark of [false, true]) {
    const base = cascade(clsList, false, dark);
    const hov = cascade(clsList, true, dark);
    const solid = !isTransparent(base.bg);
    const hc = normColor(hov.color), bc = normColor(hov.bg || base.bg);
    const theme = dark ? 'dark' : 'light';
    if (solid && hc && hc === bc) {
      console.error(`✗ [${theme}] .${combo}：悬浮文字色与背景色相同(${hov.color} on ${hov.bg || base.bg})，文字隐形`);
      fail++;
    } else if (solid && normColor(base.color) === 'WHITE' && hov.color && normColor(hov.color) !== 'WHITE') {
      console.error(`✗ [${theme}] .${combo}：白字实心底按钮被 hover 规则改写为 ${hov.color}（同类隐患）`);
      fail++;
    }
  }
}

if (fail) { console.error(`hover 对比度检查：${fail} 处失败`); process.exit(1); }
console.log(`✓ hover 对比度检查通过（${targets.length} 个按钮组合 × 浅/深两主题）`);

/* —— Negative self-verification: if the gate's own cascade logic breaks it stays permanently green, so inject a bad rule to prove "removing the guard must error" ——
 * The scenario replicates the real regression (batch mode "exit batch" blue-on-blue):
 *   .primary{background:brand color;color:#fff} + .mini:hover{color:same brand color} → hover text invisible
 * The injection must yield ≥1 failure, otherwise the checker is broken; exit non-zero directly. */
if (process.env.HOVER_CONTRAST_SELFTEST === '1') {
  const saved = rules.slice()
  rules.length = 0
  rules.push(
    { dark: false, hover: false, classes: ['primary'], decls: { color: '#ffffff', background: 'var(--brand, #0f9d8f)' }, spec: 1, order: 0 },
    { dark: false, hover: false, classes: ['mini'], decls: { color: 'var(--text-2)' }, spec: 1, order: 1 },
    { dark: false, hover: true, classes: ['mini'], decls: { color: 'var(--brand, #0f9d8f)' }, spec: 11, order: 2 }
  )
  const combo = ['mini', 'primary']
  let caught = 0
  for (const dark of [false, true]) {
    const base = cascade(combo, false, dark)
    const hov = cascade(combo, true, dark)
    const solid = !isTransparent(base.bg)
    const hc = normColor(hov.color), bc = normColor(hov.bg || base.bg)
    // Simulate the main-loop decision: after resolving the brand-blue var() to the same literal, the "same-color invisible" rule should hit
    if (solid && hc && hc.replace(/var\(--brand[^)]*\)/, 'BRAND') === bc.replace(/var\(--brand[^)]*\)/, 'BRAND')) caught++
    else if (solid && normColor(base.color) === 'WHITE' && hov.color && normColor(hov.color) !== 'WHITE') caught++
  }
  rules.length = 0
  rules.push(...saved)
  if (!caught) {
    console.error('hover 对比度自测失败：注入"蓝底蓝字"坏规则未被检出，检查器级联逻辑已失效')
    process.exit(1)
  }
  console.log('✓ hover 对比度自测：坏规则被正确检出（负向验证通过）')
}
