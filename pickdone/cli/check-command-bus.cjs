#!/usr/bin/env node
/**
 * Command-bus gate (Phase 1 of docs/refactor-command-bus.md) — proves the single write door:
 *   (1) Zero renderer write-shaped dbCall/commitOp call sites: every op with a manifest row
 *       (src/main/command-manifest.js OP_TO_COMMAND) must be committed through the bus
 *       (window.commands.commit / commitBatch) — never via a literal op-keyed dbCall/commitOp.
 *       Reads are untouched and stay on dbCall.
 *   (2) Every manifest op exists in db.js OPS or the db-sync-ops dispatcher (no dead rows —
 *       a call would throw "unknown operation").
 *   (3) Every renderer-whitelisted write op (handlers/todo.js ALLOWED_RENDERER_OPS ∩ db.js
 *       WRITE_OPS) has a manifest row — the door must cover the whole surface it replaces.
 *   (4) Manifest row hygiene: sync ∈ full|local|none, tombstone ∈ row|pointer|gc|null.
 * Run: node cli/check-command-bus.cjs        (wired into cli/check-all.js)
 *      node cli/check-command-bus.cjs --selftest   (negative self-test, used by the unit suite)
 */
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const manifest = require(path.join(root, 'src/main/command-manifest'))

let failed = 0
const bad = m => { console.error('  ✗ ' + m); failed++ }
const ok = m => console.log('  ✓ ' + m)

function walk (dir, acc) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    if (fs.statSync(p).isDirectory()) walk(p, acc)
    else if (p.endsWith('.js') || p.endsWith('.vue')) acc.push(p)
  }
  return acc
}

