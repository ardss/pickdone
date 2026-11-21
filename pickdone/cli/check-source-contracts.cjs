#!/usr/bin/env node
/* eslint-env node */
/**
 * 源码契约门禁（2026-11-21 单测池瘦身）：跑 `tests/**\/*.contracts.mjs`——从单测池里迁出的纯源码
 * 锚点断言（读一个源文件、正则断言某段代码还在）。
 *
 * 为什么不在单测池里跑：这些用例零运行时行为，却按「一文件一进程」被 `node --test` 拉起，还要
 * 各自引导一遍 setup.mjs。它们本质是静态门禁，单进程一次跑完即可；迁出后单测池少 16 个文件 / 72
 * 个用例，提交门禁的受影响池也跟着小一圈。
 *
 * 契约文件的写法没有任何改动：文件名 `*.test.mjs` → `*.contracts.mjs`（run-all 只发现 `.test.mjs`，
 * 自动退出单测池），`import { test } from 'node:test'` → `from '#contracts'`（package.json imports
 * 映射到 cli/lib/source-contract-harness.mjs）。
 *
 * 用法：
 *   node cli/check-source-contracts.cjs           # 全量（check-all 静态段）
 *   node cli/check-source-contracts.cjs --list    # 只列文件与用例数
 *   node cli/check-source-contracts.cjs --dirs=renderer,components   # 只跑部分目录（排障用）
 */
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')

const ROOT = process.env.GATE_ROOT || path.join(__dirname, '..')
const HARNESS = path.join(__dirname, 'lib', 'source-contract-harness.mjs')
const SUFFIX = '.contracts.mjs'
const LIST = process.argv.includes('--list')
const dirsArg = (/^--dirs=(.+)$/.exec(process.argv.find(a => a.startsWith('--dirs=')) || '') || [])[1]
const only = dirsArg ? dirsArg.split(',').map(s => s.trim()).filter(Boolean) : null

/** Recursive walk for the contract suffix only (the shared walker filters by extension list and
 *  would need tests/**\/*.mjs → it already covers .mjs; using it keeps one traversal implementation). */
function walk (dir, out = []) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      walk(full, out)
    } else if (e.isFile() && e.name.endsWith(SUFFIX)) out.push(full)
  }
  return out
}

function rel (p) { return path.relative(ROOT, p).replace(/\\/g, '/') }

async function main () {
  // tests/ is the canonical pool; the sibling test/ dir is discovered by run-all too (flat specs),
  // so contracts living there must not be silently skipped by this gate.
  const all = [...walk(path.join(ROOT, 'tests')), ...walk(path.join(ROOT, 'test'))]
  const files = only
    ? all.filter(f => only.some(d => rel(f).startsWith(`tests/unit/${d}/`)))
    : all
  if (!files.length) {
    console.error(`✗ 源码契约: 0 个 ${SUFFIX} 文件（迁移清单为空 = 门禁静默失效，不是通过）`)
    process.exit(1)
  }
  const { takeCases } = await import(pathToFileURL(HARNESS).href)

  const failures = []
  let caseCount = 0
  let fileCount = 0
  for (const file of files.sort()) {
    const shown = rel(file)
    try {
      await import(pathToFileURL(file).href)
    } catch (e) {
      failures.push({ shown, name: '<import>', err: e })
      continue
    }
    const batch = takeCases()
    if (!batch.length) {
      // 改名后忘了把断言带过来 / 文件被清空：静默零用例=门禁假绿，必须红。
      failures.push({ shown, name: '<empty>', err: new Error('registered no cases') })
      continue
    }
    fileCount++
    caseCount += batch.length
    if (LIST) { console.log(`${String(batch.length).padStart(3)}  ${shown}`); continue }
    for (const c of batch) {
      try { await c.fn() } catch (e) { failures.push({ shown, name: c.name, err: e }) }
    }
  }

  if (LIST) {
    console.log(`[source-contracts] ${fileCount} 文件 / ${caseCount} 用例`)
    return
  }
  if (failures.length) {
    console.error(`✗ 源码契约失败 ${failures.length} 项（文件 ${fileCount} 个 / 用例 ${caseCount} 个）:`)
    for (const f of failures.slice(0, 20)) {
      const msg = ((f.err && f.err.message) || String(f.err)).split('\n')[0]
      console.error(`  • ${f.shown} — ${f.name}\n    ${msg}`)
    }
    if (failures.length > 20) console.error(`  … 其余 ${failures.length - 20} 项省略`)
    process.exit(1)
  }
  console.log(`✓ 源码契约通过（${fileCount} 文件 / ${caseCount} 用例，单进程）`)
}

main().catch(e => { console.error('✗ 源码契约门禁异常:', (e && e.stack) || e); process.exit(1) })
