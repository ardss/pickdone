#!/usr/bin/env node
/**
 * Command-bus gate (Phase 1 of docs/refactor-command-bus.md) — proves the single write door:
 *   (1) Zero renderer write-shaped dbCall/commitOp call sites: every op with a manifest row
 *       (src/main/command-manifest.js OP_TO_COMMAND) must be committed through the bus
 *       (window.commands.commit / commitBatch) — never via a literal op-keyed dbCall/commitOp.
 *       Reads are untouched and stay on dbCall.
 *   (2) Every manifest op exists in db.js OPS or the db-sync-ops dispatcher (no dead rows —
 *       a call would throw "unknown operation"); conversely every db.js OPS mutator-shaped
 *       name must be in WRITE_OPS (no uncaptured mutator — arch review 2026-09-22 rec #4).
 *   (3) Every renderer-whitelisted write op (handlers/todo.js ALLOWED_RENDERER_OPS ∩ db.js
 *       WRITE_OPS) has a manifest row — the door must cover the whole surface it replaces.
 *   (4) Manifest row hygiene: sync ∈ full|local|none, tombstone ∈ row|pointer|gc|null,
 *       capture ∈ oplog|none|gc (arch review 2026-09-22 rec #2).
 *   (5) Scanner tightening (arch review 2026-09-22 rec #4): double-quoted and template-literal
 *       op names are caught; dynamic-op writes (dbCall(var,… / commitOp(var,… / db-ish
 *       receiver .call(var,…) are flagged; .cjs/.mjs are walked under src/ + cli/; comments
 *       are stripped before scanning; the pinned literals became EXACT-LINE/SITE anchors
 *       (no more per-file amnesty zones); every exempt file carries a write-call-count
 *       RATCHET that only ever ratchets down.
 *   (6) The manifest localKeys mirror ≡ sync-apply's authoritative filters over a GENERATED
 *       key corpus (every prefix family × match/non-match shape), proving function
 *       equivalence — not memorized keys.
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
    else if (['.js', '.vue', '.cjs', '.mjs'].includes(path.extname(p))) acc.push(p)
  }
  return acc
}

/** Blank out comments (line + block) so planted doc examples never flag. String literals are
 *  kept (a planted write call inside a live string is indistinguishable from code anyway). */
function stripComments (src) {
  const blank = m => m.replace(/[^\n]/g, ' ')
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + blank(m.slice(p1.length)))
}

/** Literal write-op call sites: 'op' | "op" | `op`, via .call / dbCall / commitOp.
 *  Returns { op, line } objects (line = the physical source line, for exact-site anchors). */
