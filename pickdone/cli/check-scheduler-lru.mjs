#!/usr/bin/env node
/* eslint-env node */
/**
 * Scheduler fix regression gate — if the P0-app-2 firedReminders LRU fix regresses,
 * the 1001st~2000th fire within one reloadAll would pop duplicate notifications.
 * Prevents anyone from later "simplifying" back to Set.clear() (the original 1000+clear() bug).
 * Run: node cli/check-scheduler-lru.mjs   (mandatory in CI)
 * Exit code: 0 pass / 1 fail
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '..')
const rawSrc = readFileSync(path.join(ROOT, 'src/main/scheduler.js'), 'utf8')
// Strip the _clearStateForTest test helper block (a legitimate clear) to avoid false positives
const helperIdx = rawSrc.indexOf('_clearStateForTest')
let src = rawSrc
if (helperIdx > -1) {
  const startBrace = rawSrc.indexOf('{', helperIdx)
  let depth = 1, end = startBrace + 1
  while (depth > 0 && end < rawSrc.length) {
    if (rawSrc[end] === '{') depth++
    else if (rawSrc[end] === '}') depth--
    end++
  }
  src = rawSrc.substring(0, helperIdx) + rawSrc.substring(end)
}

let fail = 0
function check (name, cond, hint) {
  if (cond) console.log('  \u2713 ' + name)
  else { console.error('  \u2717 ' + name + (hint ? ' -- ' + hint : '')); fail++ }
}

// 1) Must be a Map, not a Set (only a Map can do LRU eviction)
check(
  'firedReminders 用 Map 而非 Set',
  /const firedReminders\s*=\s*new Map\(\)/.test(src),
  'Set 没法按插入顺序 LRU 淘汰,会退化为 clear() 二次弹通知漏洞'
)

// 2) No Set.clear() allowed (the key to LRU is never clearing the whole table)
// After trimming, src should not contain .clear() (except the _clearStateForTest test helper)
const hasFiredClear = /firedReminders\.clear\(\)/.test(src)
check(
  'firedReminders 没有整表 clear（除测试 helper 外）',
  !hasFiredClear,
  'firedReminders.clear() 在生产路径 (非 _clearStateForTest 测试 helper) 会让第 1001 条起的补发二次弹通知,这就是原 1000+clear() 漏洞'
)

// 3) Persisted to meta
check(
  'firedReminders 持久化到 meta',
  /setMeta',\s*\[FIRED_META_KEY/.test(src),
  '防进程崩溃后补发路径二次 fire'
)

// 4) Restored from meta at startup by reloadAll
check(
  'reloadAll 启动时从 meta 恢复 firedReminders',
  /loadFiredFromMeta\(db\)/.test(src),
  '持久化与恢复配对——缺一即失效'
)

if (fail) { console.error('\n\u2717 ' + fail + ' 项门禁失败'); process.exit(1) }
else console.log('\n\u2713 scheduler 修复回归门禁通过')
