/** Local environment cleanup (companion to the 2026-09-02 environment-isolation audit) — clears test/dev residue left in the system temp directory.
 *  Works both as a standalone CLI (node cli/env-clean.js, see the main branch at the end of the file) and reused by the pickdone CLI `clean` subcommand.
 *  Only touches regenerable test/dev residue; never touches the real user data under %APPDATA%\pickdone. */
const fs = require('fs')
const os = require('os')
const path = require('path')

/** Collect cleanable targets: test-isolation userData (todo-test-* and pd-it-*), test logs, and (--all) dev data directories */
function collectTargets ({ all = false, appRoot }) {
  const targets = []
  const tmp = os.tmpdir()
  for (const entry of fs.readdirSync(tmp)) {
    if (entry.startsWith('todo-test-') || entry.startsWith('pd-it-')) {
      targets.push({ p: path.join(tmp, entry), label: '测试临时 userData' })
    }
  }
  targets.push({ p: path.join(appRoot, 'tests', '.artifacts'), label: '测试日志产物' })
  if (all) targets.push({ p: path.join(appRoot, '.dev-data'), label: '开发数据目录(.dev-data)' })
  return targets.filter(t => { try { fs.statSync(t.p); return true } catch { return false } })
}

function dirSize (dir) {
  let n = 0
  const walk = d => {
    let entries = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else { try { n += fs.statSync(full).size } catch {} }
    }
  }
  walk(dir)
  return n
}

function fmt (n) {
  if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'MB'
  if (n > 1024) return (n / 1024).toFixed(0) + 'KB'
  return n + 'B'
}

/** Run the cleanup. Returns {list:[{label,p,size,cleaned}], total, failedCount} */
function cleanEnv ({ all = false, dry = false, appRoot }) {
  const targets = collectTargets({ all, appRoot })
  const list = []
  let failedCount = 0
  let total = 0
  for (const t of targets) {
    const size = dirSize(t.p)
    let cleaned = false
    if (!dry) {
      try { fs.rmSync(t.p, { recursive: true, force: true }); cleaned = true } catch { failedCount++ }
    } else cleaned = true
    list.push({ label: t.label, path: t.p, size, sizeText: fmt(size), cleaned })
    total += size
  }
  return { list, total, totalText: fmt(total), failedCount }
}

module.exports = { cleanEnv, collectTargets, fmt }

if (require.main === module) {
  const args = new Set(process.argv.slice(2))
  const appRoot = path.resolve(__dirname, '..')
  const r = cleanEnv({ all: args.has('--all'), dry: args.has('--dry-run'), appRoot })
  for (const it of r.list) {
    console.log(`${args.has('--dry-run') ? '[dry-run] ' : it.cleaned ? 'cleaned  ' : 'skip(占用)  '}${it.label}  ${it.sizeText}  ${it.path}`)
  }
  console.log(args.has('--dry-run')
    ? `dry-run: ${r.list.length} 项可清理, 合计 ${r.totalText}`
    : `done: 清理 ${r.list.filter(i => i.cleaned).length} 项(${r.totalText}), 跳过 ${r.failedCount} 项(被占用)`)
}
