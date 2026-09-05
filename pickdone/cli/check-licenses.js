#!/usr/bin/env node
/**
 * Dependency license audit (SOP-02 automation) — walks node_modules top level + vendor; GPL/AGPL/no license = non-zero exit
 * Usage: node cli/check-licenses.js
 * Caveat: deep transitive dependencies are judged by their top-level package's license declaration; always run after installing new dependencies
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const BANNED = /GPL|AGPL|LGPL-3|Unlicense MISSING|UNKNOWN/i
const ALLOW_UNKNOWN = new Set(['buffers']) // substack/node-buffers is upstream MIT; the old package lacks a license field (manually verified)

function licenseOf (pkgPath) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(pkgPath, 'package.json'), 'utf8'))
    return { license: j.license || (j.licenses && j.licenses.join(',')) || 'UNKNOWN', name: j.name, version: j.version }
  } catch (e) { return null }
}

const rows = []
const nm = path.join(ROOT, 'node_modules')
for (const scope of fs.readdirSync(nm)) {
  const p = path.join(nm, scope)
  if (!fs.statSync(p).isDirectory()) continue
  if (scope.startsWith('@')) {
    for (const sub of fs.readdirSync(p)) {
      const info = licenseOf(path.join(p, sub))
      if (info) rows.push(info)
    }
  } else {
    const info = licenseOf(p)
    if (info) rows.push(info)
  }
}
// vendor
const vendorPkg = path.join(ROOT, 'vendor', 'better-sqlite3-multiple-ciphers')
if (fs.existsSync(vendorPkg)) { const i = licenseOf(vendorPkg); if (i) rows.push(i) }

// Dual license "(MIT OR GPL-3.0)": the consumer may pick the permissive side → treat as MIT
const asEffective = lic => {
  const m = String(lic).match(/^\((MIT|ISC|Apache-2\.0|BSD-\d-Clause|0BSD) OR [^)]+\)$/i)
  return m ? m[1] : lic
}
const bad = rows.filter(r => {
  const eff = asEffective(r.license)
  return (BANNED.test(eff) || eff === 'UNKNOWN') && !ALLOW_UNKNOWN.has(r.name)
})

console.log(`扫描 ${rows.length} 个顶层包`)
if (bad.length) {
  console.error('✗ 存在禁止/未知许可证（GPL 类会传染 MIT 声明，发布阻塞）：')
  bad.forEach(b => console.error(`  - ${b.name}@${b.version}: ${b.license}`))
  process.exit(1)
}
const byLicense = {}
rows.forEach(r => { byLicense[r.license] = (byLicense[r.license] || 0) + 1 })
console.log('✓ 许可证分布:', JSON.stringify(byLicense))
console.log('提示: 第三方署名清单见 THIRD-PARTY-NOTICES.md，新增 Apache-2.0/CC BY 依赖后须同步登记')
