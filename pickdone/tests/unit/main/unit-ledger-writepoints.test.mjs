/** 账本写点清单门禁(2026-09-04 根修批4):番茄账本唯一事实源 = SQLite tomato_records 行表。
 *  历史事故模式:渲染端 LS blob 全量覆写 / meta 镜像双轨 / CLI 并行通道 —— 任何一个回潮都会复活
 *  "删除复活/多窗互踩/统计对不上" 三类同步 bug。本文件锁死写点清单,回潮即红。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'

const require = createRequire(import.meta.url) // cli/lib.js and src/main/db.js are CJS; requirable from this ESM test

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

test('write-point: tomato store 不再持有账本持久化(无 dbMirror/墓碑/抢救/冷热归档)', () => {
  const s = read('renderer/js/store/tomato.js')
  assert.ok(!s.includes('dbMirror'), 'store must not import dbMirror (ledger lives in DB rows now)')
  assert.ok(!s.includes('mirrorToDb'), 'store must not mirror blob to meta')
  assert.ok(!s.includes('deleteTombstones'), 'tombstones retired: DB row delete is the truth')
  assert.ok(!s.includes('rescueRecentRecords'), 'rescue retired: no LS blob records to rescue')
  assert.ok(!s.includes('ARCHIVE_PREFIX'), 'hot/cold LS archives retired')
  // 账本所有变更必须经 ledgerWrite(原子 op),不允许别的落盘路径
  assert.ok(s.includes('tomatoAppendMany') && s.includes('tomatoUpdateById') && s.includes('tomatoRemoveByIds'))
})

test('write-point: 渲染端零处直写 db.tomatoState 镜像', () => {
  const dir = path.join(ROOT, 'renderer/js')
  const offenders = []
  const walk = d => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name)
      if (f.isDirectory()) walk(p)
      else if (f.isFile() && f.name.endsWith('.js') && read(path.relative(ROOT, p)).includes("mirrorToDb('db.tomatoState'")) offenders.push(p)
    }
  }
  walk(dir)
  assert.deepEqual(offenders, [], 'no renderer file may mirror db.tomatoState: ' + offenders.join(','))
})

test('write-point: cliTomatoCmd 通道只留状态机命令(start/stop/attach),账本类命令不回潮', () => {
  const s = read('renderer/js/main.js')
  for (const dead of ["cmd.action === 'record-update'", "cmd.action === 'record-remove'", "cmd.action === 'backfill'"]) {
    assert.ok(!s.includes(dead), 'retired ledger command back in cliTomatoCmd channel: ' + dead)
  }
})

/* 2026-09-13 改造:原实现对 cli/lib.js 做 indexOf+slice 函数体定位再 includes 断言 ——
 * slice 边界一旦失配(函数改名/顺序调整)会得到空串,负向断言恒真(假绿通道)。
 * cli/lib.js 是可 require 的纯 Node 模块,故改为行为断言:在 TODO_DB_DIR 隔离临时库上
 * 真实调用 backfillRecord/recordFix/recordRemove/tomatoRecords,断言行表读写走正确通道
 * (App 不在场时仍可写 = 没有经过 App 命令通道;读到的就是写入的行 = 走行表而非 meta 镜像)。 */
test('write-point: CLI 账本操作直写行表 op(隔离临时库行为验证,不经命令通道)', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'ledger-writepoint-'))
  process.env.TODO_DB_DIR = tmp // must point at the data dir that contains todos.db (see cli/lib.js userDataDir)
  // 隔离 require:避免吃到其他测试进程态(同文件内首此 require;防御性清缓存)
  for (const m of Object.keys(require.cache)) {
    if (m.endsWith('cli/lib.js') || m.endsWith('src/main/db.js')) delete require.cache[m]
  }
  try {
    const lib = require(path.join(ROOT, 'cli/lib.js'))
    // 1. backfill:App 关闭(纯 CLI、临时库)即写成功 → 证明没走 App 命令通道,而是直写行表
    const rec = lib.backfillRecord({ content: 'wp-test', date: '2026-09-13', at: '10:00', minutes: 25 })
    assert.ok(rec.tomatoId && rec.tomatoId.startsWith('tmt_m_'), 'backfillRecord returns a manual ledger row id')
    let rows = lib.tomatoRecords()
    assert.equal(rows.length, 1, 'tomatoRecords reads the row the backfill wrote (row table is the truth)')
    assert.equal(rows[0].tomatoId, rec.tomatoId)
    // 2. fix:更新走行表 op,改动真实落行
    const fixed = lib.recordFix(rec.tomatoId, { minutes: 40 })
    assert.equal(fixed.rec.focusDuration, 40)
    rows = lib.tomatoRecords()
    assert.equal(rows[0].focusDuration, 40, 'recordFix patch landed in the row table')
    // 3. remove:删除走行表 op,行真的消失(删除复活事故的反向防御)
    lib.recordRemove(rec.tomatoId)
    assert.equal(lib.tomatoRecords().length, 0, 'recordRemove deletes the ledger row')
    // 4. 时长钳制走 DB 层共享常量(720 静默截断事故):超限必须 USAGE 报错,而不是写进去一个别的值
    assert.throws(() => lib.backfillRecord({ date: '2026-09-13', minutes: 9999 }),
      e => e.code === 'USAGE', 'over-max backfill must be rejected, not clamped silently')
  } finally {
    try { require(path.join(ROOT, 'src/main/db.js')).close() } catch { /* already closed */ }
    delete process.env.TODO_DB_DIR
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }) } catch { /* temp best-effort */ }
  }
})

/* 负向字符串门禁(完整源码级,非 slice,无空 slice 恒真通道):
 * - 'db.tomatoState' 回读 → CLI 重新读取已退役的 meta 镜像(统计对不上/删除复活)。
 * (账本写不经 App 命令通道这一条已由上面的隔离库行为测试证明——App 不在场时写入仍成功;
 *  writeTomatoCmd 定义/导出本身合法——start/stop 状态机命令通道仍在用,不做全文件负向。) */
test('write-point: cli/lib.js 无 meta 镜像回读(全源码负向门禁)', () => {
  const lib = read('cli/lib.js')
  assert.ok(!lib.includes('db.tomatoState'), 'CLI must never read the retired meta mirror')
})

test('write-point: db.tomatoByDay 聚合自行表,不回读 meta blob', () => {
  const db = read('src/main/db.js')
  const fn = db.slice(db.indexOf('tomatoByDay:'), db.indexOf('tomatoAll:'))
  assert.ok(fn.includes('tomato_records'), 'tomatoByDay must aggregate from the row table')
  assert.ok(!fn.includes('tomatoRecordList'), 'tomatoByDay must not parse the LS/meta blob')
})

test('write-point: 渲染端组件不许直接赋值 tomatoRecordList(只读 + store 变更)', () => {
  const dir = path.join(ROOT, 'renderer/js')
  const offenders = []
  const walk = d => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name)
      if (f.isDirectory()) walk(p)
      else if (f.isFile() && f.name.endsWith('.js') && !String(p).replace(/\\/g, '/').endsWith('store/tomato.js')) {
        const s = read(path.relative(ROOT, p))
        // 直接给账本数组整体赋值 = 私有写点;豁免仅限 store 文件本身(路径判断已排除),import 路径字符串命中不再整文件豁免(2026-09-04 审查 F10)
        if (/(state|s)\.tomatoRecordList\s*=/.test(s)) offenders.push(p)
      }
    }
  }
  walk(dir)
  assert.deepEqual(offenders, [], 'tomatoRecordList assignments outside the store: ' + offenders.join(','))
})
