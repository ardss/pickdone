/** 账本写点清单门禁(2026-09-04 根修批4):番茄账本唯一事实源 = SQLite tomato_records 行表。
 *  历史事故模式:渲染端 LS blob 全量覆写 / meta 镜像双轨 / CLI 并行通道 —— 任何一个回潮都会复活
 *  "删除复活/多窗互踩/统计对不上" 三类同步 bug。本文件锁死写点清单,回潮即红。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

test('write-point: CLI 账本操作直写行表 op,不经命令通道', () => {
  const lib = read('cli/lib.js')
  const backfillFn = lib.slice(lib.indexOf('function backfillRecord'), lib.indexOf('/* ---------------- Tomato estimate'))
  assert.ok(backfillFn.includes("call('tomatoAppendMany'"), 'backfillRecord must append the row directly')
  assert.ok(!backfillFn.includes('writeTomatoCmd'), 'backfillRecord must not go through the command channel')
  const fixFn = lib.slice(lib.indexOf('function recordFix'), lib.indexOf('function recordRemove'))
  assert.ok(fixFn.includes("call('tomatoUpdateById'"), 'recordFix must update the row directly')
  const rmFn = lib.slice(lib.indexOf('function recordRemove'), lib.indexOf('function moveSubtask'))
  assert.ok(rmFn.includes("call('tomatoRemoveByIds'"), 'recordRemove must delete the row directly')
  // 查询也必须走行表,不得回读 meta 旧镜像
  const qFn = lib.slice(lib.indexOf('function tomatoRecords'), lib.indexOf('function backfillRecord'))
  assert.ok(qFn.includes("call('tomatoAll'"))
  assert.ok(!qFn.includes('db.tomatoState'), 'tomatoRecords must not read the retired meta mirror')
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
