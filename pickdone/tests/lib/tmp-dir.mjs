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

/**
 * 创建隔离临时目录并注册自动清理(测试结束/进程退出兜底 rmSync)。
 * @param {string} prefix mkdtemp 前缀
 * @returns {string} 目录绝对路径
 */
export function isolatedTmpDir (prefix = 'todo-tmp-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
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
