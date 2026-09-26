import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Static regression guard for the listfade Vue transition CSS (round3-ux-perf-12).
// History: .listfade-enter-active/.listfade-leave-active used `transition: all`,
// which transitively animates every property that changes while those classes
// are mounted — including `width` on the leaving row (it is absolutely
// positioned with width:100%). The selector now lists properties explicitly so
// only opacity/transform/width tween. These tests parse the stylesheet text
// directly (no app launch) and fail if the explicit list regresses back to
// `all`, if the width tween is dropped (leave would snap), or if the dead
// duplicate .listfade-leave-active rule reappears.

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BASE_CSS = path.resolve(HERE, '../../../assets/css/base.css')

function parseRuleBlocks(cssText) {
  // Minimal block parser: returns [{selector, body}] for top-level rules.
  const blocks = []
  let depth = 0
  let start = 0
  for (let i = 0; i < cssText.length; i++) {
    const ch = cssText[i]
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        const prelude = cssText.slice(0, start)
        const open = prelude.lastIndexOf('}')
        const selector = prelude
          .slice(open + 1, start)
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .trim()
        blocks.push({ selector, body: cssText.slice(start + 1, i) })
      }
    }
  }
  assert.equal(depth, 0, 'base.css must have balanced braces (no CSSOM-swallowing syntax errors)')
  return blocks
}

function findBlocks(blocks, substring) {
  return blocks.filter((b) => b.selector.includes(substring))
}

function parseTransitionProperties(transitionValue) {
  // Split a transition shorthand into per-property segments and extract the
  // animated property name of each (first token, skipping 'none'/'all').
  const segments = []
  let current = ''
  let parenDepth = 0
  for (const ch of transitionValue) {
    if (ch === '(') parenDepth++
    if (ch === ')') parenDepth--
    if (ch === ',' && parenDepth === 0) {
      segments.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  segments.push(current)
  return segments.map((s) => s.trim().split(/\s+/)[0])
}

test('listfade enter/leave transition lists explicit properties, not `all`', () => {
  const css = fs.readFileSync(BASE_CSS, 'utf8')
  const blocks = parseRuleBlocks(css)
  const active = findBlocks(blocks, '.listfade-enter-active')
  assert.ok(active.length >= 1, '.listfade-enter-active rule must exist')
  const decl = active[0].body.match(/transition\s*:\s*([^;]+);/)
  assert.ok(decl, 'transition declaration must be present')
  assert.ok(!/\ball\b/.test(decl[1]), 'transition must not use keyword `all`')
  const props = parseTransitionProperties(decl[1])
  assert.deepEqual(
    [...props].sort(),
    ['opacity', 'transform', 'width'],
    'exactly opacity/transform/width must be animated'
  )
})

test('width tween is kept so the leaving row does not snap (visual preservation)', () => {
  const css = fs.readFileSync(BASE_CSS, 'utf8')
  const blocks = parseRuleBlocks(css)
  const leaveActive = findBlocks(blocks, '.listfade-leave-active')
  // width:100% must still be declared on the leaving row...
  const widthDecl = leaveActive.some((b) => /\bwidth\s*:\s*100%/.test(b.body))
  assert.ok(widthDecl, '.listfade-leave-active must keep width:100% (out-of-flow layout)')
  // ...and width must remain in the transition list so it tweens instead of snapping.
  const active = findBlocks(blocks, '.listfade-enter-active')[0]
  const decl = active.body.match(/transition\s*:\s*([^;]+);/)
  const props = parseTransitionProperties(decl[1])
  assert.ok(props.includes('width'), 'width must stay in the transition list')
})

test('listfade timing curve is preserved exactly', () => {
  const css = fs.readFileSync(BASE_CSS, 'utf8')
  const blocks = parseRuleBlocks(css)
  const active = findBlocks(blocks, '.listfade-enter-active')[0]
  const decl = active.body.match(/transition\s*:\s*([^;]+);/)
  const beziers = decl[1].match(/cubic-bezier\([^)]*\)/g) || []
  assert.ok(beziers.length >= 3, 'each animated property must carry a timing function')
  for (const b of beziers) {
    assert.equal(b, 'cubic-bezier(.2, .8, .2, 1)', 'timing function must stay unchanged')
  }
})

test('no duplicate .listfade-leave-active rules (dead duplicate removed)', () => {
  const css = fs.readFileSync(BASE_CSS, 'utf8')
  const blocks = parseRuleBlocks(css)
  const count = blocks.filter((b) => b.selector.trim() === '.listfade-leave-active').length
  assert.ok(count <= 1, `expected at most one .listfade-leave-active rule, found ${count}`)
})

test('.listfade-move stays transform-only', () => {
  const css = fs.readFileSync(BASE_CSS, 'utf8')
  const blocks = parseRuleBlocks(css)
  const move = findBlocks(blocks, '.listfade-move')
  assert.equal(move.length, 1, 'exactly one .listfade-move rule')
  const decl = move[0].body.match(/transition\s*:\s*([^;]+);/)
  assert.ok(decl, '.listfade-move must have a transition')
  const props = parseTransitionProperties(decl[1])
  assert.deepEqual(props, ['transform'], 'move transition must animate transform only')
})
