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

const ROOT = process.env.GATE_ROOT || path.join(__dirname, '..') // GATE_ROOT: unit tests point the gate at a temp fixture tree
const RENDERER = path.join(ROOT, 'renderer', 'js')
const LEDGER = path.join(ROOT, 'tests', 'dualwrite-ledger.json')
const SELFTEST = !!process.env.DUALWRITE_SELFTEST

// shared walker (lib-filescan.cjs): the old hand-rolled copy skipped NOTHING (node_modules/.git
// would have been scanned if they ever appeared under renderer/js) and missed .cjs/.mjs — both
// drifts are closed by the shared defaults
const { listFiles: walk } = require('./lib-filescan.cjs')

/** Resolve an identifier key to its string literal via same-file `const ID = '...'` */
function resolveConst (src, id) {
  const re = new RegExp("const\\s+" + id + "\\s*=\\s*['\"]([^'\"]+)['\"]")
  const m = src.match(re)
  return m ? m[1] : null
}

/**
 * W19 (2026-10-30) multi-line/dynamic-key escape fix. The old single regex required the key to
 * sit right after `(` and to be an identifier or '...'/"..." literal — a template-literal key
 * (`setKey(`x`+id)`) or any first arg not starting with [A-Za-z_$'"] made the WHOLE call invisible
 * to the scan, so the write point never entered the ledger. Now: match the call head only, then
 * extract the first argument with a small bracket/string-aware scanner (newlines allowed).
 * Classification preserves the old ledger keys exactly: leading identifier (even `id(...)`)
 * -> resolveConst / `#id`; leading '...'/"..." literal -> its content. Anything else (template
 * literals, computed exprs) gets a `<expr:...>` bail-out key — counted and warned, NOT red
 * (the gate's red means "unregistered write point you must answer for"; a key we cannot even
 * name statically goes through as a loud inventory entry instead of a false arrest).
 */
function extractFirstArg (src, openParenIdx) {
  let i = openParenIdx + 1
  while (i < src.length && /\s/.test(src[i])) i++ // newlines between ( and the key are fine
  const start = i
  let depth = 0
  let inStr = null
  for (; i < src.length; i++) {
    const ch = src[i]
    if (inStr) {
      if (ch === '\\') { i++; continue }
      if (ch === inStr) inStr = null
      continue
    }
    if (ch === '\'' || ch === '"' || ch === '`') { inStr = ch; continue }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; continue }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return { arg: src.slice(start, i).trim() } // top-level closer = arg boundary
      depth--
    }
    if (depth === 0 && ch === ',') return { arg: src.slice(start, i).trim() }
  }
  return null // unterminated call (inside a template string being typed, etc.) — not a real arg
}

function classifyKey (arg, src) {
  let m
  // leading quoted literal — UNANCHORED at the end: `'repeatRule:' + id` registered by the literal
  // prefix exactly as the old regex did (dynamic prefix keys are registered by prefix)
  if ((m = arg.match(/^'([^']*)'/)) || (m = arg.match(/^"([^"]*)"/))) return { key: m[1] }
  if ((m = arg.match(/^[A-Za-z_$][\w$]*/))) { // identifier, or identifier-led expr like id(x) / obj.k — old scan saw just the identifier
    const lit = resolveConst(src, m[0])
    return { key: lit != null ? lit : `#${m[0]}` }
  }
  // static parse failed (template literal / computed first arg): bail out with an <expr:...> key
  // (counted as a warning, never red)
  return { key: '<expr:' + arg.replace(/\s+/g, ' ').slice(0, 40) + '>', dynamic: true }
}

function scan () {
  const hits = []
  const re = /(localStorage\.(?:setItem|removeItem)|safeSet)\(/g // no \s before ( — `safeSet (` is the function DEFINITION, not a write point (old head semantics kept)
  for (const file of walk(RENDERER)) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/')
    const src = fs.readFileSync(file, 'utf8')
    let m
    while ((m = re.exec(src))) {
      const res = extractFirstArg(src, re.lastIndex - 1)
      if (!res || !res.arg) continue
      const { key, dynamic } = classifyKey(res.arg, src)
      const line = src.slice(0, m.index).split('\n').length
      hits.push({ file: rel, key, line, dynamic: !!dynamic })
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
  let dynamicCount = 0
  for (const h of hits) {
    const id = `${h.file}::${h.key}`
    seen.add(id)
    if (h.dynamic) { dynamicCount++; continue } // <expr:...> bail-out: loud warning below, never a red problem
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
    if (id.includes('<expr:')) continue // expr-summary keys drift with the code — never subject to the rot check
    if (!seen.has(id)) problems.push(`台账条目已无对应代码(腐烂条目,请核实后删除): ${id}`)
  }

  console.log(`[check-dualwrite] 扫描写点 ${hits.length} 处 / 台账 ${Object.keys(ledger).length} 条`)
  if (dynamicCount) {
    // W19: statically unparseable keys — inventory-visible, warned, NOT red (keeps the gate's
    // red = "unregistered static write point" semantics; these need a human naming pass instead)
    console.warn(`[check-dualwrite] ⚠ ${dynamicCount} 处写点键无法静态解析，已按 <expr:...> 兜底登记（请改为静态键或人工登记台账）:`)
    hits.filter(h => h.dynamic).forEach(h => console.warn(`  ⚠ ${h.file}:${h.line} ${h.key}`))
  }
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
