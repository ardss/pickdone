/** Mirror-registry contract guards (2026-09-11 audit class h): several hand-maintained "keep in sync"
 *  pairs have already drifted once each — these tests make drift red instead of remembered.
 * Run: node --test tests/contract-mirrors.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const here = import.meta.dirname

test('SETTINGS_MANIFEST: a key must not appear in two type lists (categoryId string/number double-entry regression)', async () => {
  const src = fs.readFileSync(path.join(here, '../cli/lib.js'), 'utf8')
  // Pull the manifest object literal out of lib.js without executing the CLI
  const m = src.match(/const SETTINGS_MANIFEST = \{[\s\S]*?\n\}/)
  assert.ok(m, 'SETTINGS_MANIFEST found in cli/lib.js')
  const seen = new Map()
  const TYPE_LISTS = ['boolean', 'number', 'string']
  for (const list of m[0].matchAll(/(\w+): \[([^\]]*)\]/g)) {
    const type = list[1]
    if (!TYPE_LISTS.includes(type)) continue // other arrays hold enum values, not setting names
    for (const key of list[2].matchAll(/'([A-Za-z0-9_]+)'/g)) {
      const k = key[1]
      assert.ok(!seen.has(k), `settings key "${k}" declared in both ${seen.get(k)} and ${type}`)
      seen.set(k, type)
    }
  }
  assert.ok(seen.has('todoBoxCategoryId'), 'sanity: manifest parsed non-empty')
})

test('browser-dev shim covers every dbCall op literal the renderer invokes', () => {
  const rendererFiles = ['renderer/js/components/Onboarding.vue']
  const shim = fs.readFileSync(path.join(here, '../browser-dev/todo-browser-shim.js'), 'utf8')
  let checked = 0
  for (const rel of rendererFiles) {
    const src = fs.readFileSync(path.join(here, '../', rel), 'utf8')
    for (const m of src.matchAll(/dbCall\(\s*['"]([\w]+)['"]/g)) {
      const op = m[1]
      checked++
      assert.ok(new RegExp(`case\\s+'${op}'`).test(shim), `shim is missing case '${op}' (invoked by ${rel}) — web demo would break`)
    }
  }
  assert.ok(checked > 0, 'sanity: at least one op literal checked')
})

test('preload exposes no bridge without a main-process sender/handler counterpart (dead-channel class b)', () => {
  const preload = fs.readFileSync(path.join(here, '../src/preload/index.js'), 'utf8')
  let main = ''
  for (const f of fs.readdirSync(path.join(here, '../src/main'))) {
    if (f.endsWith('.js')) main += fs.readFileSync(path.join(here, '../src/main', f), 'utf8')
  }
  for (const m of preload.matchAll(/ipcRenderer\.on\(\s*['"]([\w-]+)['"]/g)) {
    const channel = m[1]
    assert.ok(
      main.includes(`'${channel}'`) || main.includes(`"${channel}"`),
      `preload bridges '${channel}' but src/main never references it — dead three-segment contract`
    )
  }
})
