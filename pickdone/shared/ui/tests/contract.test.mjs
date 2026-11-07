import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse, compileScript } from '@vue/compiler-sfc'
const components = ['PdActionButton', 'PdCard', 'PdStatusChip', 'PdEmptyState', 'PdTaskCard', 'PdProjectCard', 'PdWorkEpisodeCard']
for (const name of components) {
  test(`${name} is a host-independent Vue SFC`, () => {
    const source = readFileSync(new URL(`../components/${name}.vue`, import.meta.url), 'utf8')
    const parsed = parse(source, { filename: name + '.vue' })
    assert.deepEqual(parsed.errors, [])
    assert.doesNotThrow(() => compileScript(parsed.descriptor, { id: name }))
    assert.match(source, /<slot/)
    assert.doesNotMatch(source, /window\.|todoAPI|electron|indexedDB|sqlite|node:/i)
  })
}
test('semantic tokens include desktop brand and both themes', () => {
  const tokens = readFileSync(new URL('../tokens.css', import.meta.url), 'utf8')
  assert.match(tokens, /--pd-brand: #0f9d8f/)
  assert.match(tokens, /--pd-brand-soft: #b5ded9/)
  assert.match(tokens, /:root\[data-theme="dark"\]/)
  for (const name of ['text', 'background', 'surface', 'border', 'success', 'warning', 'danger', 'font', 'radius-md', 'space-4']) assert.match(tokens, new RegExp(`--pd-${name}:`))
})