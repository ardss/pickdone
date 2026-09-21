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

/** Phase-2 scan: ANY receiver's literal write-op `.call('op'` (db.call / dbm.call /
 *  open().call / state.db.call…) plus op-keyed dbCall/commitOp, against the given write-op
 *  universe (db.js WRITE_OPS ∪ manifest ops). Reads are never flagged (op not in universe). */
function scanWriteCallSites (src, writeUniverse) {
  const violations = []
  const patterns = [
    /\.call(?:\?\.)?\(\s*'([A-Za-z]+)'/g,
    /(?:dbCall|commitOp)(?:\?\.)?\(\s*'([A-Za-z]+)'/g
  ]
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      if (writeUniverse.has(m[1])) violations.push(m[1])
    }
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
  // Phase 2: internal rows (internal: true — main-process/CLI-surface commands) have no facade
  // row by design; the mirror covers renderer-reachable commands only.
  const facadeSrc = fs.readFileSync(path.join(root, 'renderer/js/utils/commandBus.js'), 'utf8')
  const mirror = {}
  for (const m of facadeSrc.matchAll(/'([a-z]+\.[a-zA-Z]+)':\s*'([A-Za-z]+)'/g)) mirror[m[1]] = m[2]
  const expected = Object.fromEntries(Object.entries(manifest.COMMANDS).filter(([, r]) => !r.internal).map(([k, r]) => [k, r.op]))
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

  // (4) Phase 2 — ZERO write-shaped db.call outside the explicit exemption allowlist.
  //     Every literal write-op call site in src/ + cli/ must be gone: writes commit through
  //     the command bus (bus.commit(entity, verb, …)), reads stay on db.call. The exemptions
  //     below are EXHAUSTIVE and each carries its rationale — adding a file here requires a
  //     spec-level justification in the commit message (docs/refactor-command-bus.md).
  const EXEMPT_FILES = {
    'src/main/db.js': 'the engine itself — the bus and every op implementation dispatch here',
    'src/main/command-bus.js': 'the single write door — commit() is the only caller that maps commands to ops',
    // Sync engine peer-ingress twin (docs/refactor-command-bus.md §Architecture, engine out of
    // bounds): sync-apply/lan-sync apply REMOTE ops with wire-carried LWW stamps — the age
    // travels on the wire, so the bus's "stamp now" semantics do not apply, and re-routing
    // through the bus would re-stamp/echo the peer's own data back. The bulk variants
    // (upsertCategoryMany / filterUpsertMany) are declared in the manifest as internal
    // commands so the census stays total; the engine's direct db.call surface is this
    // declared exemption, not an implicit gap.
    'src/main/sync-apply.js': 'sync engine ingress — applies REMOTE ops with peer-carried LWW stamps (exemption rationale above)',
    'src/main/lan-sync-bootstrap.js': 'sync ingest paths — hydration/flush/appendOplogPointers/blob fold/push cursor run inside applyOps with peer stamps; unit suites drive them via an injected mock state.db.call surface that bus routing would bypass (same ingress exemption as sync-apply.js)',
    // Sync ingress plumbing: the running-tomato announce writes its meta row through the
    // pipeline's injected db surface ((op,p) => state.db.call(op,p), wired in
    // lan-sync-bootstrap.initLanSync) so the announce travels the oplog like every local write.
    // Its caller reference is injected (tests stub it) — bus routing here would bypass the
    // ingress contract. Same exemption class as lan-sync-bootstrap.js.
    'src/main/tomato-announce.js': 'sync ingress plumbing — announce meta row written through the pipeline-injected db surface (same exemption class as lan-sync-bootstrap.js)'
  }
  const writeUniverse = new Set([...dbWriteOps, ...writeOps])
  // Pinned literals (zero-test-edit rule): guard tests pin these byte-for-byte, and each call is
  // STILL bus-routed — import.js's local `db` is a bus facade (commitOp → bus.commit), the same
  // thin-alias pattern the Phase-1 preload kept for window.todoAPI.dbCall.
  const PINNED_P2 = [
    { file: 'cli/import.js', op: 'upsertMany', why: 'h7-1 guard pins the literal; db is a bus facade' },
    { file: 'cli/import.js', op: 'upsertCategory', why: 'same import.js bus facade as upsertMany' }
  ]
  let p2sites = 0
  for (const base of ['src', 'cli']) {
    for (const f of walk(path.join(root, base), [])) {
      const rel = path.relative(root, f).split(path.sep).join('/')
      if (EXEMPT_FILES[rel]) continue
      const src = fs.readFileSync(f, 'utf8')
      const pins = PINNED_P2.filter(p => p.file === rel)
      for (const op of scanWriteCallSites(src, writeUniverse)) {
        if (pins.some(p => p.op === op)) continue // a pinned bus-facade literal itself
        bad(`写形 db.call "${op}"（${rel}）在 bus 门外 —— 必须改走 bus.commit(entity, verb, …)，或在 gate 的 EXEMPT_FILES/PINNED_P2 里给出理由`)
        p2sites++
      }
    }
  }
  if (!p2sites) ok(`src/ + cli/ 0 个门外写形 db.call（豁免 ${Object.keys(EXEMPT_FILES).length} 文件 + ${PINNED_P2.length} 个 bus-facade 钉死字面量，理由已内联）`)
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
    // Phase-2 scanner: any receiver's write-shaped .call is caught; reads pass.
    const universe = new Set(['upsert', 'setMeta', 'purgeRecycleBin', 'settingsRowPut'])
    const p2 = scanWriteCallSites("db.call('upsert', t); dbm.call?.('setMeta', kv); state.db.call('purgeRecycleBin'); x.settingsRowPut && db.call('settingsRowPut', r); db.call('getMeta', k); db.call('queryTodos', q);", universe)
    if (!(p2.includes('upsert') && p2.includes('setMeta') && p2.includes('purgeRecycleBin') && p2.includes('settingsRowPut'))) { console.error('  ✗ selftest: P2 planted writes not caught: ' + p2.join(',')); stFailed++ }
    if (p2.length !== 4) { console.error('  ✗ selftest: P2 scanner flagged non-writes: ' + p2.join(',')); stFailed++ }
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
module.exports = { scanSource, scanWriteCallSites, checkRows }