function scanWriteSites (src, universe) {
  const violations = []
  const clean = stripComments(src)
  const lines = src.split('\n')
  const patterns = [
    /\.call(?:\?\.)?\(\s*(['"`])([A-Za-z]+)\1/g,
    /(?:dbCall|commitOp)(?:\?\.)?\(\s*(['"`])([A-Za-z]+)\1/g
  ]
  for (const reDef of patterns) {
    const re = new RegExp(reDef.source, reDef.flags) // fresh lastIndex per call (stateful /g)
    for (const m of clean.matchAll(re)) {
      if (!universe || universe.has(m[2])) {
        violations.push({ op: m[2], line: lines[clean.slice(0, m.index).split('\n').length - 1] || '' })
      }
    }
  }
  return violations
}

/** Core scan: literal write-op call sites in renderer source. Exported for the self-test
 *  (signature preserved: returns op names). */
function scanSource (src) {
  return scanWriteSites(src, new Set(Object.keys(manifest.OP_TO_COMMAND))).map(v => v.op)
}

/** Dynamic-op writes: the op-keyed doors (dbCall/commitOp) called with an IDENTIFIER op, or a
 *  db-ish receiver (.db / dbm) .call(<ident>, — a wholesale dispatch surface that no manifest
 *  row names. Returns { line } objects. */
function scanDynamicWriteSites (src) {
  const clean = stripComments(src)
  const lines = src.split('\n')
  const out = []
  const patterns = [
    // bare op-keyed doors with a dynamic op (bus.commitOp — i.e. `.commitOp(` — IS the door,
    // not a violation; the lookbehind excludes it)
    /(?<!\.)\b(?:dbCall|commitOp)(?:\?\.)?\(\s*[A-Za-z_$][\w$]*\s*,/g,
    /(?:[\w$]*(?:[Dd]b|DB))\.call\(\s*[A-Za-z_$][\w$]*\s*,/g
  ]
  for (const reDef of patterns) {
    const re = new RegExp(reDef.source, reDef.flags) // fresh lastIndex per call (stateful /g)
    for (const m of clean.matchAll(re)) {
      out.push({ line: lines[clean.slice(0, m.index).split('\n').length - 1] || '' })
    }
  }
  return out
}

/** Phase-2 scan kept for compatibility (op names only). */
function scanWriteCallSites (src, writeUniverse) {
  return scanWriteSites(src, writeUniverse).map(v => v.op)
}

/** Exact-site anchor: the violation's physical line must contain EVERY anchor fragment. */
const siteMatches = (v, anchor) => anchor.frags.every(f => v.line.includes(f))

function run () {
  const writeOps = Object.keys(manifest.OP_TO_COMMAND)

  // (1) zero renderer write-shaped dbCall/commitOp call sites.
  //     EXACT-SITE ANCHORS (arch review 2026-09-22 rec #4): the historical per-(file,op) pins
  //     were permanent amnesty zones — ANY other occurrence of the same op in the same file
  //     passed. Each pin is now an exact-line anchor: only THAT literal line is tolerated,
  //     everything else flags. Every call is still bus-routed: the main-side todo-db:call
  //     handler routes every manifest write op through bus.commitOp regardless of channel.
  const SITE_ANCHORS = [
    // d5-ui-fixes guard pins `dbCall('deleteMeta', 'repeatRule:' + rid)` (bare-key contract)
    { file: 'renderer/js/utils/repeat.js', frags: ["dbCall('deleteMeta', 'repeatRule:' + rid)"] },
    // f5-projectdocs-race guard executes the extracted persist() against a fake todoAPI only
    { file: 'renderer/js/components/ProjectDocs.vue', frags: ["dbCall('setMeta', [key, JSON.stringify(this.docs)])"] },
    // sync-coverage-2 (Y5) pins `dbCall('setMeta', [FLAG_KEY, todayStr])`
    { file: 'renderer/js/utils/leftovers.js', frags: ["dbCall('setMeta', [FLAG_KEY, todayStr])"] }
  ]
  let sites = 0
  for (const f of walk(path.join(root, 'renderer/js'), [])) {
    const rel = path.relative(root, f).split(path.sep).join('/')
    const anchors = SITE_ANCHORS.filter(a => a.file === rel)
    for (const v of scanWriteSites(fs.readFileSync(f, 'utf8'), new Set(writeOps))) {
      if (anchors.some(a => siteMatches(v, a))) continue // the anchored literal line itself
      bad(`渲染端写调用 "${v.op}"（${rel}）仍走 op 直连 —— 必须改走 commit(entity, verb, …)`)
      sites++
    }
  }
  if (!sites) ok(`渲染端 0 个写形 dbCall/commitOp 直连（${writeOps.length} 个写 op 全部走 command bus；${SITE_ANCHORS.length} 个字面量已锚定到精确行）`)

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

  // (2) every manifest op exists in db.js OPS or the db-sync-ops dispatcher; and (rec #4)
  // every db.js OPS mutator-shaped name is in WRITE_OPS (no uncaptured mutator), and every
  // WRITE_OPS entry is real (no dead write-op row).
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
  // WRITE_OPS moved verbatim out of db.js into src/main/db-write-ops.cjs (structure-size
  // ratchet, pure data). Load the real set instead of regex-scraping, but still pin db.js to
  // importing it — a re-inlined divergent copy must not pass silently.
  const writeOpsSrcPath = path.join(root, 'src/main/db-write-ops.cjs')
  const writeOpsSrc = fs.readFileSync(writeOpsSrcPath, 'utf8')
  const writeOpsMatch = writeOpsSrc.match(/const WRITE_OPS = new Set\(\[([\s\S]*?)\]\)/)
  if (!writeOpsMatch) { bad('db-write-ops.cjs 中找不到 WRITE_OPS'); return false }
  if (!/require\('\.\/db-write-ops\.cjs'\)/.test(dbSrc)) {
    bad('db.js 不再从 db-write-ops.cjs 引入 WRITE_OPS —— 出现内联副本？')
    return false
  }
  const dbWriteOps = new Set([...writeOpsMatch[1].matchAll(/'([A-Za-z]+)'/g)].map(x => x[1]))
  const MUTATOR_SHAPE = /(upsert|delete|purge|append|remove|put|bump|prune|migrate|update|commitSync|restore|set[A-Z])/
  // Mutators that are deliberately NOT in WRITE_OPS: appending IS the capture layer (a
  // captured append would recurse). Anything else added here needs the same spec-level note.
  const NON_CAPTURED_MUTATORS = new Set(['appendOplogPointers'])
  let mutatorMiss = 0
  for (const op of dbOps) {
    if (MUTATOR_SHAPE.test(op) && !dbWriteOps.has(op) && !NON_CAPTURED_MUTATORS.has(op)) {
      bad(`db.js OPS 变异器 "${op}" 不在 WRITE_OPS 中 —— 写捕获清单漏项（rec #4 互查）`)
      mutatorMiss++
    }
  }
  for (const op of dbWriteOps) {
    if (!dbOps.has(op) && !syncOps.has(op)) {
      bad(`WRITE_OPS 条目 "${op}" 在 db.js OPS / db-sync-ops 中不存在（死条目）`)
      mutatorMiss++
    }
  }
  if (!mutatorMiss) ok(`db.js OPS 变异器 ⊆ WRITE_OPS 且 WRITE_OPS 无死条目（互查通过，${dbOps.size} OPS / ${dbWriteOps.size} WRITE_OPS）`)

  // (3) every whitelisted renderer write op has a manifest row
  const todoSrc = fs.readFileSync(path.join(root, 'src/main/handlers/todo.js'), 'utf8')
  const wlMatch = todoSrc.match(/ALLOWED_RENDERER_OPS = new Set\(\[([\s\S]*?)\]\)/)
  if (!wlMatch) { bad('handlers/todo.js 中找不到 ALLOWED_RENDERER_OPS'); return false }
  const allowed = [...wlMatch[1].matchAll(/'([A-Za-z]+)'/g)].map(x => x[1])
  for (const op of allowed) {
    if (!dbWriteOps.has(op)) continue // read op — out of the bus's scope by definition
    if (!manifest.OP_TO_COMMAND[op]) bad(`白名单写 op "${op}" 无 manifest 行 —— bus 门没有覆盖它替换的全部写面`)
  }
  if (!failed) ok(`白名单 ∩ WRITE_OPS 的写 op 全部有 manifest 行`)

  // (4) Phase-2/3 + arch review 2026-09-22 rec #1/#4 — ZERO write-shaped db.call outside the
  //     twin-door convergence. sync-apply.js and lan-sync-bootstrap.js now route their writes
  //     through the injected hookless bus (sync-apply busWrite → bus.commitOp preserveStamp),
  //     so the EXEMPTION LEDGER shrank to the one surface that genuinely cannot route:
  //     tomato-announce.js (its db surface is init()-injected and unit tests stub it — routing
  //     here would bypass the injected contract). db.js/command-bus.js carry RATCHET 0 — they
  //     are the engine and the door, and must keep ZERO literal write sites forever.
  //     Each exempt file carries a write-call-count RATCHET that may only shrink.
  const EXEMPT_FILES = {
    'src/main/db.js': { why: 'the engine itself — the bus and every op implementation dispatch here', ratchet: 0 },
    'src/main/command-bus.js': { why: 'the single write door — commit() is the only caller that maps commands to ops', ratchet: 0 },
    'src/main/tomato-announce.js': { why: 'sync ingress plumbing — announce meta row written through the init()-injected db surface (tests stub it; same ingress class as lan-sync-bootstrap was)', ratchet: 1 }
  }
  const writeUniverse = new Set([...dbWriteOps, ...writeOps])
  // Exact-line anchors for the two import-engine bus-facade literals (h7-1 guard pins them
  // byte-for-byte; the engine's local `db` is a bus facade: commitOp → bus.commit). Anchors
  // follow the D3 move of the engine from cli/import.js to src/main/import/index.js.
  const PINNED_P2 = [
    { file: 'src/main/import/index.js', frags: ["db.call('upsertMany', rows)"] },
    { file: 'src/main/import/index.js', frags: ["db.call('upsertCategory', {"] }
  ]
  // Exact-line anchors for the DYNAMIC wholesale-dispatch surfaces (rec #4): these closures
  // pass the op through variable — mixed read/write injected surfaces that cannot route
  // wholesale through the manifest (reads would throw USAGE). Each is pinned to its exact line.
  const DYNAMIC_ANCHORS = [
    { file: 'src/main/lan-sync-bootstrap.js', frags: ["require('./sync-conflict-backups').ops(() => (op, p) => state.db.call(op, p))"] },
    { file: 'src/main/lan-sync-bootstrap.js', frags: ['dbCall: (op, p) => state.db.call(op, p)'] },
    { file: 'src/main/sync-apply.js', frags: ['createBus((op, p) => state.db.call(op, p))'] },
    { file: 'src/main/sync-apply.js', frags: ['new Map((state.db.call(op, {}) || [])'] }
  ]
  let p2sites = 0
  for (const base of ['src', 'cli']) {
    for (const f of walk(path.join(root, base), [])) {
      const rel = path.relative(root, f).split(path.sep).join('/')
      if (rel === 'cli/check-command-bus.cjs') continue // the gate's own negative self-test plants literals
      const src = fs.readFileSync(f, 'utf8')
      const pins = PINNED_P2.filter(p => p.file === rel)
      const dynAnchors = DYNAMIC_ANCHORS.filter(a => a.file === rel)
      const exempt = EXEMPT_FILES[rel]
      for (const v of scanWriteSites(src, writeUniverse)) {
        if (pins.some(a => siteMatches(v, a))) continue // an anchored bus-facade literal line
        if (exempt) continue // counted by the ratchet below, not flagged
        bad(`写形 db.call "${v.op}"（${rel}）在 bus 门外 —— 必须改走 bus.commit(entity, verb, …)，或给出精确行锚点/豁免理由`)
        p2sites++
      }
      // dynamic-op writes: flagged unless the line matches an exact dynamic anchor
      const dyn = scanDynamicWriteSites(src).filter(v => !dynAnchors.some(a => siteMatches(v, a)))
      for (const v of dyn) {
        if (exempt) continue // exempt files' dynamic surfaces ride the same ratchet review
        bad(`动态 op 写形调用（${rel}）: "${v.line.trim().slice(0, 90)}" —— 整面分派必须给出精确行锚点`)
        p2sites++
      }
    }
  }
  // Per-exempt-file write-call-count RATCHET (rec #4): the count may only go DOWN.
  for (const [rel, cfg] of Object.entries(EXEMPT_FILES)) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8')
    const count = scanWriteSites(src, writeUniverse).length
    if (count > cfg.ratchet) {
      bad(`豁免文件 ${rel} 写形调用计数 ${count} 超过棘轮上限 ${cfg.ratchet} —— 棘轮只许下调`)
      p2sites++
    }
  }
  if (!p2sites) ok(`src/ + cli/（含 .cjs/.mjs）0 个门外写形 db.call/动态 op 写（精确行锚点 ${PINNED_P2.length + DYNAMIC_ANCHORS.length} 个；豁免 ${Object.keys(EXEMPT_FILES).length} 文件，棘轮上限已内联）`)
  return failed === 0
}

/** Row hygiene checks, shared by the gate and the unit self-test. */
function checkRows (report) {
  const badRow = m => report(m)
  const TOMBSTONES = new Set(['row', 'pointer', 'gc', null])
  const CAPTURES = new Set(['oplog', 'none', 'gc'])
  for (const [key, row] of Object.entries(manifest.COMMANDS)) {
    if (!/^[a-z]+\.[a-zA-Z]+$/.test(key) || key !== row.entity + '.' + row.verb) badRow(`manifest 行键与 entity/verb 不一致: ${key}`)
    if (!['full', 'local', 'none'].includes(row.sync)) badRow(`manifest "${key}" sync 非法: ${row.sync}`)
    if (!TOMBSTONES.has(row.tombstone)) badRow(`manifest "${key}" tombstone 非法: ${row.tombstone}`)
    // Arch review 2026-09-22 rec #2: capture ∈ oplog(default)|none|gc — declares whether the
    // commit mints oplog rows. 'none' must stay rare and deliberate (today: todo.commitBatch).
    if (!CAPTURES.has(row.capture == null ? 'oplog' : row.capture)) badRow(`manifest "${key}" capture 非法: ${row.capture}`)
    if (row.capture === 'none' && row.sync === 'full' && key !== 'todo.commitBatch') {
      badRow(`manifest "${key}" capture:'none' 需要在 gate 里逐条确认（当前仅 todo.commitBatch 是 sync-ack echo 路径）`)
    }
    if (typeof row.op !== 'string' || !row.op) badRow(`manifest "${key}" 缺 op`)
  }
}

/**
 * D6 P2 (2026-09-21) gate assertion, arch review 2026-09-22 rec #4 upgrade: the manifest's
 * localKeys mirror and sync-apply's authoritative machine-local filters must classify an
 * enumerated key corpus IDENTICALLY. The corpus is GENERATED from the filter families
 * themselves — every prefix family appears in a matching shape (<prefix><tag>) AND a
 * non-matching shape (prefix broken, or exact key suffixed/prefixed), plus deliberate
 * user-data negative controls. That proves the two functions agree on the SHAPES (function
 * equivalence), not on 28 memorized strings.
 */
function buildMirrorKeyCorpus () {
  const keys = new Set()
  const tag = 'ArchProbe1'
  // Families mirrored between manifest + sync-apply: meta filters
  const metaPrefixes = ['sync.', '_', 'securityLock', 'cliTomato', 'cliSync', 'firedReminders:', 'settingsRows.src.', 'snowDedup:', 'metaConflictBackup.', 'dayPlanState.']
  const metaExact = ['todosVersion', 'reminderLastSeenAt', 'db.tomatoState', 'habitsState', 'schemaVersion', 'dayPlanState']
  // settings filters add no extra families beyond sync./securityLock/_ (subset of the above)
  for (const p of metaPrefixes) {
    keys.add(p + tag) // matching shape → both filters must say LOCAL
    keys.add(p.slice(0, -1) + tag) // prefix broken (dot/colon dropped) → SYNCABLE
    keys.add('x' + p + tag) // prefix not at string start → SYNCABLE
  }
  for (const k of metaExact) {
    keys.add(k) // exact key → LOCAL
    keys.add(k + tag) // suffixed → SYNCABLE (starts-with must not over-match)
  }
  // Deliberate user-data negative controls (both filters must say SYNCABLE)
  for (const k of ['dailyTomatoTarget', 'projectMilestones:p1', 'projectDeadline:p1', 'repeatRule:r1', 'someUserKey', 'themeColor', 'tomatoRunAnnounce.dev1']) keys.add(k)
  return [...keys]
}
const MIRROR_KEY_CORPUS = buildMirrorKeyCorpus()

function checkLocalKeyMirror (report, syncApplyMod) {
  let ok = true
  const pairs = [
    ['meta', manifest.isMachineLocalMetaKey, syncApplyMod.isMachineLocalMetaKey],
    ['setting', manifest.isMachineLocalSettingKey, syncApplyMod.isMachineLocalSettingKey]
  ]
  for (const [name, mirror, authoritative] of pairs) {
    if (typeof mirror !== 'function' || typeof authoritative !== 'function') {
      report(`manifest ${name} localKeys 或 sync-apply ${name} 过滤器缺失，无法比对`); ok = false; continue
    }
    for (const k of MIRROR_KEY_CORPUS) {
      if (!!mirror(k) !== !!authoritative(k)) {
        report(`manifest ${name} localKeys 与 sync-apply 分类漂移: "${k}" mirror=${!!mirror(k)} sync-apply=${!!authoritative(k)}`)
        ok = false
      }
    }
  }
  return ok
}

/**
 * Arch review 2026-09-22 rec #3 gate assertion: the future-stamp clamp window is ONE shared
 * constant (src/main/stamp-clamp.js), imported by BOTH doors — command-bus.js (local write
 * door) and sync-apply.js (remote ingress clampSkew). Source-level assertions catch a revert
 * to a hand-rolled literal.
 */
/**
 * Numeric-literal run: one number token (decimal, exponent, or hex) optionally joined to more
 * number tokens by '*'. Every such run is a pure-numeric product we can evaluate exactly.
 * Lookaround boundaries keep identifiers like `clamp600000` or member accesses from matching.
 */
const NUMERIC_RUN = /(?<![\w.$])(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?:\s*\*\s*(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?))*(?![\w.$])/g

/** Evaluate a pure-numeric product slice ("600000", "6e5", "1000 * 60 * 10"). Returns the
 *  numeric value, or null when the slice is not a pure product of numeric literals. */
function evalNumericProduct (slice) {
  let product = 1
  let sawFactor = false
  for (const raw of slice.split('*')) {
    const token = raw.trim()
    if (!/^(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(token)) return null
    product *= Number(token)
    sawFactor = true
  }
  return sawFactor ? product : null
}

/**
 * Value-based handwritten-clamp detector: instead of memorizing ONE spelling of the clamp
 * window ("5|10 * 60 * 1000"), evaluate every numeric run in (comment-stripped) source and
 * flag any whose value equals a forbidden window. Equivalent spellings — 600000, 3e5,
 * 1000*60*10, 0x927C0 — all carry the same value and are caught alike.
 * Returns the offending slices with their values.
 */
function findClampWindowLiterals (src, windows) {
  const hits = []
  const clean = stripComments(src)
  for (const m of clean.matchAll(NUMERIC_RUN)) {
    const value = evalNumericProduct(m[0])
    if (value !== null && windows.has(value)) hits.push({ text: m[0].trim(), value })
  }
  return hits
}

/** Parse the shared constant's value out of stamp-clamp.js using the same evaluator (so the
 *  gate does not depend on stamp-clamp.js spelling its value as N*60*1000 either). */
function parseStampClampMs (clampSrc) {
  const m = clampSrc.match(/STAMP_CLAMP_MS\s*=\s*/)
  if (!m) return null
  const rest = clampSrc.slice(m.index + m[0].length)
  const run = rest.match(new RegExp(NUMERIC_RUN.source, ''))
  return run ? evalNumericProduct(run[0]) : null
}

function checkSharedStampClamp (report) {
  let ok = true
  const clampSrc = fs.readFileSync(path.join(root, 'src/main/stamp-clamp.js'), 'utf8')
  const clampMs = parseStampClampMs(clampSrc)
  if (clampMs === null || !Number.isFinite(clampMs) || clampMs <= 0) { report('stamp-clamp.js 中找不到共享常量 STAMP_CLAMP_MS'); return false }
  // Forbidden windows: the shared constant itself, plus the historical 5-minute variant when
  // it is an integer (the pre-unification command-bus door used half the sync window).
  const windows = new Set([clampMs])
  if (clampMs % 2 === 0) windows.add(clampMs / 2)
  for (const rel of ['src/main/command-bus.js', 'src/main/sync-apply.js']) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8')
    if (!/require\(['"]\.\/stamp-clamp['"]\)/.test(src)) {
      report(`${rel} 未引入共享 stamp-clamp 常量 —— 未来戳钳制窗口不允许各自手写`)
      ok = false
    }
    for (const hit of findClampWindowLiterals(src, windows)) {
      report(`${rel} 中仍有手写钳制窗口字面量 (${hit.text} = ${hit.value}) —— 必须使用 stamp-clamp.js 的 STAMP_CLAMP_MS`)
      ok = false
    }
  }
  return ok
}

if (require.main === module) {
  if (process.argv.includes('--selftest')) {
    // Negative self-test: the scanners MUST catch planted write-shaped calls (single, double
    // and template-literal op names, dynamic ops), and MUST NOT flag read-shaped calls or
    // comment examples. Exit non-zero on any self-test failure.
    let stFailed = 0
    const planted = scanSource("await window.todoAPI.dbCall('upsert', row); dbCall?.('setMeta', k); dbCall(\"deleteMeta\", k2); dbCall(`bumpSnow`, p);")
    if (!(planted.includes('upsert') && planted.includes('setMeta') && planted.includes('deleteMeta') && planted.includes('bumpSnow'))) { console.error('  ✗ selftest: planted writes not caught: ' + planted.join(',')); stFailed++ }
    const reads = scanSource("dbCall('getAll', {}); dbCall?.('queryTodos', q); dbCall('getMeta', k); db.call('settingsRowsAll', {});")
    if (reads.length) { console.error('  ✗ selftest: read ops falsely flagged: ' + reads.join(',')); stFailed++ }
    // Phase-2 scanner: any receiver's write-shaped .call is caught; reads pass.
    const universe = new Set(['upsert', 'setMeta', 'purgeRecycleBin', 'settingsRowPut', 'deleteMeta'])
    const p2 = scanWriteCallSites("db.call('upsert', t); dbm.call?.('setMeta', kv); state.db.call('purgeRecycleBin'); x.settingsRowPut && db.call('settingsRowPut', r); db.call('getMeta', k); db.call('queryTodos', q); db.call(\"deleteMeta\", k);", universe)
    if (!(p2.includes('upsert') && p2.includes('setMeta') && p2.includes('purgeRecycleBin') && p2.includes('settingsRowPut') && p2.includes('deleteMeta'))) { console.error('  ✗ selftest: P2 planted writes not caught: ' + p2.join(',')); stFailed++ }
    if (p2.length !== 5) { console.error('  ✗ selftest: P2 scanner flagged non-writes: ' + p2.join(',')); stFailed++ }
    // Comments are stripped: a doc example must not flag.
    const commented = scanWriteCallSites("// db.call('upsert', t) example\n/* db.call('setMeta', k) */", universe)
    if (commented.length) { console.error('  ✗ selftest: comment examples falsely flagged: ' + commented.join(',')); stFailed++ }
    // Dynamic-op writes are caught.
    const dyn = scanDynamicWriteSites("dbCall(opName, p); bus.commitOp(opVar, p); state.db.call(op, p); db.call('upsert', t); fn.call(this, x);")
    if (dyn.length !== 2) { console.error('  ✗ selftest: dynamic writes mis-flagged (' + dyn.length + ', want 2): ' + dyn.map(d => d.line.trim()).join(' | ')); stFailed++ }
    if (!dyn.some(d => d.line.includes('state.db.call(op'))) { console.error('  ✗ selftest: db-receiver dynamic write not caught'); stFailed++ }
    // Stamp-clamp literal detector: equivalent spellings of the 10-min window are all caught;
    // unrelated numbers / identifiers / comment text are not.
    const win = new Set([600000, 300000])
    const plantedWindows = findClampWindowLiterals("const A = 600000; const B = 6e5; const C = 1000 * 60 * 10; const D = 60 * 1000 * 10; const E = 3e5; const F = 0x927C0; const G = 5 * 60 * 1000", win)
    if (plantedWindows.length !== 7) { console.error('  ✗ selftest: clamp-window spellings mis-caught (' + plantedWindows.length + ', want 7): ' + plantedWindows.map(h => h.text).join(' | ')); stFailed++ }
    const cleanSrc = findClampWindowLiterals("const t = 30000; const n = 60 * 1000; const clamp600000 = 1; x.slice(0, 1000); // 600000 in a comment\n/* 5 * 60 * 1000 in a block */", win)
    if (cleanSrc.length) { console.error('  ✗ selftest: clamp detector falsely flagged: ' + cleanSrc.map(h => h.text).join(' | ')); stFailed++ }
    checkRows(m => { console.error(m); stFailed++ })
    if (stFailed) process.exit(1)
    console.log('  ✓ command-bus gate self-test passed')
    process.exit(0)
  }
  const pass = run()
  checkRows(m => { console.error('  ✗ ' + m); failed++ })
  // D6 P2 (2026-09-21): manifest localKeys mirror ≡ sync-apply authoritative filters.
  try {
    const syncApplyMod = require(path.join(root, 'src/main/sync-apply'))
    if (!checkLocalKeyMirror(m => { console.error('  ✗ ' + m); failed++ }, syncApplyMod)) failed++
    else console.log('  ✓ manifest localKeys 镜像与 sync-apply 过滤器分类一致（' + MIRROR_KEY_CORPUS.length + ' 个生成键，覆盖全部家族的匹配/不匹配形态）')
  } catch (e) {
    console.error('  ✗ 无法加载 sync-apply 以比对 localKeys 镜像:', e && e.message)
    failed++
  }
  // Arch review 2026-09-22 rec #3: ONE shared future-stamp clamp constant, imported by both doors.
  if (!checkSharedStampClamp(m => { console.error('  ✗ ' + m); failed++ })) failed++
  else console.log('  ✓ 未来戳钳制窗口为共享常量（command-bus.js 与 sync-apply.js 均引入 stamp-clamp.js）')
  console.log(failed === 0 && pass ? '[check-command-bus] PASS' : '[check-command-bus] FAIL')
  process.exit(failed === 0 && pass ? 0 : 1)
}
module.exports = { scanSource, scanWriteCallSites, scanWriteSites, scanDynamicWriteSites, checkRows, checkLocalKeyMirror, checkSharedStampClamp, MIRROR_KEY_CORPUS, stripComments, evalNumericProduct, findClampWindowLiterals, parseStampClampMs }
