import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const repeat = readFileSync(new URL('../../../renderer/js/components/RepeatModal.vue', import.meta.url), 'utf8')
const shared = readFileSync(new URL('../../../assets/css/base.css', import.meta.url), 'utf8')

test('root cause: shared min-content grid can wrap two-character labels into vertical text', () => {
  assert.match(shared, /\.rm-row\s*\{[^}]*grid-template-columns:\s*min-content 1fr/)
})
test('repeat modal only: label column uses intrinsic content width, not min-content', () => {
  assert.match(repeat, /class="modal repeat-rule-modal"/)
  assert.match(repeat, /\.repeat-rule-modal \.rm-row\s*\{\s*grid-template-columns:\s*max-content minmax\(0,\s*1fr\);/)
  assert.match(repeat, /\.repeat-rule-modal \.rm-row > \.rl\s*\{\s*white-space:\s*nowrap;/)
  assert.doesNotMatch(repeat, /<style scoped>/)
})
test('type, interval, count remain distinct inline labels without layout rewrites', () => {
  for (const key of ['type', 'interval', 'count']) {
    assert.ok(repeat.includes('<span class="rl">{{ $t(\'statsD.RepeatModal.' + key + '\') }}</span>'), key)
  }
  assert.match(repeat, /<el-radio-group size="small"/)
  assert.match(repeat, /<el-input-number size="small"/)
})
