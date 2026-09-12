#!/usr/bin/env node
/* eslint-env node */
/**
 * 结构尺寸门禁（2026-09-12 门禁体系审计 G：结构尺寸是第 6 个防护维度，此前零覆盖——
 * 四个千行 SFC 与 cli/lib.js 1869 行都是在无门禁状态下长出来的）。
 *
 * 棘轮制：
 *   - 每类文件有 warn/error 上限（见 LIMITS）。
 *   - 超限文件记入 structure-baseline.json（入库）——判红条件 = 行数 > max(硬上限, baseline)，
 *     即 grandfather 文件"涨一行即红"，只准降不准升。
 *   - --update-baseline 重新生成 baseline，但只接受新值 < 旧值（降档需显式提交 diff，升档必须手改 JSON）。
 *
 * 用法：
 *   node cli/check-file-size.cjs                # 全量扫描（check:all 层）
 *   node cli/check-file-size.cjs --staged       # 只查 git staged 的文件（pre-commit 层，秒级）
 *   node cli/check-file-size.cjs --update-baseline
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const BASELINE = path.join(__dirname, 'structure-baseline.json')

// 行数上限（warn, error），按目录/类型分级。error 才判红；warn 打印但不阻塞。
const LIMITS = [
  { test: p => /^renderer\/js\/store\//.test(p), warn: 400, error: 700 },
  { test: p => /^renderer\/js\/utils\//.test(p), warn: 300, error: 500 },
  { test: p => /^renderer\/js\/views\//.test(p) && p.endsWith('.vue'), warn: 500, error: 800 },
  { test: p => /^renderer\/js\/components\//.test(p) && p.endsWith('.vue'), warn: 500, error: 800 },
  { test: p => /^renderer\/js\//.test(p), warn: 500, error: 800 },
  { test: p => /^src\/main\//.test(p), warn: 500, error: 800 },
  { test: p => /^shared\//.test(p), warn: 300, error: 500 },
  { test: p => /^cli\//.test(p), warn: 500, error: 800 }
]

function limitFor (rel) {
  for (const l of LIMITS) if (l.test(rel)) return l
  return { warn: 800, error: 1200 }
}

function listFiles (dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'renderer-dist' || e.name.startsWith('.')) continue
      listFiles(full, out)
    } else if (/\.(vue|js|cjs|mjs)$/.test(e.name) && !e.name.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

function countLines (file) {
  return fs.readFileSync(file, 'utf8').split('\n').length
}

function loadBaseline () {
  try { return JSON.parse(fs.readFileSync(BASELINE, 'utf8')) } catch { return {} }
}

function main () {
  const args = process.argv.slice(2)
  if (args.includes('--update-baseline')) {
    const baseline = loadBaseline()
    for (const file of listFiles(ROOT)) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/')
      if (rel.startsWith('tests') || rel.startsWith('scripts') || rel.startsWith('browser-dev')) continue
      const { error } = limitFor(rel)
      const n = countLines(file)
      if (n <= error) { delete baseline[rel]; continue } // 降到限内：棘轮条目退役
      if (baseline[rel] != null) {
        if (n < baseline[rel]) baseline[rel] = n
        else console.log(`  (ratchet) ${rel}: baseline 保持 ${baseline[rel]}（当前 ${n} 涨行——先拆分再降档）`)
      } else {
        baseline[rel] = n
        console.log(`  (ratchet) ${rel}: 登记棘轮起点 ${n}`)
      }
    }
    fs.writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + '\n')
    console.log('[file-size] baseline 已按棘轮规则更新（只降不升）')
    return
  }

  let files
  if (args.includes('--staged')) {
    const { execFileSync } = require('child_process')
    const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], { cwd: ROOT, encoding: 'utf8' })
    files = out.split('\n').filter(Boolean).map(f => path.join(ROOT, f)).filter(f => fs.existsSync(f))
  } else {
    files = listFiles(ROOT)
  }

  const baseline = loadBaseline()
  const errors = []
  const warns = []
  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/')
    if (rel.startsWith('tests') || rel.startsWith('scripts') || rel.startsWith('browser-dev')) continue
    const { warn, error } = limitFor(rel)
    const n = countLines(file)
    const grandfather = baseline[rel] || 0
    const cap = Math.max(error, grandfather)
    if (n > cap) {
      errors.push(`${rel}: ${n} 行 > 上限 ${error}${grandfather ? `（棘轮 baseline ${grandfather}——只准拆不准涨）` : ''}`)
    } else if (n > warn) {
      warns.push(`${rel}: ${n} 行（warn ${warn}，接近 error ${error}）`)
    }
  }

  for (const w of warns) console.log('  ⚠ ' + w)
  if (errors.length) {
    console.error('✗ 结构尺寸门禁失败：')
    for (const e of errors) console.error('  ' + e)
    console.error('  修复：拆分文件；或对"拆分中"的超标文件用 --update-baseline 登记棘轮基线（只准降）。')
    process.exit(1)
  }
  console.log(`✓ 结构尺寸门禁通过（扫描 ${files.length} 个文件，warn ${warns.length}，error 0）`)
}

main()
