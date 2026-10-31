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
 * W21 (2026-10-30) 增补：
 *   1) 修辞合规检测（实锤 653a9000：两行注释压一行让 EditPanel.vue 801→800 擦线过门）。
 *      第二度量 netCodeChars = 剥掉注释/空白行后的净代码字符量（.vue 只取 script 段）。
 *      行数下降跨越/处于硬上限邻域但净代码字符量未同步下降 = 修辞合规，报红。
 *      比对对象是 git show HEAD:<file> 的同度量；无 git/文件不在 HEAD 时跳过（fixture 树）。
 *      baseline 旧条目（纯数字）无该字段时只做行数判定，--update-baseline 后渐进迁移为 {lines,net}。
 *
 *      阈值与误报风险说明：判红条件 = 净字符降幅 < 行数降幅 × 旧均行宽 × 0.5。
 *      0.5 系数是刻意放宽的灰度：真实重构几乎总能把净字符降到位（拆走整段代码），
 *      而注释搬运/重排的净字符变化 ≈ 0。已知误报形态：把一行长代码「格式化成多行短行」
 *      反向操作（合并短行）且恰在 cap 邻域——此时行数大降净字符也可能不达标，会被误红；
 *      误报走 --update-baseline 或拆分消化，宁可误红不放行修辞擦线。
 *      CRLF 归一后再量，两侧同规则。
 *
 *   2) 渐进收紧（新文件严档）：无 baseline 且 HEAD 里不存在的文件（= 新文件）按
 *      error 600 / warn 400 判；存量（HEAD 已跟踪或 baseline 登记）维持各自旧 cap——
 *      不一次性压存量，避免爆出一批历史 error。无法读取 git（fixture 无 .git）时严档关闭，
 *      退回旧 cap（金标 fs 夹具依赖此退化路径）。
 *
 *   3) commitments 段：structure-baseline.json 可登记限期拆分承诺
 *      { "<rel>": { "due": "YYYY-MM-DD", "note": "..." } }，超期（due < 今天）即红。
 *      note 缺失/过短同样红（承诺必须写明拆分方案）。
 *
 * 用法：
 *   node cli/check-file-size.cjs                # 全量扫描（check:all 层）
 *   node cli/check-file-size.cjs --staged       # 只查 git staged 的文件（pre-commit 层，秒级）
 *   node cli/check-file-size.cjs --update-baseline
 */
const fs = require('fs')
const path = require('path')

const ROOT = process.env.GATE_ROOT || path.join(__dirname, '..') // GATE_ROOT: golden-fixture self-tests point the gate at a temp tree
const BASELINE = process.env.GATE_BASELINE || path.join(__dirname, 'structure-baseline.json') // GATE_BASELINE (W22): commitments self-tests point the ratchet at a fixture baseline

// 新文件严档（W21）：无 baseline/grandfather 的新文件按这对判；存量文件用各自分级上限。
const NEW_FILE_LIMITS = { warn: 400, error: 600 }

