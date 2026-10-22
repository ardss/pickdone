/* d2-crosscutting-auditor (round-2 journey audit, 2026-10-22):
 * [D2-GATE] the whole-tree CJK scanner (renderer/js/i18n/check-i18n.mjs) treated HTML template
 * comments in .vue files as user-visible copy: the round-1 J1 fix note inside TomatoBar.vue's
 * <template> (quoting the zh phase words as bug evidence) exited the gate 1 for the whole
 * branch — check:all red for everyone (gate is check-all.js stage 60). The scanner strips JS
 * block/line comments but never <!-- -->. These pins lock the pure helper: comment bodies are
 * not UI copy, real copy outside comments still fires, and an UNTERMINATED <!-- fails loud.
 * Run: node --test tests/unit/cli/d2-i18n-html-comment-strip.test.mjs */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripHtmlComments } from '../../../renderer/js/i18n/html-comment-strip.mjs'

test('D2-GATE: multi-line CJK inside an HTML template comment is stripped (a comment is not UI copy)', () => {
  const src = '<template>\n  <div>ok</div>\n  <!-- J1: the bar showed 待开始 for its whole run\n       while panel/float said 专注中/休息中 -->\n  <span>{{ x }}</span>\n</template>'
  assert.ok(!/[\u4e00-\u9fff]/.test(stripHtmlComments(src)), 'CJK inside the comment is gone')
  assert.match(stripHtmlComments(src), /<span>/, 'real markup survives')
})

test('D2-GATE: hardcoded CJK copy OUTSIDE comments survives the strip (detection preserved)', () => {
  const src = '<template><div>操作成功</div><!-- 注释 --></template>'
  assert.match(stripHtmlComments(src), /操作成功/, 'real copy is untouched so the gate still fires')
})

test('D2-GATE: an UNTERMINATED <!-- is not treated as a comment (fail loud, gate stays red)', () => {
  const src = '<template><div>待开始</div><!-- oops never closed\n  <div>专注中</div></template>'
  assert.match(stripHtmlComments(src), /待开始/, 'unterminated comment leaves CJK visible to the scanner')
})

test('D2-GATE: plain JS source passes through untouched (caller gates the strip on .vue only)', () => {
  const js = "const s = '已添加' // comment 专注中"
  assert.equal(stripHtmlComments(js), js, 'JS strings/comments are the existing scanner state machine\u2019s job')
})
