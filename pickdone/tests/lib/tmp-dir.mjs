/**
 * D4 测试卫生共享 helper — 临时目录与隔离 env。
 *
 * 背景(2026-09 卫生债审计):
 *   ① 84 个测试文件顶层 `mkdtempSync` 后从不 `rmSync`,测试进程退出即泄漏临时目录
 *      (run-all.mjs 每 suite 复用同一进程,长 CI 会积累上千个目录);
 *   ② tests/unit/cli/ 33 个文件裸 `process.env.TODO_DB_DIR=` 赋值不 save/restore。
 *
 * 前提锚定:TodoList 测试模型是「每文件一个独立 node 进程」(run-all.mjs 对每个
 *   *.test.mjs spawn 一次),所以顶层 `process.env.TODO_DB_DIR = ...` 在同文件内
 *   覆盖是安全的;withIsolatedEnv 供需要临时切换 env 的用例/文件使用,退出即恢复。
 *
 * 用法(推荐顶层一次,全文件共享):
 *   const dataDir = isolatedTmpDir('todo-clipre')          // 返回目录,进程退出钩子自动清理
 *   process.env.TODO_DB_DIR = dataDir
 * 或需要精确清理时:
 *   await withTmpDir('todo-x-', async dir => { ... })      // finally rmSync
 * 或需要临时切换 env:
 *   withIsolatedEnv({ TODO_DB_DIR: dir }, () => { ... })   // 返回值透传,异常也恢复
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
// 进程退出时统一清扫本进程创建的所有临时目录(含未走 finally 的顶层泄漏兜底)
const created = new Set()
let hooksInstalled = false
// maxRetries: win32 上 open 的 SQLite 句柄在 'exit' 钩子时刻尚未释放,unlink 报 EBUSY/EPERM;
// 重试缓解短占用,但 DB 目录在 win32 上可能仍残留(Linux CI 上 unlink-open 语义直接成功)。
function sweep () {
  for (const d of created) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* best effort */ }
  }
}
function installExitHooks () {
  if (hooksInstalled) return
  hooksInstalled = true
  for (const evt of ['exit', 'beforeExit']) {
    process.on(evt, sweep)
  }
}

/* ---------------- Preflight sweeper (2026-10-09) ----------------
 * Context: exit-only cleanup is bypassed whenever a test child is SIGKILLed / taskkilled
 * (watchdog kill, boot-stall kill, CI job timeout) — %TEMP% accumulated ~14k dirs / ~9.2GB
 * of orphaned test dirs that no exit hook would ever reclaim. The sweeper runs ONCE at the
 * top of tests/run-all.mjs, before any child is spawned, and only deletes dirs that are
 * provably orphaned. Double-guard semantics: a FRESH mtime or a LIVE owning pid means the
 * entry is NEVER deleted, no matter what else matches. */

// Age beyond which a test temp dir is considered abandoned (a full suite run is minutes;
// anything older than half a day cannot belong to a run in progress).
const STALE_MS = 12 * 60 * 60 * 1000

// The test suite's temp-dir prefix family (audit 2026-10-09): every direct
// mkdtempSync(path.join(os.tmpdir(), '<prefix>...')) call in tests/ + pickdone/test/ uses
// one of these families. Anything OUTSIDE the family is never touched.
const FAMILY = /^(todo-|d\d{1,3}-|lan-sync-|pd-|journey-|relay-|pickdone-|r\d+-)/
// Directory names carry the owning pid as `<prefix>...pid<pid>-<mkdtemp-random>` so the
// sweeper can prove the owner is dead before deleting.
const PID_RE = /pid(\d+)-/

/** True when the pid encoded in a dir name is provably not running on this machine. */
function pidDead (name) {
  const m = PID_RE.exec(name)
  if (!m) return true // no pid encoding: only deletable via the 12h age guard below
  try {
    process.kill(Number(m[1]), 0)
    return false // signal 0 = existence probe; success ⇒ alive
  } catch (e) {
    return e.code === 'ESRCH' // ESRCH = no such process; EPERM = alive (owned by someone else)
  }
}

/**
 * Delete orphaned test temp dirs from os.tmpdir(): an entry is removed only when it
 * (a) matches the suite's prefix family, (b) has an mtime older than 12h, AND
 * (c) carries no live owning pid. Fresh mtime OR live pid ⇒ never deleted.
 * @returns {{ scanned: number, removed: number }} best-effort counts for logging
 */
export function sweepStaleTmpDirs () {
  let scanned = 0
  let removed = 0
  let entries = []
  try { entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true }) } catch { return { scanned, removed } }
  const now = Date.now()
  for (const e of entries) {
    if (!e.isDirectory() || !FAMILY.test(e.name)) continue
    scanned++
    const full = path.join(os.tmpdir(), e.name)
    let st = null
    try { st = fs.statSync(full) } catch { continue }
    if (now - st.mtimeMs < STALE_MS) continue // guard 1: fresh — maybe an in-flight run
    if (!pidDead(e.name)) continue // guard 2: owning pid alive — never delete
    try {
      fs.rmSync(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      removed++
    } catch { /* locked by another process — leave it for the next sweep */ }
  }
  return { scanned, removed }
}

/**
 * 创建隔离临时目录并注册自动清理(测试结束/进程退出兜底 rmSync)。
 * 目录名编码 owning pid(`<prefix>...pid<pid>-<随机>`)供 sweepStaleTmpDirs 判活。
 * @param {string} prefix mkdtemp 前缀
 * @returns {string} 目录绝对路径
 */
export function isolatedTmpDir (prefix = 'todo-tmp-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix + 'pid' + process.pid + '-'))
  created.add(dir)
  installExitHooks()
  return dir
}

/**
 * withTmpDir:创建临时目录,回调结束后(含异常)立即 rmSync。
 * @template T
 * @param {string} prefix
 * @param {(dir: string) => T} fn
 * @returns {Promise<T>|T}
 */
export async function withTmpDir (prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix + 'pid' + process.pid + '-'))
  try {
    return await fn(dir)
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

/**
 * withIsolatedEnv:临时覆盖 process.env 片段,回调结束后(含异常)恢复原值。
 * 依赖每文件独立进程的既有前提;在需要文件内多次切换 env 的场景用这个替代裸赋值。
 * @template T
 * @param {Record<string, string|undefined>} patch 覆盖项(undefined 表示删除该键)
 * @param {() => T} fn
 * @returns {T}
 */
export function withIsolatedEnv (patch, fn) {
  const saved = new Map()
  for (const [k, v] of Object.entries(patch)) {
    saved.set(k, process.env[k])
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/**
 * newTmpLib:TODO_DB_DIR 指向隔离临时目录后 require cli/lib.js 的标准入口。
 * cli/lib.js 进程内缓存 DB 连接,因此每文件只能初始化一次;本 helper 固化
 * 「先设 env 再 require」顺序,防止真实 %APPDATA%/pickdone 被意外写入。
 * @param {string} prefix
 * @returns {{ lib: any, dir: string }}
 */
export function newTmpLib (prefix = 'todo-lib-') {
  const dir = isolatedTmpDir(prefix)
  process.env.TODO_DB_DIR = dir
  return { lib: require_('../../cli/lib.js'), dir }
}