// 行数上限（warn, error），按目录/类型分级。error 才判红；warn 打印但不阻塞。
// W21: 补 server/ 条目——此前 server/ 落在 fallback(1200) 盲区（sync-relay.mjs 620 行无人看管）。
const LIMITS = [
  { test: p => /^renderer\/js\/store\//.test(p), warn: 400, error: 700 },
  { test: p => /^renderer\/js\/utils\//.test(p), warn: 300, error: 500 },
  { test: p => /^renderer\/js\/views\//.test(p) && p.endsWith('.vue'), warn: 500, error: 800 },
  { test: p => /^renderer\/js\/components\//.test(p) && p.endsWith('.vue'), warn: 500, error: 800 },
  { test: p => /^renderer\/js\//.test(p), warn: 500, error: 800 },
  { test: p => /^src\/main\//.test(p), warn: 500, error: 800 },
  { test: p => /^shared\//.test(p), warn: 300, error: 500 },
  { test: p => /^cli\//.test(p), warn: 500, error: 800 },
  { test: p => /^server\//.test(p), warn: 500, error: 800 }
]

function limitFor (rel) {
  for (const l of LIMITS) if (l.test(rel)) return l
  return { warn: 800, error: 1200 }
}

// shared walker (lib-filescan.cjs) — default skips (node_modules/dist/renderer-dist/dot-dirs)
// and default exts (.js/.vue/.cjs/.mjs, no .d.ts) match this gate's former hand-rolled copy exactly
const { listFiles } = require('./lib-filescan.cjs')

// ---- W21: net-code metrics -------------------------------------------------

/** Heuristic comment stripper (structure measurement, not parsing): block comments and
 *  line comments blanked in place. ONE alternating scan — `/\*...\*\/` and `//...` compete
 *  left-to-right, so a `/*` that only appears inside a line comment ("locales/*.js") is
 *  consumed by the line-comment arm instead of opening a phantom block comment that would
 *  blank real code up to the next star-slash (this exact shape exists in renderer/js/i18n/index.js:9).
 *  Remaining heuristic false-positive surface: `//` or `/*` inside string/template literals is
 *  stripped as a comment — symmetric on both sides of the comparison, so the rhetorical
 *  ratchet tolerates the noise. */
function blankComments (src) {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, m => m.replace(/[^\n]/g, ' '))
}

/** For .vue files only the <script> section counts as code (template/style lines are not
 *  the rhetorical currency a splitter moves around). No <script> → net 0 (skip check). */
function scriptSection (src) {
  const m = src.match(/<script[^>]*>([\s\S]*?)<\/script>/i)
  return m ? m[1] : ''
}

/** Normalize CRLF first so Windows/POSIX checkouts measure identically. */
function measure (src, isVue) {
  const norm = src.replace(/\r\n/g, '\n')
  const body = isVue ? scriptSection(norm) : norm
  const net = blankComments(body)
    .split('\n')
    .filter(l => l.trim())
    .join('').length
  return { lines: norm.split('\n').length, net }
}

function headMetrics (file, isVue, git) {
  try {
    return measure(git(['show', 'HEAD:' + file]), isVue)
  } catch {
    return null // not in HEAD / no repo / transient git error → rhetorical check skipped for this file
  }
}

// ---- baseline (schema v2: { files: { rel: {lines, net} }, commitments: {...} }) ----

function loadBaseline () {
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
  } catch (e) {
    // ENOENT = first run, an empty ratchet is legitimate. Any other failure (corrupt JSON,
    // unreadable) would silently disable every baseline exemption — refuse instead of going green.
    if (e && e.code === 'ENOENT') return { files: {}, commitments: {} }
    console.error('✗ structure-baseline.json exists but cannot be parsed (' + e.message + ') — the size ratchet would silently run with zero exemptions, refusing to fake-green')
    process.exit(1)
  }
  const legacy = !(raw.files || raw.commitments) // old flat { rel: lines } schema
  const filesSrc = legacy ? raw : (raw.files || {})
  const files = {}
  for (const [rel, v] of Object.entries(filesSrc)) {
    // legacy number entries have no net metric — line-count judgment only, migrated on next --update-baseline
    files[rel] = typeof v === 'number' ? { lines: v, net: null } : v
  }
  return { files, commitments: legacy ? {} : (raw.commitments || {}) }
}

// ---- git helpers (env-scrubbed, toplevel-aware; mirrors the --staged block below) ----

function makeGit (root) {
  let cachedTop = null
  let failed = false
  const gitEnv = () => {
    const e = { ...process.env }
    delete e.GIT_DIR; delete e.GIT_WORK_TREE; delete e.GIT_INDEX_FILE
    return e
  }
  const git = args => {
    if (failed) throw new Error('git unavailable')
    const { execFileSync } = require('child_process')
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: gitEnv() })
  }
  return {
    git,
    // repo-root-relative prefix for a ROOT-relative path (ROOT may be a nested pickdone/)
    toRel (rel) {
      if (failed) return null
      try {
        if (cachedTop == null) cachedTop = git(['rev-parse', '--show-toplevel']).trim()
        return path.relative(cachedTop, path.join(root, rel)).replace(/\\/g, '/')
      } catch { failed = true; return null }
    },
    trackedSet () {
      try { return new Set(git(['ls-files']).split('\n').filter(Boolean)) } catch { failed = true; return null }
    }
  }
}

function main () {
  const args = process.argv.slice(2)
  const baseline = loadBaseline()

  if (args.includes('--update-baseline')) {
    const files = {}
    for (const file of listFiles(ROOT)) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/')
      if (rel.startsWith('tests') || rel.startsWith('scripts') || rel.startsWith('browser-dev')) continue
      const { error } = limitFor(rel)
      const m = measure(fs.readFileSync(file, 'utf8'), file.endsWith('.vue'))
      if (m.lines <= error) { delete files[rel]; continue } // 降到限内：棘轮条目退役
      const old = baseline.files[rel]
      if (old != null) {
        if (m.lines < old.lines) files[rel] = m
        else { files[rel] = old; console.log(`  (ratchet) ${rel}: baseline 保持 ${old.lines}（当前 ${m.lines} 涨行——先拆分再降档）`) }
      } else {
        files[rel] = m
        console.log(`  (ratchet) ${rel}: 登记棘轮起点 ${m.lines}（net ${m.net}）`)
      }
    }
    fs.writeFileSync(BASELINE, JSON.stringify({ files, commitments: baseline.commitments }, null, 2) + '\n')
    console.log('[file-size] baseline 已按棘轮规则更新（只降不升，条目迁移为 {lines,net}）')
    return
  }

  let files
  let stagedAdded = null // --diff-filter=A names, for the new-file strict tier
  const g = makeGit(ROOT)
  if (args.includes('--staged')) {
    // git executes hooks with GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE injected; with GIT_DIR set,
    // `rev-parse --show-toplevel` resolves against the hook's cwd (relay/pickdone) instead of
    // the real worktree root, so every joined path missed and the gate refused (caught live in
    // the relay worktree, 2026-10-10). Strip the injected git env for BOTH calls: git then
    // discovers the repo upward from cwd (pickdone → worktree .git), toplevel stays truthful.
    const top = g.git(['rev-parse', '--show-toplevel']).trim()
    // W16 fix(#2): ACMR — git mv 只产生 R 条目,ACM 漏掉改名文件(与 lint-staged.mjs 对齐)
    // W17 fix(2026-10-28): quotePath=false — git 默认把非 ASCII 路径打成带引号八进制串,扩展名
    // 正则(尾引号不匹配)会静默剔除,staged 扫描面塌缩回 0 假绿。pre-commit 的 `-c` 是单次性的,
    // 不会传播到本子进程,必须自带。`-c` 与 lint-staged 的 -z 等价达成同一语义,选前者改动最小。
    const out = g.git(['-c', 'core.quotePath=false', 'diff', '--cached', '--name-only', '--diff-filter=ACMR'])
    // git prints paths relative to the REPO toplevel, which is NOT this dir (pickdone/ nests
    // inside the repo root): resolving them against ROOT silently matched nothing and the
    // staged gate checked ZERO files for its whole life (the 2026-10-10 ratchet-red-on-main
    // root cause). Resolve against the toplevel and refuse to fake-green on a mismatch.
    const names = out.split('\n').filter(Boolean)
    stagedAdded = new Set(g.git(['-c', 'core.quotePath=false', 'diff', '--cached', '--name-only', '--diff-filter=A']).split('\n').filter(Boolean))
    // Match the full walker source extensions (exclude generated JSON lockfiles).
    const sourceNames = names.filter(n => /\.(?:js|cjs|mjs|vue)$/.test(n))
    // W21 fix(#2): a staged file that vanished from the worktree used to be SILENTLY dropped
    // from the scan (.existsSync filter) — a shrink-to-fake-green hole. Name and red each one
    // (same policy as check-boot-order.cjs' staged missing-file tripwire).
    const missing = sourceNames.filter(f => !fs.existsSync(path.join(top, f)))
    if (missing.length) {
      console.error('✗ [file-size] staged 文件在工作区已不存在——扫描面会静默塌缩，拒绝假绿:\n  ' + missing.join('\n  '))
      process.exit(1)
    }
    files = sourceNames.map(f => path.join(top, f))
    // W21 fix(#2) regression guard (2026-10-30): an empty sourceNames is NORMAL (docs-only commit —
    // the extension filter already removed them); red only when source files were staged but none
    // resolved, which the per-file missing tripwire above has by then already named exactly.
    if (!files.length && sourceNames.length) {
      console.error('✗ [file-size] staged names resolved to zero existing files (toplevel mismatch) — refusing to pass blindly')
      process.exit(1)
    }
  } else {
    files = listFiles(ROOT)
  }

  const tracked = g.trackedSet() // null = no git → strict tier and rhetorical check stay off (fixture trees)
  const topRel = rel => g.toRel(rel)
  const errors = []
  const warns = []
  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/')
    if (rel.startsWith('tests') || rel.startsWith('scripts') || rel.startsWith('browser-dev')) continue
    const { warn, error } = limitFor(rel)
    const src = fs.readFileSync(file, 'utf8')
    const m = measure(src, file.endsWith('.vue'))
    const grandfather = baseline.files[rel]
    const isNew = stagedAdded
      ? stagedAdded.has(topRel(rel) || rel) && !grandfather
      : (tracked ? !tracked.has(rel) && !grandfather : false) // ls-files ran with cwd=ROOT → paths are ROOT-relative
    // 渐进收紧：只有「新文件」（HEAD 不存在 + 无 baseline）吃严档（取分级上限与严档中较严者）；
    // 存量维持旧 cap 不回溯。
    const capLine = grandfather
      ? Math.max(error, grandfather.lines)
      : (isNew ? Math.min(error, NEW_FILE_LIMITS.error) : error)
    // 修辞合规检测范围：baseline 登记（grandfather）文件，或 --staged 面（小集合，可逐个
    // git show）。全量模式对每个非 baseline 文件都 git show 会把 1454 个文件变成 1454 次
    // 子进程调用——不做；全量模式由 baseline 集合 + 检出树增量覆盖。
    const rhetoricsOn = grandfather != null || args.includes('--staged')
    let rhetoricRed = null
    if (rhetoricsOn && tracked) {
      const relTop = topRel(rel)
      const old = relTop ? headMetrics(relTop, file.endsWith('.vue'), g.git) : null
      if (old) {
        const lineDrop = old.lines - m.lines
        const crossing = lineDrop > 0 && m.lines <= (isNew ? capLine : error) && old.lines > (isNew ? capLine : error)
        const nearCapShave = lineDrop >= 3 && m.lines > (isNew ? capLine : error) * 0.95
        if (crossing || nearCapShave) {
          const avg = old.lines ? old.net / old.lines : 0
          const required = lineDrop * avg * 0.5 // 0.5 灰度系数见文件头注释（误报风险说明）
          if (old.net - m.net < required) {
            rhetoricRed = `行数 ${old.lines}→${m.lines} 但净代码字符 ${old.net}→${m.net}（降幅不足阈值 ${Math.round(required)}）——修辞合规：拆走真实代码，不是压注释/重排`
          }
        }
      }
    }
    if (m.lines > capLine) {
      errors.push(`${rel}: ${m.lines} 行 > 上限 ${isNew ? capLine + '（新文件严档）' : error}${grandfather ? `（棘轮 baseline ${grandfather.lines}——只准拆不准涨）` : ''}`)
    } else if (rhetoricRed) {
      errors.push(`${rel}: ${rhetoricRed}`)
    } else if (m.lines > warn) {
      warns.push(`${rel}: ${m.lines} 行（warn ${warn}，接近 error ${error}）`)
    }
  }

  // commitments：限期拆分承诺，超期或无 note 即红（承诺不是永久豁免，是倒计时）。
  // W22 fix(2026-10-30)：用本地日期拼 YYYY-MM-DD —— toISOString().slice(0,10) 是 UTC 日,
  // UTC+8 的每天 0-8 点会把"今天"错算成昨天,让到期承诺晚 8 小时才熔断。
  const _now = new Date()
  const today = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}-${String(_now.getDate()).padStart(2, '0')}`
  for (const [rel, c] of Object.entries(baseline.commitments)) {
    if (!c || !c.note || String(c.note).trim().length < 4) {
      errors.push(`commitments: ${rel} 的拆分承诺缺 note（须写明拆分方案与去向）`)
      continue
    }
    if (!c.due || String(c.due) < today) {
      errors.push(`commitments: ${rel} 拆分承诺已超期（due=${c.due || '未填'}）——立即拆分或显式改期（改期须手改 structure-baseline.json 并说明理由）`)
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
