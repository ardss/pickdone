/**
 * 备份 dump 结构守卫（2026-09-05 二轮审查 P0）
 * buildBackupDump 是三处备份(事件/自动/关键)的唯一来源,但它是手写字段清单——新增 store 段忘写进去
 * = 灾备恢复静默丢数据,且此前无任何测试锁住段完整性。本测试用源码结构断言锁死:
 *   1) dump 必含段集合,段名即契约(恢复端/主进程灾备都按这些键消费)
 *   2) 三处备份动作必须全部走 buildBackupDump(不允许再出现手写 dump 拷贝)
 *   3) 渲染端与主进程两套恢复路径必须消费必含段(写入面与消费面对账)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const read = p => fs.readFileSync(path.join(HERE, '../../..', p), 'utf8')

// 恢复端实际消费的段 = 必含段(user/lastLoginRecord 由主进程恢复语义持有,渲染端两套恢复不消费,不列入)
const REQUIRED_SEGMENTS = ['settingsState', 'user', 'lastLoginRecord', 'todoState', 'tomatoState', 'tomatoRecords', 'categoryState', 'habitsState']

// R1 refactor: buildBackupDump 与三处备份动作迁至 store/todoBackup.js（todo.js 只留 action 壳）
const dumpSrc = () => read('renderer/js/store/todoBackup.js')

test('backup dump 单一来源含全部必含段', () => {
  const src = dumpSrc()
  const m = src.match(/function buildBackupDump[\s\S]*?\n\}/)
  assert.ok(m, 'todoBackup.js 必须定义 buildBackupDump(三处备份的唯一来源)')
  const body = m[0]
  for (const seg of REQUIRED_SEGMENTS) {
    assert.ok(body.includes(seg + ':'), `buildBackupDump 缺少段: ${seg}——新增 store 段必须进备份,否则灾备恢复静默丢数据`)
  }
})

test('三处备份动作全部走 buildBackupDump,不允许手写 dump 拷贝', () => {
  const src = dumpSrc()
  for (const action of ['writeEventBackup', 'writeAutoBackup', 'writeCriticalBackup']) {
    assert.ok(src.includes('buildBackupDump(rootState, state'), `${action} 必须调用 buildBackupDump 单一来源`)
  }
  // settingsState 的手写序列化在全文件只允许出现一次(buildBackupDump 内部)
  const n = (src.match(/settingsState:/g) || []).length
  assert.equal(n, 1, `settingsState 序列化出现 ${n} 次(应仅 buildBackupDump 1 次)——备份 dump 又被手写拷贝了`)
})

test('两套恢复路径消费必含段(写入面↔消费面对账)', () => {
  const uiRestore = read('renderer/js/components/SettingsModal.vue')
  for (const seg of ['settingsState', 'categoryState', 'habitsState', 'todoState', 'tomatoRecords']) {
    assert.ok(uiRestore.includes('b.' + seg), `SettingsModal UI 恢复未消费备份段 ${seg}——恢复后该数据会"消失"`)
  }
  const mainRecovery = read('src/main/dbRecovery.cjs')
  for (const seg of ['todoState', 'categoryState', 'tomatoRecords']) {
    assert.ok(mainRecovery.includes(seg), `dbRecovery 启动灾备未消费备份段 ${seg}`)
  }
})
