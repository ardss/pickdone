/**
 * CLI 设置清单与渲染端 DEFAULT_SETTINGS 的静态 parity 门禁(2026-09-05 终审 P2):
 * 新增设置键若只加渲染端,CLI `settings set` 会报 UNKNOWN——静态比对防漂移。
 * 两端结构不同(清单按类型分桶/默认值是扁平对象),只比 key 名集合。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ANCHORS, REPO_ROOT } from '../../lib/source-anchors.mjs'

const read = p => fs.readFileSync(path.join(REPO_ROOT, p), 'utf8')

function manifestKeys () {
  const src = read(ANCHORS.cliLib)
  const m = src.match(/const SETTINGS_MANIFEST = \{[\s\S]*?\n\}/)
  assert.ok(m, 'SETTINGS_MANIFEST 必须存在于 cli/lib.js')
  const keys = new Set()
  for (const arr of m[0].matchAll(/\b(?:boolean|number|string): \[([^\]]*)\]/g)) {
    for (const k of arr[1].matchAll(/'([^']+)'/g)) keys.add(k[1])
  }
  for (const line of m[0].matchAll(/^ {4}(\w+): \[/gm)) keys.add(line[1]) // enum 的 key
  return keys
}

function defaultKeys () {
  const src = read(ANCHORS.settingsStore)
  const m = src.match(/export const DEFAULT_SETTINGS = \{[\s\S]*?\n\}/)
  assert.ok(m, 'DEFAULT_SETTINGS 必须存在于 renderer/js/store/settings.js')
  const keys = new Set()
  for (const line of m[0].split('\n')) {
    const k = line.match(/^ {2}(\w+):/)
    if (k) keys.add(k[1])
  }
  return keys
}

test('CLI settings manifest keys 全部存在于渲染端 DEFAULT_SETTINGS', () => {
  const manifest = manifestKeys()
  const defaults = defaultKeys()
  const missing = [...manifest].filter(k => !defaults.has(k))
  assert.deepEqual(missing, [], '清单里有而 DEFAULT_SETTINGS 没有(漂移)的键')
})

test('DEFAULT_SETTINGS 的可写设置键(非派生/非受保护)都进了 CLI 清单', () => {
  const manifest = manifestKeys()
  const defaults = defaultKeys()
  // 豁免:foldedTodoList=分组折叠态(存储结构);securityLockPassword=受保护键(SETTINGS_DENIED);
  // _lsAt=内部时间戳。三者刻意不可经 CLI 设置
  // 豁免追加(2026-09-20 sync-coverage-2,Y 组):以下为渲染端同步载体字段——由 renderer 经
  // settings_rows 桥字段级同步/热应用,不属于 CLI `settings set` 语义,刻意不进清单:
  // shortcutKeySettings(经 config.json+applyShortcuts)/
  // repeatDefaultSettings(repeatSettings store 载体)/onboardingToursSeen(merge-max 账本);
  // showTagPanel 为纯 UI 折叠态。
  // 豁免追加(2026-09-22 maint-d7):tomatoTimeDefault/restTimeDefault 是渲染端 load() 迁移用的
  // LEGACY 键(真实键 tomatoTime/restTime 已进 CLI 清单)——旧键名刻意不再暴露给 `settings set`。
  // (appLocale/sidebarCollapsed/catFold 原在此豁免,2026-09-22 起进入清单,移出豁免表。)
  const EXEMPT = new Set(['foldedTodoList', 'securityLockPassword', '_lsAt', 'shortcutKeySettings', 'repeatDefaultSettings', 'onboardingToursSeen', 'showTagPanel', 'tomatoTimeDefault', 'restTimeDefault'])
  const missing = [...defaults].filter(k => !manifest.has(k) && !EXEMPT.has(k))
  assert.deepEqual(missing, [], 'DEFAULT_SETTINGS 里有而 CLI 清单漏登记的键(用户将无法 settings set)')
})
