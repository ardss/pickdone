/**
 * F5 wave: ProjectDocs cross-project race guard.
 * Behavioral test: load() is extracted from the SFC and executed against a fake
 * `window.todoAPI` whose responses are resolved out of order (project A slower
 * than project B). Asserts the stale response is discarded and that persist()
 * refuses to write docs under a key of a different owning project.
 *
 * Run: node --test tests/unit/components/f5-projectdocs-race.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const sfc = readFileSync(path.join(ROOT, 'renderer/js/components/ProjectDocs.vue'), 'utf8')

const keyOf = catId => 'projectDocs:' + catId

function extractMethod (name, injectedParams) {
  const m = sfc.match(new RegExp(`(?:async )?${name} \\([^)]*\\) \\{[\\s\\S]*?\\n {4}\\},`))
  assert.ok(m, `method ${name} found in ProjectDocs.vue`)
  let src = m[0].replace(/\},\s*$/, '}')
  // turn the method definition into a standalone (async) function expression we can .call() with a fake `this`;
  // injectedParams replaces the (usually empty) SFC param list so module-scope helpers like keyOf and `window`
  // can be provided explicitly in the Node test environment.
  src = src
    .replace(new RegExp(`^async\\s+${name}\\b(\\s*\\([^)]*\\))?`), `async function ${name}(${injectedParams || ''})`)
    .replace(new RegExp(`^${name}\\b(\\s*\\([^)]*\\))?`), `function ${name}(${injectedParams || ''})`)
  // eslint-disable-next-line no-new-func
  return new Function('return (' + src + ')')()
}

function makeCtx () {
  return {
    loadToken: 0,
    catId: 1,
    docs: [],
    activeId: '',
    savedAt: 0,
    writes: [],
    _docsCatId: 1
  }
}

test('f5 ProjectDocs: stale load response from a previous project is discarded (out-of-order mock)', async () => {
  const loadSrc = extractMethod('load', 'window, keyOf')
  const store = { 1: JSON.stringify([{ id: 'a1', title: 'A-doc', updatedAt: 1 }]), 2: JSON.stringify([{ id: 'b1', title: 'B-doc', updatedAt: 2 }]) }
  // Project A (catId 1) resolves AFTER project B (catId 2): classic rapid-switch race
  const fakeWindow = {
    todoAPI: {
      dbCall (kind, key) {
        const cat = Number(key.split(':')[1])
        const delay = cat === 1 ? 30 : 5 // A is slow, B is fast
        return new Promise(resolve => setTimeout(() => resolve(store[cat]), delay))
      }
    }
  }
  const load = loadSrc // extractMethod returns a callable bound-later function
  const ctx = makeCtx()
  ctx.catId = 1
  const p1 = load.call(ctx, fakeWindow, keyOf) // token becomes 1, captures catId 1
  ctx.catId = 2 // rapid project switch
  const p2 = load.call(ctx, fakeWindow, keyOf) // token becomes 2, captures catId 2
  await Promise.all([p1, p2])
  assert.equal(ctx.loadToken, 2)
  assert.equal(ctx.docs.length, 1, 'only one doc set remains')
  assert.equal(ctx.docs[0].id, 'b1', 'docs must belong to the LAST requested project, not the slow stale one')
  assert.equal(ctx._docsCatId, 2, 'docs ownership tracked for persist re-validation')
})

test('f5 ProjectDocs: persist refuses to write docs under another project key (ownership re-check)', async () => {
  const persistSrc = extractMethod('persist', 'window, keyOf, keyOverride')
  const writes = []
  const fakeWindow = { todoAPI: { dbCall (kind, kv) { writes.push(kv); return Promise.resolve() } } }
  const persist = persistSrc
  // docs belong to project 1 (as tracked by _docsCatId) but the component has already
  // switched to project 2, so keyOf(this.catId) points at 2 (debounce leaked across a switch)
  const ctx = makeCtx()
  ctx._docsCatId = 1
  ctx.catId = 2
  await persist.call(ctx, fakeWindow, keyOf)
  assert.equal(writes.length, 0, 'cross-project write must be dropped')
  // matching ownership still writes
  ctx._docsCatId = 2
  await persist.call(ctx, fakeWindow, keyOf)
  assert.equal(writes.length, 1)
  assert.equal(writes[0][0], 'projectDocs:2')
})
