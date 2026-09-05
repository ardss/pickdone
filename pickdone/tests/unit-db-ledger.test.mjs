/* 番茄账本行存储(src/main/db.js tomato_records)单元测试 — 隔离临时库,不碰真实数据。
   覆盖:append 幂等/更新/删除/extra 字段保全/迁移/按日聚合。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const db = require_('../src/main/db.js')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tomato-ledger-'))
db.init(dir)

const rec = over => Object.assign({
  tomatoId: 'tmt_test_' + Math.random().toString(36).slice(2),
  endTime: Date.now(), dateKey: '2026-09-10', focus: '', focusTaskId: null,
  focusDuration: 25, rest: 5, restDuration: 5, succeed: true, manual: false,
  status: 'local', abandonReason: ''
}, over)

test('ledger: append + all (deterministic id dedupes)', () => {
  const a = rec({ tomatoId: 'tmt_f_100' })
  db.call('tomatoAppendMany', a)
  db.call('tomatoAppendMany', a) // same id twice = one row
  const all = db.call('tomatoAll')
  assert.equal(all.filter(x => x.tomatoId === 'tmt_f_100').length, 1)
  assert.equal(all.find(x => x.tomatoId === 'tmt_f_100').focusDuration, 25)
  assert.equal(all.find(x => x.tomatoId === 'tmt_f_100').succeed, true)
  assert.equal(all.find(x => x.tomatoId === 'tmt_f_100').manual, false)
})

test('ledger: updateById applies field patch and returns matched status', () => {
  db.call('tomatoAppendMany', rec({ tomatoId: 'tmt_f_200', focusDuration: 25 }))
  const ok = db.call('tomatoUpdateById', { tomatoId: 'tmt_f_200', patch: { focusDuration: 50, focusTaskId: 'tid_x' } })
  assert.equal(ok, true)
  const r = db.call('tomatoAll').find(x => x.tomatoId === 'tmt_f_200')
  assert.equal(r.focusDuration, 50)
  assert.equal(r.focusTaskId, 'tid_x')
  assert.equal(db.call('tomatoUpdateById', { tomatoId: 'tmt_missing', patch: { focusDuration: 1 } }), false)
})

test('ledger: removeByIds deletes; unknown ids are no-ops', () => {
  db.call('tomatoAppendMany', rec({ tomatoId: 'tmt_f_300' }))
  db.call('tomatoRemoveByIds', ['tmt_f_300', 'tmt_never_existed'])
  assert.equal(db.call('tomatoAll').some(x => x.tomatoId === 'tmt_f_300'), false)
})

test('ledger: unknown/future fields survive round-trip via extra', () => {
  db.call('tomatoAppendMany', rec({ tomatoId: 'tmt_f_400', someFutureField: 'v1' }))
  const r = db.call('tomatoAll').find(x => x.tomatoId === 'tmt_f_400')
  assert.equal(r.someFutureField, 'v1')
})

test('ledger: tomatoByDay aggregates focus by dateKey within bounds (isolated db, exact value)', () => {
  // 独立库:不与共享库跨测试污染(此前 >= 75 弱断言对多算方向零防御,2026-09-04 深审 P0-1)
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'tomato-ledger-byday-'))
  db.init(fresh)
  const ts10 = new Date('2026-09-10T10:00:00').getTime()
  const tsOct = new Date('2026-10-01T10:00:00').getTime()
  db.call('tomatoAppendMany', [
    rec({ tomatoId: 'tmt_f_501', dateKey: '2026-09-10', endTime: ts10, focusDuration: 25 }),
    rec({ tomatoId: 'tmt_f_502', dateKey: '2026-09-10', endTime: ts10 + 3600e3, focusDuration: 50 }),
    rec({ tomatoId: 'tmt_f_503', dateKey: '2026-10-01', endTime: tsOct, focusDuration: 99 })
  ])
  const rows = db.call('tomatoByDay', { from: '20260901', to: '20260930' })
  const sep10 = rows.find(r => r.ds === '2026-09-10')
  // 精确值:dateKey 由 DB 层按 endTime 重导(2026-09-04 不变式),此处传错 dateKey 也必须落对桶
  assert.ok(sep10, '09-10 必须有聚合行')
  assert.equal(sep10.focus, 75)
  assert.equal(rows.length, 1, '只有一天落在边界内')
  assert.equal(rows.some(r => r.ds === '2026-10-01'), false, '10月记录不落在9月边界内')
})

test('ledger: 迁移对损坏 JSON blob 容错(不抛错、不落行、blob 清理)', () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'tomato-ledger-corrupt-'))
  db.init(fresh)
  db.call('setMeta', ['db.tomatoState', '{"tomatoRecordList": [broken'])
  assert.equal(db.call('tomatoMigrateFromMeta'), 0, '损坏 blob 迁移必须静默容错返回 0')
  assert.equal(db.call('tomatoAll').length, 0)
  assert.equal(db.call('getMeta', 'db.tomatoState'), null, '容错分支同样清 blob,防止之后被复活')
})

test('ledger: migration imports meta blob once, skips when table non-empty', () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'tomato-ledger-mig-'))
  db.init(fresh)
  db.call('setMeta', ['db.tomatoState', JSON.stringify({ tomatoRecordList: [rec({ tomatoId: 'tmt_legacy_1', dateKey: '2026-09-09', focusDuration: 25 })] })])
  assert.equal(db.call('tomatoMigrateFromMeta') >= 1, true)
  assert.equal(db.call('tomatoAll').some(x => x.tomatoId === 'tmt_legacy_1'), true)
  assert.equal(db.call('tomatoMigrateFromMeta'), 0, '表非空时跳过重复迁移')
})

test('ledger: 同 id 竞写收敛为单行,后写胜(UPSERT update 语义;跨进程锁行为由 WAL/better-sqlite3 串行化保证,此处锁幂等收敛性质)', () => {
  const id = 'tmt_c_' + Date.now()
  // 模拟 App 窗口与 CLI 同时落同一确定性 id(完成/补录竞态):先写 25min,后写 50min
  db.call('tomatoAppendMany', rec({ tomatoId: id, focusDuration: 25 }))
  db.call('tomatoAppendMany', rec({ tomatoId: id, focusDuration: 50 }))
  const rows = db.call('tomatoAll').filter(x => x.tomatoId === id)
  assert.equal(rows.length, 1, '同 id 必收敛为单行')
  assert.equal(rows[0].focusDuration, 50, '后写覆盖(UPSERT),不产生双账')
})

test('ledger: 删除-再补录同 id 允许复活为新事实(行删除是终局,无墓碑拦截)', () => {
  const id = 'tmt_d_' + Date.now()
  db.call('tomatoAppendMany', rec({ tomatoId: id }))
  db.call('tomatoRemoveByIds', [id])
  assert.equal(db.call('tomatoAll').some(x => x.tomatoId === id), false)
  db.call('tomatoAppendMany', rec({ tomatoId: id, focusDuration: 40 }))
  assert.equal(db.call('tomatoAll').find(x => x.tomatoId === id).focusDuration, 40, '重删后补录不被墓碑吞掉')
})

test('ledger: update 只改 endTime 时 dateKey 自动随行重导(幽灵行防线)', () => {
  db.call('tomatoAppendMany', rec({ tomatoId: 'tmt_u_1', dateKey: '2026-09-10', endTime: new Date('2026-09-10T10:00:00').getTime() }))
  db.call('tomatoUpdateById', { tomatoId: 'tmt_u_1', patch: { endTime: new Date('2026-09-25T23:30:00').getTime() } })
  const r = db.call('tomatoAll').find(x => x.tomatoId === 'tmt_u_1')
  assert.equal(r.dateKey, '2026-09-25', 'dateKey 必须等于 endTime 所在日,否则按日聚合/时间轴分桶分裂')
})

test('ledger: append 缺 tomatoId/endTime 必须抛错(脏行入表防线);dateKey 由 DB 层重导不受调用方支配', () => {
  assert.throws(() => db.call('tomatoAppendMany', { endTime: Date.now(), dateKey: '2026-09-10' }), /tomatoId/)
  assert.throws(() => db.call('tomatoAppendMany', { tomatoId: 'x', dateKey: '2026-09-10' }), /endTime/)
  // 调用方传错 dateKey(如 UTC 偏移/跨午夜 startTs 口径)不再抛错也不落错桶——按 endTime 重导
  db.call('tomatoAppendMany', { tomatoId: 'tmt_dk_1', endTime: new Date('2026-09-20T08:00:00').getTime(), dateKey: '1999-01-01' })
  assert.equal(db.call('tomatoAll').find(x => x.tomatoId === 'tmt_dk_1').dateKey, '2026-09-20')
})

test('ledger: update 只传 dateKey 也被 endTime 重导覆盖(幽灵行后门双向封死)', () => {
  db.call('tomatoAppendMany', rec({ tomatoId: 'tmt_u_2', dateKey: '2026-09-10', endTime: new Date('2026-09-10T10:00:00').getTime() }))
  db.call('tomatoUpdateById', { tomatoId: 'tmt_u_2', patch: { dateKey: '1999-01-01' } })
  const r = db.call('tomatoAll').find(x => x.tomatoId === 'tmt_u_2')
  assert.equal(r.dateKey, '2026-09-10', '脱离 endTime 的 dateKey patch 必须被拒绝(重导覆盖)')
})

test('ledger: update 全列覆写不丢 extra 字段', () => {
  db.call('tomatoAppendMany', rec({ tomatoId: 'tmt_e_1', extraField: 'keep-me' }))
  db.call('tomatoUpdateById', { tomatoId: 'tmt_e_1', patch: { focusDuration: 50 } })
  assert.equal(db.call('tomatoAll').find(x => x.tomatoId === 'tmt_e_1').extraField, 'keep-me')
})

test('ledger: 迁移完成后 meta blob 必被删除——删光账本后重启不复活(P0 守卫)', () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'tomato-ledger-resur-'))
  db.init(fresh)
  db.call('setMeta', ['db.tomatoState', JSON.stringify({ tomatoRecordList: [rec({ tomatoId: 'tmt_res_1', dateKey: '2026-09-01' })] })])
  assert.equal(db.call('tomatoMigrateFromMeta'), 1)
  assert.equal(db.call('getMeta', 'db.tomatoState'), null, 'blob 是复活源,迁移完必须删')
  // 用户删光账本(表空)→ 再迁移不得从 blob 复活
  const all = db.call('tomatoAll').map(r => r.tomatoId)
  db.call('tomatoRemoveByIds', all)
  assert.equal(db.call('tomatoAll').length, 0)
  assert.equal(db.call('tomatoMigrateFromMeta'), 0, '表空+无 blob = 无可迁移,不得复活')
  assert.equal(db.call('tomatoAll').length, 0)
})