/** Core scan: literal write-op call sites in renderer source. Exported for the self-test. */
function scanSource (src) {
  const violations = []
  for (const m of src.matchAll(/(?:dbCall(?:\?\.)?|commitOp(?:\?\.)?)\(\s*'([A-Za-z]+)'/g)) {
    if (manifest.OP_TO_COMMAND[m[1]]) violations.push(m[1])
  }
  return violations
}

function run () {
  const writeOps = Object.keys(manifest.OP_TO_COMMAND)

  // (1) zero renderer write-shaped dbCall/commitOp call sites
  //     Pinned exemptions (zero-test-edit rule — guard tests in the existing suites pin these
  //     literals byte-for-byte, and each file has no other write site). Every call is still
  //     bus-routed: the main-side todo-db:call handler routes every manifest write op through
  //     bus.commitOp regardless of channel.
  const PINNED = [
    // d5-ui-fixes guard pins `dbCall('deleteMeta', 'repeatRule:' + rid)` (bare-key contract)
    { file: 'renderer/js/utils/repeat.js', op: 'deleteMeta' },
    // f5-projectdocs-race guard executes the extracted persist() against a fake todoAPI only
    { file: 'renderer/js/components/ProjectDocs.vue', op: 'setMeta' },
    // sync-coverage-2 (Y5) pins `dbCall('setMeta', [FLAG_KEY, todayStr])`
    { file: 'renderer/js/utils/leftovers.js', op: 'setMeta' }
  ]
  let sites = 0
  for (const f of walk(path.join(root, 'renderer/js'), [])) {
    const src = fs.readFileSync(f, 'utf8')
    const rel = path.relative(root, f).split(path.sep).join('/')
    const pin = PINNED.find(p => p.file === rel)
    for (const op of scanSource(src)) {
      if (pin && op === pin.op) continue // the pinned literal itself
      bad(`渲染端写调用 "${op}"（${rel}）仍走 op 直连 —— 必须改走 commit(entity, verb, …)`)
      sites++
    }
  }
  if (!sites) ok(`渲染端 0 个写形 dbCall/commitOp 直连（${writeOps.length} 个写 op 全部走 command bus）`)

  // (1.5) renderer facade mirror (VERB_TO_OP in renderer/js/utils/commandBus.js) must equal
  // the manifest reverse index — drift would silently route a command to the wrong op.
  const facadeSrc = fs.readFileSync(path.join(root, 'renderer/js/utils/commandBus.js'), 'utf8')
  const mirror = {}
  for (const m of facadeSrc.matchAll(/'([a-z]+\.[a-zA-Z]+)':\s*'([A-Za-z]+)'/g)) mirror[m[1]] = m[2]
  const expected = Object.fromEntries(Object.entries(manifest.COMMANDS).map(([k, r]) => [k, r.op]))
  for (const [k, op] of Object.entries(expected)) {
    if (mirror[k] !== op) bad(`commandBus.js VERB_TO_OP 漂移: "${k}" 应为 "${op}"，实为 "${mirror[k]}"`)
  }
  for (const k of Object.keys(mirror)) {
    if (!(k in expected)) bad(`commandBus.js VERB_TO_OP 多出 manifest 没有的命令: "${k}"`)
  }
  if (!failed) ok(`渲染端 facade VERB_TO_OP 与 manifest 反向索引一致（${Object.keys(expected).length} 条）`)

  // (2) every manifest op exists in db.js OPS or the db-sync-ops dispatcher
  const dbSrc = fs.readFileSync(path.join(root, 'src/main/db.js'), 'utf8')
  const opsMatch = dbSrc.match(/\nconst OPS = \{([\s\S]*?)\n\}/)
  if (!opsMatch) { bad('db.js 中找不到 OPS 表'); return false }
  const dbOps = new Set([...opsMatch[1].matchAll(/^ {2}([A-Za-z_]+)(?::|,)/gm)].map(x => x[1]))
  const syncOpsSrc = fs.readFileSync(path.join(root, 'src/main/db-sync-ops.js'), 'utf8')
  const syncOps = new Set([...syncOpsSrc.matchAll(/case '([A-Za-z]+)':/g)].map(x => x[1]))
  for (const [key, row] of Object.entries(manifest.COMMANDS)) {
    if (!dbOps.has(row.op) && !syncOps.has(row.op)) bad(`manifest "${key}" 的 op "${row.op}" 在 db.js OPS / db-sync-ops 中不存在（死条目）`)
  }
  if (!failed) ok(`manifest ${Object.keys(manifest.COMMANDS).length} 个命令的 op 全部真实存在`)

  // (3) every whitelisted renderer write op has a manifest row
  const todoSrc = fs.readFileSync(path.join(root, 'src/main/handlers/todo.js'), 'utf8')
  const wlMatch = todoSrc.match(/ALLOWED_RENDERER_OPS = new Set\(\[([\s\S]*?)\]\)/)
  if (!wlMatch) { bad('handlers/todo.js 中找不到 ALLOWED_RENDERER_OPS'); return false }
  const allowed = [...wlMatch[1].matchAll(/'([A-Za-z]+)'/g)].map(x => x[1])
  const writeOpsMatch = dbSrc.match(/const WRITE_OPS = new Set\(\[([\s\S]*?)\]\)/)
  if (!writeOpsMatch) { bad('db.js 中找不到 WRITE_OPS'); return false }
  const dbWriteOps = new Set([...writeOpsMatch[1].matchAll(/'([A-Za-z]+)'/g)].map(x => x[1]))
  for (const op of allowed) {
    if (!dbWriteOps.has(op)) continue // read op — out of the bus's scope by definition
    if (!manifest.OP_TO_COMMAND[op]) bad(`白名单写 op "${op}" 无 manifest 行 —— bus 门没有覆盖它替换的全部写面`)
  }
  if (!failed) ok(`白名单 ∩ WRITE_OPS 的写 op 全部有 manifest 行`)
  return failed === 0
}

/** Row hygiene checks, shared by the gate and the unit self-test. */
function checkRows (report) {
  const badRow = m => report(m)
  const TOMBSTONES = new Set(['row', 'pointer', 'gc', null])
  for (const [key, row] of Object.entries(manifest.COMMANDS)) {
    if (!/^[a-z]+\.[a-zA-Z]+$/.test(key) || key !== row.entity + '.' + row.verb) badRow(`manifest 行键与 entity/verb 不一致: ${key}`)
    if (!['full', 'local', 'none'].includes(row.sync)) badRow(`manifest "${key}" sync 非法: ${row.sync}`)
    if (!TOMBSTONES.has(row.tombstone)) badRow(`manifest "${key}" tombstone 非法: ${row.tombstone}`)
    if (typeof row.op !== 'string' || !row.op) badRow(`manifest "${key}" 缺 op`)
  }
}

if (require.main === module) {
  if (process.argv.includes('--selftest')) {
    // Negative self-test: the scanner MUST catch a planted write-shaped dbCall, and MUST NOT
    // flag read-shaped calls. Exit non-zero on any self-test failure.
    let stFailed = 0
    const planted = scanSource("await window.todoAPI.dbCall('upsert', row); dbCall?.('setMeta', k);")
    if (!(planted.includes('upsert') && planted.includes('setMeta'))) { console.error('  ✗ selftest: planted write not caught'); stFailed++ }
    const reads = scanSource("dbCall('getAll', {}); dbCall?.('queryTodos', q); dbCall('getMeta', k);")
    if (reads.length) { console.error('  ✗ selftest: read ops falsely flagged: ' + reads.join(',')); stFailed++ }
    checkRows(m => { console.error(m); stFailed++ })
    if (stFailed) process.exit(1)
    console.log('  ✓ command-bus gate self-test passed')
    process.exit(0)
  }
  const pass = run()
  checkRows(m => { console.error(m); failed++ })
  console.log(failed === 0 && pass ? '[check-command-bus] PASS' : '[check-command-bus] FAIL')
  process.exit(failed === 0 && pass ? 0 : 1)
}
module.exports = { scanSource, checkRows }
