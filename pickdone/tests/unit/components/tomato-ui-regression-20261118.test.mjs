import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8')
const todoItem = read('renderer/js/components/TodoItem.vue')
const onboarding = read('renderer/js/components/Onboarding.vue')
const bar = read('renderer/js/components/TomatoBar.vue')
const styleBlock = (css, selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rule = css.match(new RegExp('(?:^|\\n)' + escaped + '\\s*\\{([^}]+)\\}', 'm'))
  assert.ok(rule, 'Missing CSS rule: ' + selector)
  return rule[1]
}

test('row tomato icon remains centered both with and without a ledger count', () => {
  assert.doesNotMatch(onboarding, /\.td-tom__start\s*\{/)
  const icon = styleBlock(todoItem, '.td-right .td-tom__start')
  assert.match(icon, /justify-content:\s*center/)
  assert.match(icon, /align-items:\s*center/)
  assert.match(icon, /padding:\s*0/)
  assert.match(icon, /width:\s*28px/)
  assert.match(styleBlock(todoItem, '.td-right .td-tom'), /align-items:\s*center/)
  assert.match(styleBlock(todoItem, '.td-right .td-tom__count'), /align-items:\s*center/)
  assert.match(todoItem, /:aria-pressed="\$store\.state\.tomato\.attachTodo/)
})

test('pomodoro focus is visibly red, idle remains brand green, break remains orange', () => {
  assert.match(bar, /'tomato-timer__play--work': isWork/)
  assert.match(styleBlock(bar, '.tomato-timer__play--work'), /background-color:\s*var\(--danger-strong\)/)
  assert.match(styleBlock(bar, '.tomato-timer--work'), /background-color:\s*var\(--danger-soft\)/)
  assert.match(bar, /\.tomato-timer__play\s*\{[^}]*background-color:\s*#0c8172/s)
  assert.match(styleBlock(bar, '.tomato-timer__play--rest'), /background-color:\s*#fe9933/)
  assert.match(bar, /isWork \? 'var\(--danger-strong\)'/)
})