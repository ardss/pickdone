/* UX 2026-10-21 (user-reported P1): overdue tasks from many past days pushed TODAY's own tasks
 * below every overdue group — bottom-scrolling to reach them. Fix (user-approved):
 *   1. TodayView renders the today group FIRST, overdue groups after it (completed stays last);
 *   2. overdue groups carry defaultFold:true — TodoGroups collapses them by default with a
 *      SESSION-LOCAL toggle (persisted foldedTodoList machinery untouched for other groups).
 * Run: node --test tests/unit/components/today-first-overdue-fold.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

const TV = read('renderer/js/views/TodayView.vue')
const TG = read('renderer/js/components/TodoGroups.vue')

test('TodayView: the today-today group is pushed BEFORE the expired groups loop', () => {
  const todayPush = TV.indexOf("g.push({ key: 'today-today'")
  const expiredLoop = TV.indexOf('for (const k of expiredDays)')
  assert.ok(todayPush > 0 && expiredLoop > 0, 'both anchors exist')
  assert.ok(todayPush < expiredLoop, 'today group is built before the overdue groups (user-approved order)')
  assert.ok(todayPush < TV.indexOf("key: 'expired-' + k"), 'and before any expired group object literal')
})

test('TodayView: overdue groups carry defaultFold:true; completed stays last', () => {
  assert.match(TV, /key: 'expired-' \+ k, label: lbl, todos, count: todos\.length, defaultFold: true/)
  const donePush = TV.indexOf("key: 'today-done'")
  const todayPush = TV.indexOf("key: 'today-today'")
  const expiredPush = TV.indexOf("key: 'expired-' + k")
  assert.ok(todayPush < expiredPush && expiredPush < donePush, 'order: today < overdue < completed')
})

test('TodoGroups: defaultFold groups are session-fold collapsed, persisted machinery untouched', () => {
  // data() carries the session-local toggle map
  assert.match(TG, /sessionFold: \{\}/)
  // isOpen: defaultFold -> session map (default false = collapsed); others keep persisted semantics
  const isOpenBody = TG.match(/isOpen \(key, g\) \{([\s\S]*?)\n {4}\},/)[1]
  assert.match(isOpenBody, /if \(g && g\.defaultFold\) return this\.sessionFold\[key\] === true/)
  assert.match(isOpenBody, /return !this\.folded\.includes\(key\)/)
  // toggle: defaultFold flips the session map and returns BEFORE the settings commit
  const toggleIdx = TG.indexOf('toggle (key, g) {')
  const commitIdx = TG.indexOf("this.$store.commit('settings/updateSettings'")
  assert.ok(toggleIdx >= 0 && commitIdx > toggleIdx)
  const earlyReturn = TG.slice(toggleIdx, commitIdx)
  assert.match(earlyReturn, /if \(g && g\.defaultFold\) \{ this\.sessionFold\[key\] = !this\.sessionFold\[key\]; return \}/,
    'defaultFold groups never write foldedTodoList')
})

test('TodoGroups: template routes every isOpen/toggle site through the group object', () => {
  assert.ok(!/isOpen\(g\.key\)[^,]/.test(TG), 'no leftover single-arg isOpen template calls')
  assert.match(TG, /isOpen\(g\.key, g\)/)
  assert.match(TG, /toggle\(g\.key, g\)/)
  assert.match(TG, /onHeadKey\(g, \$event\)/)
  assert.match(TG, /onHeadKey \(g, e\) \{ roleButtonActivate\(\(\) => \{ this\.toggle\(g\.key, g\) \}\)\.call\(this, e\) \}/)
})
