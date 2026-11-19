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

// U02 (2026-11-19 takeover): the deck/rail copies of the same pomodoro control were NOT centered —
// inline-flex stretched the box, so the 14px icon sat off-centre inside its highlight, and the deck's
// overdue rows never received the active class at all (selected state was invisible).
test('deck and rail tomato controls are square and centered', () => {
  const deck = read('renderer/js/components/DayDeck.vue')
  const rail = read('renderer/js/components/DayRail.vue')
  for (const [css, sel] of [[deck, '.pd-day-deck__tomato'], [rail, '.day-rail .dr-plan-tom']]) {
    const box = styleBlock(css, sel)
    assert.match(box, /align-items:\s*center/, sel + ' must center the icon vertically')
    assert.match(box, /justify-content:\s*center/, sel + ' must center the icon horizontally')
    assert.match(box, /padding:\s*0/, sel + ' must not pad the icon off-centre')
    assert.match(box, /width:\s*\d+px/, sel + ' needs an explicit square box')
    assert.match(box, /height:\s*\d+px/, sel + ' needs an explicit square box')
    assert.match(box, /flex-shrink:\s*0/, sel + ' must not be squeezed by long titles')
  }
  // every deck tomato button (normal list AND overdue block) must carry the active class
  const tomatoButtons = deck.match(/<button class="pd-day-deck__tomato"[\s\S]{0,400}?>/g) || []
  assert.ok(tomatoButtons.length >= 2, 'expected both deck tomate buttons')
  for (const btn of tomatoButtons) {
    assert.match(btn, /'pd-is-active':\s*\$store\.state\.tomato\.attachTodo/, 'deck tomato button missing active state: ' + btn.slice(0, 80))
  }
})

// U03 (2026-11-19 takeover): once a focus session starts, the TodayX card swaps its primary button to
// "give up", which was painted 18% black over the green gradient — visibly still green.
test('today-focus give-up button is red, not a translucent overlay on the green card', () => {
  const view = read('renderer/js/views/TodayXView.vue')
  const give = styleBlock(view, '.tx-giveup')
  assert.match(give, /background:\s*var\(--danger-strong/)
  assert.ok(!/background:\s*rgba\(0,0,0/.test(give), 'give-up must not be a black overlay on the green card')
})
