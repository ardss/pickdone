/**
 * 打包白名单生成器 —— 从 package-lock.json 按生产依赖闭包生成 build.files 的
 * node_modules 条目（SOP-01 纪律：白名单必须脚本生成，禁止手工维护）。
 * 用法：node scripts/build-whitelist.mjs   （直接改写 package.json 的 files 数组）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = require('path').join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(require('path').join(ROOT, 'package.json'), 'utf8'))
const lock = JSON.parse(readFileSync(require('path').join(ROOT, 'package-lock.json'), 'utf8'))

const lockPkgs = lock.packages || {}
// 生产依赖闭包：从 dependencies 出发，沿 lock 条目的 dependencies（排除 dev 标记的传递依赖也需保留——凡被生产依赖引用即生产）
const seen = new Set()
const queue = Object.keys(pkg.dependencies || {})
while (queue.length) {
  const name = queue.shift()
  if (seen.has(name)) continue
  seen.add(name)
  const entry = lockPkgs['node_modules/' + name]
  if (!entry) { console.error('[whitelist] lock 中缺失:', name); continue }
  for (const dep of Object.keys(entry.dependencies || {})) if (!seen.has(dep)) queue.push(dep)
}

const entries = [...seen].sort().map(name => `node_modules/${name}/**`)

// 重写 files 数组：保留所有非 node_modules 条目（顺序不变），替换/追加 node_modules 段
// （首分支兼容历史上被写成带引号条目的损坏 files——引号一并剥掉）
const files = (pkg.build.files || []).filter(f => !/^["'\s]*node_modules\//.test(f) && !/^node_modules\//.test(f))
const newFiles = [...files, ...entries]
pkg.build.files = newFiles

writeFileSync(require('path').join(ROOT, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8')
console.log(`[whitelist] 已重建：${entries.length} 个 node_modules 条目（闭包 ${seen.size} 个包），非 NM 条目 ${files.length} 个保留`)
