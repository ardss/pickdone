/**
 * W24 P3 — sanitizeRepeatDefaults 放行 null 的回归。
 *
 * 根因:同步 blob 带 {someKey: null} 时 null 直接入座 state,永久越过 defaults 兜底
 * (消费方读到 null 而不是 e.g. repeatWeekDays [1,2,3,4,5])。
 *
 * 修法:与 settings-schema.js sanitizeSettingsPatch 的 B3 null-tombstone 契约对齐 —
 * 显式 null = 键被对端删除,回落到声明的默认值(对象/数组默认克隆)。
 *
 * Run: node --test tests/unit/store/w24-repeat-null-tombstone.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
let seq = 0
const importMod = () => import(pathToFileURL(path.join(ROOT, 'renderer/js/store/repeatSettings.js')).href + '?w24rep=' + (++seq))

test('sanitize: null 键回落到声明的默认值(数组默认克隆,不共享引用)', async () => {
  const { sanitizeRepeatDefaults, REPEAT_DEFAULT_SETTINGS } = await importMod()
  const out = sanitizeRepeatDefaults({ repeatType: null, repeatWeekDays: null, repeatInterval: 3 })
  assert.equal(out.repeatType, REPEAT_DEFAULT_SETTINGS.repeatType, 'null repeatType → default enum')
  assert.deepEqual(out.repeatWeekDays, REPEAT_DEFAULT_SETTINGS.repeatWeekDays, 'null repeatWeekDays → default days')
  assert.notEqual(out.repeatWeekDays, REPEAT_DEFAULT_SETTINGS.repeatWeekDays, 'array default is CLONED (live-state mutation can never corrupt the module default)')
  assert.equal(out.repeatInterval, 3, 'a normal value passes through untouched')
})

test('sanitize: 全 null blob → 输出全部回落默认(等价于键缺席)', async () => {
  const { sanitizeRepeatDefaults, REPEAT_DEFAULT_SETTINGS } = await importMod()
  const blob = {}
  for (const k of Object.keys(REPEAT_DEFAULT_SETTINGS)) blob[k] = null
  const out = sanitizeRepeatDefaults(blob)
  for (const k of Object.keys(REPEAT_DEFAULT_SETTINGS)) {
    assert.deepEqual(out[k], REPEAT_DEFAULT_SETTINGS[k], `${k} resets to its declared default`)
  }
})

test('sanitize: 既有白名单语义不回归(未知键丢、undefined 丢、正常 blob 原样)', async () => {
  const { sanitizeRepeatDefaults } = await importMod()
  assert.deepEqual(sanitizeRepeatDefaults({ evilJunk: 1, schemaV: 9, repeatType: 'week' }), { repeatType: 'week' })
  assert.deepEqual(sanitizeRepeatDefaults({ repeatType: undefined, repeatInterval: 2 }), { repeatInterval: 2 })
  const good = { repeatType: 'month', repeatMonthDays: [1, 15], skipWeekends: true }
  assert.deepEqual(sanitizeRepeatDefaults(good), good)
  assert.deepEqual(sanitizeRepeatDefaults(null), {})
  assert.deepEqual(sanitizeRepeatDefaults('junk'), {})
  assert.deepEqual(sanitizeRepeatDefaults([1, 2]), {})
})

test('updateFromBlob: null 键把已座state 的用户值重置回默认(而非让 null 入座)', async () => {
  const mod = await importMod()
  const state = mod.default.state()
  state.repeatWeekCount = 10 // user value currently seated
  mod.default.mutations.updateFromBlob(state, { repeatWeekCount: null })
  assert.equal(state.repeatWeekCount, 52, 'null tombstone resets to the declared default (REPEAT_DEFAULTS.repeatWeekCount)')
  assert.equal(state.repeatWeekCount !== null, true, 'null never seats in live state')
})
