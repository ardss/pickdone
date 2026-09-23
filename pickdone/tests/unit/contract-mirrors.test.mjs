/** Mirror-registry contract guards (2026-09-11 audit class h): several hand-maintained "keep in sync"
 *  pairs have already drifted once each — these tests make drift red instead of remembered.
 * Run: node --test tests/contract-mirrors.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ANCHORS, REPO_ROOT, readAnchor } from '../lib/source-anchors.mjs'

test('SETTINGS_MANIFEST: a key must not appear in two type lists (categoryId string/number double-entry regression)', async () => {
  const src = readAnchor('cliLib')
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

/** Recursive source walk shared by the mirror guards (same pattern as cli/check-ipc-op-coverage.cjs). */
function walkSources (dir, acc = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    if (fs.statSync(p).isDirectory()) walkSources(p, acc)
    else if (p.endsWith('.js') || p.endsWith('.vue')) acc.push(p)
  }
  return acc
}

test('browser-dev shim covers every dbCall op literal the renderer invokes', () => {
  const rendererFiles = walkSources(path.join(REPO_ROOT, 'renderer/js'))
  const shim = readAnchor('browserShim')
  let checked = 0
  for (const file of rendererFiles) {
    const src = fs.readFileSync(file, 'utf8')
    for (const m of src.matchAll(/dbCall(?:\?\.)?\(\s*['"]([\w]+)['"]/g)) {
      const op = m[1]
      checked++
      assert.ok(new RegExp(`case\\s+'${op}'`).test(shim), `shim is missing case '${op}' (invoked by ${path.relative(REPO_ROOT, file)}) — web demo would break`)
    }
  }
  // Guard the sweep itself: a full renderer walk must see far more surface than the
  // single anchor file this test used to scan (one file let 25 others drift silently).
  assert.ok(rendererFiles.length >= 20, `sanity: walked ${rendererFiles.length} renderer files, expected the full renderer/js sweep`)
  assert.ok(checked > 0, 'sanity: at least one op literal checked')
})

test('preload exposes no bridge without a main-process sender/handler counterpart (dead-channel class b)', () => {
  const preload = readAnchor('preloadIndex')
  let main = ''
  for (const f of fs.readdirSync(path.join(REPO_ROOT, ANCHORS.mainDir))) {
    if (f.endsWith('.js')) main += fs.readFileSync(path.join(REPO_ROOT, ANCHORS.mainDir, f), 'utf8')
  }
  for (const m of preload.matchAll(/ipcRenderer\.on\(\s*['"]([\w-]+)['"]/g)) {
    const channel = m[1]
    assert.ok(
      main.includes(`'${channel}'`) || main.includes(`"${channel}"`),
      `preload bridges '${channel}' but src/main never references it — dead three-segment contract`
    )
  }
})

test('every preload invoke() channel literal has a main-process handler counterpart (dead-channel class b)', () => {
  const preload = readAnchor('preloadIndex')
  // Handlers live in subdirectories too (src/main/handlers/*, lan-sync/*, core/*), so walk recursively —
  // the .on guard above only needs top-level files, invoke handlers do not.
  let main = ''
  for (const file of walkSources(path.join(REPO_ROOT, ANCHORS.mainDir))) main += fs.readFileSync(file, 'utf8')
  let checked = 0
  for (const m of preload.matchAll(/(?:^|[^.\w])invoke\(\s*['"]([\w:-]+)['"]/g)) {
    const channel = m[1]
    checked++
    assert.ok(
      main.includes(`'${channel}'`) || main.includes(`"${channel}"`),
      `preload invokes '${channel}' but no src/main source registers it — renamed/removed handler, renderer call would reject forever`
    )
  }
  // Guard the sweep itself: preload currently exposes ~59 distinct invoke channels.
  assert.ok(checked >= 40, `sanity: parsed ${checked} invoke channels from preload, expected the full surface`)
})
