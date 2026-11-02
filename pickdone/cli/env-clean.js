/** Local environment cleanup (companion to the 2026-09-02 environment-isolation audit) — clears test/dev residue left in the system temp directory.
 *  Works both as a standalone CLI (node cli/env-clean.js, see the main branch at the end of the file) and reused by the pickdone CLI `clean` subcommand.
 *  Only touches regenerable test/dev residue; never touches the real user data under %APPDATA%\pickdone. */
const fs = require('fs')
const os = require('os')
const path = require('path')

/** Collect cleanable targets: test-isolation userData (todo-test-* and pd-it-*), test logs, the dev
 *  data directory (.dev-data) are default targets. The legacy repo-tree pickdone-backups leak
 *  (auto snapshots the old parent-of-userData derivation wrote next to the source tree) is
 *  OPT-IN via --all: unlike the other targets it is not pure residue — a user may have moved
 *  real backups there, so bulk-deleting it must never happen on a bare clean. */
// W28 fix(2026-11-01): the old hard-coded pair (todo-test- / pd-it-) had DRIFTED from the real
// mkdtemp prefix family (todo-cli-smoke- / todo-shared- / todo-smoke- / pd-upd- / journey- /
// pickdone-* / jrelay- ... — none of them matched, so the clean tool silently left most test
// residue in %TEMP%). This is a SYNCED MANIFEST of tests/lib/tmp-dir.mjs's FAMILY_FALLBACK
// (that registry is ESM and extracts prefixes from the tests/ sources; cli/env-clean.js is CJS
// and cannot require it — keep the two in step when a new prefix family lands there).
// w29 fixes (2026-11-01), both synced to tmp-dir.mjs FAMILY_FALLBACK:
//  ① 补齐实测在用前缀：cov-ratchet-test- (tests/unit/cli/check-coverage-ratchet.test.mjs:70)、
//     ratchet-test- (tests/unit/cli/d11-cli-tomato-schedule-taxonomy.test.mjs:224)、
//     vp-linux-sha- (tests/verify-packaged-linux-sha.test.mjs:21)。
//  ② 收窄破坏面：旧 `d\d{1,3}-` / `r\d+-` 是裸前缀圈地——os.tmpdir() 是共享面，用户自己的
//     `d1-tools`、`r42-notes` 等（stale>12h）会被 rmSync recursive 误删。逐个 grep tests/|cli/
//     实测后枚举真实产出前缀（mkdtempSync/isolatedTmpDir/withTmpDir/newTmpLib 调用点），宁可
//     少清（漏网的靠 tmp-dir.mjs 抽取式 sweeper 兜）也不误删无关目录。
const TEST_TMP_FAMILY = /^(?:todo-|todo-cov-|jrelay-|cov-ratchet-test-|ratchet-test-|vp-linux-sha-|lan-sync-|pd-|journey-|relay-|pickdone-|d(?:3|4|6|7|9|1[0-5]|1[789]|2[0-2]|25|26)-|r(?:1|4c?|6|17)-)/
// Same safety doctrine as the tmp-dir.mjs preflight sweeper: a FRESH directory may belong to a
// suite running RIGHT NOW (deleting it mid-run cascades MODULE_NOT_FOUND into unrelated tests),
// and a live `pid<N>` marker means an owning process still exists — never touch either.
const STALE_MS = 12 * 60 * 60 * 1000

function collectTargets ({ all = false, appRoot }) {
  const targets = []
  const tmp = os.tmpdir()
  for (const entry of fs.readdirSync(tmp)) {
    if (!TEST_TMP_FAMILY.test(entry)) continue
    const pidM = entry.match(/pid(\d+)/)
    // w29 fix(2026-11-01): only ESRCH proves the owner is gone. On Windows process.kill(pid, 0)
    // throws EPERM for a LIVE process owned by someone else — treating any catch as "dead" used
    // to delete a running suite's temp dir mid-flight (same semantics as tmp-dir.mjs pidDead).
    if (pidM) { try { process.kill(Number(pidM[1]), 0); continue } catch (e) { if (!e || e.code !== 'ESRCH') continue } }
    try { if (Date.now() - fs.statSync(path.join(tmp, entry)).mtimeMs < STALE_MS) continue } catch { continue }
    targets.push({ p: path.join(tmp, entry), label: '测试临时 userData' })
  }
  targets.push({ p: path.join(appRoot, 'tests', '.artifacts'), label: '测试日志产物' })
  targets.push({ p: path.join(appRoot, '.dev-data'), label: '开发数据目录(.dev-data)' })
  // cli-3: `--all` was a dead flag (collected but never consulted). It now means exactly one
  // thing: include the pickdone-backups repo-tree leak in the cleanup pass.
  if (all) targets.push({ p: path.join(appRoot, 'pickdone-backups'), label: '仓库残留备份泄漏(pickdone-backups)' })
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

/** Run the cleanup. Returns {list:[{label,p,size,cleaned}], total, failedCount}
 *  W28: `list` is capped at MAX_LIST entries (totalCount carries the real size) — a %TEMP%
 *  with tens of thousands of stale family dirs used to blow up consumers' stdio buffers
 *  (the CLI --json path failed with ERR_CHILD_PROCESS_STDIO_MAXBUFFER on this exact shape). */
const MAX_LIST = 500
function cleanEnv ({ all = false, dry = false, appRoot }) {
  const collected = collectTargets({ all, appRoot })
  const list = []
  let failedCount = 0
  let total = 0
  for (const t of collected) {
    const size = dirSize(t.p)
    let cleaned = false
    if (!dry) {
      try { fs.rmSync(t.p, { recursive: true, force: true }); cleaned = true } catch { failedCount++ }
    } else cleaned = true
    if (list.length < MAX_LIST) list.push({ label: t.label, path: t.p, size, sizeText: fmt(size), cleaned })
    total += size
  }
  return { list, totalCount: collected.length, total, totalText: fmt(total), failedCount }
}

module.exports = { cleanEnv, collectTargets, fmt, TEST_TMP_FAMILY }

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
