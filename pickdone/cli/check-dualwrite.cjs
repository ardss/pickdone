#!/usr/bin/env node
/**
 * Dual-write inventory gate (data-authority ledger gate) — a structural defense line against the whole class of "renderer localStorage mirror drifting from the authority source" bugs.
 *
 * Background (finalized 2026-09-03): CLI and UI share src/main/db.js OPS + SQLite + the meta table — a single authoritative source by architecture;
 * recurring linkage bugs (dc61ff9 schedule chips / cd73566 attach write-back / 405881b undo echo / 9f97147 dbMirror dual-track)
 * all stemmed from renderer localStorage mirrors whose sync rules went their own ways. This gate requires:
 *   1) Every renderer localStorage write point (setItem/removeItem/safeSet) must be registered in tests/dualwrite-ledger.json
 *      — authority declares the source of truth: 'sqlite' (DB/meta is authoritative, LS is cache only, must document the calibration entry) or 'local-only' (local preference/runtime, no sync obligation)
 *   2) Ledger entries must still correspond to live code (keeps the ledger from rotting into decoration)
 *   3) Negative self-test: injecting a fake write point must turn the gate red (prevents an always-green gate)
 * New write point = red gate = the developer is forced to answer "who is the authority, when is it calibrated" — if you cannot answer, it is a design problem: fix the design before adding code.
 *
 * Usage: node cli/check-dualwrite.cjs           # gate
 *       DUALWRITE_SELFTEST=1 node cli/check-dualwrite.cjs   # negative self-test
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const RENDERER = path.join(ROOT, 'renderer', 'js')
const LEDGER = path.join(ROOT, 'tests', 'dualwrite-ledger.json')
const SELFTEST = !!process.env.DUALWRITE_SELFTEST

function walk (dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.js') || e.name.endsWith('.vue')) out.push(p)
  }
  return out
}

/** Resolve an identifier key to its string literal via same-file `const ID = '...'` */
function resolveConst (src, id) {
  const re = new RegExp("const\\s+" + id + "\\s*=\\s*['\"]([^'\"]+)['\"]")
  const m = src.match(re)
  return m ? m[1] : null
}

function scan () {
  const hits = []
  for (const file of walk(RENDERER)) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/')
    const src = fs.readFileSync(file, 'utf8')
    const re = /localStorage\.(setItem|removeItem)\(\s*([A-Za-z_$][\w$]*|'[^']*'|"[^"]*")|safeSet\(\s*([A-Za-z_$][\w$]*|'[^']*'|"[^"]*")/g
    let m
    while ((m = re.exec(src))) {
      const raw = m[2] !== undefined ? m[2] : m[3]
      let key
      if (/^['"]/.test(raw)) key = raw.slice(1, -1)
      else {
        const lit = resolveConst(src, raw)
        key = lit != null ? lit : `#${raw}` // the # prefix = literal not resolved within the file; registered by identifier
      }
      // Dynamic prefix keys (repeatRule:xxx etc.) are registered by prefix
      const line = src.slice(0, m.index).split('\n').length
      hits.push({ file: rel, key, line })
    }
  }
  if (SELFTEST) hits.push({ file: 'renderer/js/__selftest__.js', key: 'dualwriteSelftestFakeKey', line: 1 })
  return hits
}

function main () {
  if (SELFTEST && !fs.existsSync(LEDGER)) {
    console.error('✗ 台账不存在:', LEDGER)
    process.exit(1)
  }
  const ledger = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, 'utf8')) : {}
  const hits = scan()
  if (process.env.DUALWRITE_INVENTORY) {
    const counts = new Map()
    for (const h of hits) counts.set(`${h.file}::${h.key}`, (counts.get(`${h.file}::${h.key}`) || 0) + 1)
    for (const [k, v] of [...counts].sort()) console.log(String(v).padStart(2), k)
    console.log('TOTAL', counts.size)
    return
  }

  const problems = []
  const seen = new Set()
  for (const h of hits) {
    const id = `${h.file}::${h.key}`
    seen.add(id)
    const entry = ledger[id]
    if (!entry) {
      problems.push(`未登记写点: ${id}:${h.line} —— 请回答「权威源是谁、何时校准」后登记进 tests/dualwrite-ledger.json`)
      continue
    }
    if (!['sqlite', 'local-only'].includes(entry.authority)) {
      problems.push(`台账条目 authority 非法(只允许 sqlite|local-only): ${id}`)
    }
    if (!entry.note || String(entry.note).trim().length < 4) {
      problems.push(`台账条目 note 缺失或过短(须写明同步规则/校准入口): ${id}`)
    }
  }
  for (const id of Object.keys(ledger)) {
    if (!seen.has(id)) problems.push(`台账条目已无对应代码(腐烂条目,请核实后删除): ${id}`)
  }

  console.log(`[check-dualwrite] 扫描写点 ${hits.length} 处 / 台账 ${Object.keys(ledger).length} 条`)
  if (SELFTEST) {
    const caught = problems.some(p => p.includes('__selftest__'))
    console.log(caught ? '[check-dualwrite] 负向自测: 假写点被正确拦截 ✓' : '[check-dualwrite] 负向自测失败: 假写点未被拦截 ✗')
    process.exit(caught ? 0 : 1)
  }
  if (problems.length) {
    console.error(problems.map(p => '  ✗ ' + p).join('\n'))
    process.exit(1)
  }
  console.log('[check-dualwrite] 全部写点已登记且台账无腐烂 ✓')
}

main()
