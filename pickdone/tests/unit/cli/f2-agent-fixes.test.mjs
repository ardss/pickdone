/**
 * F2 agent fix round (2026-10-21):
 *  - P2 tag rename $-injection: rename target `'$&b'` used to be passed as a STRING replacement
 *    (`replace(re, '#' + next)`), so `$&` expanded to the whole match and the corpus was mangled.
 *    Both ends (cli/lib-tags.cjs rewriteTag + renderer SnManageTagsModal.vue renameTag) now use a
 *    FUNCTIONAL replacement `(m) => '#' + next`.
 *  - P2 tag rename legality: a new name containing a TAG terminator char (`.`/`,`/`，`/…) could
 *    never be extracted by TAG_RE again — a ghost tag. Both ends now validate via the shared
 *    shared/tag-name.mjs isValidTagName (CLI: structured CliError TAG_NAME_INVALID; UI: error toast).
 *  - P3 CLI sort midpoint exhaustion: moveWithin halves the adjacent gap on every up/down move,
 *    so ~12 consecutive `sort up` calls silently stopped moving the task. cli/lib.js sortTask now
 *    detects a landing gap < 2 and rewrites the whole pool onto shared reorderScale (same recovery
 *    as the App's TodoItem._writeSort).
 *  - P3 UI delete-tag confirm button: named after the action (source anchor).
 *  - Renderer-side behavior is pinned by SOURCE ANCHORS on SnManageTagsModal.vue (same convention
 *    as tests/unit/renderer/f3-ux-false-success.test.mjs — the modal is not unit-executed).
 * Run: node --test tests/unit/cli/f2-agent-fixes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'module'
import { isolatedTmpDir } from '../../lib/tmp-dir.mjs'

// Extractability oracle — the App-side TAG_RE class verbatim (search.js TAG_RE; renderer's search.js
// transitively pulls window-bound i18n so it cannot be imported in pure Node, same convention as
// d24's inline appRemove oracle).
const ORACLE_TAG_RE = /#([^\s#,，。.!?！？]+)/g
function oracleExtract (text) {
  const set = new Set(); let m; ORACLE_TAG_RE.lastIndex = 0
  while ((m = ORACLE_TAG_RE.exec(String(text)))) set.add(m[1])
  return [...set]
}

delete process.env.TODO_BACKUP_DIR
delete process.env.TODO_USER_DATA_DIR
process.env.TODO_DB_DIR = isolatedTmpDir('todo-cli-f2agent-')
const require_ = createRequire(import.meta.url)
const lib = require_('../../../cli/lib.js')
const { isValidTagName } = require_('../../../shared/tag-name.mjs')
const ROOT = path.resolve(import.meta.dirname, '../../..')

/* ==================== P2: $-pattern injection in the rename replacement ==================== */

test('F2 P2: renaming to a `$`-bearing name is LITERAL on the CLI — no $& expansion, no corpus damage', () => {
  const t = lib.addTodo({ content: 'buy #a now', desc: 'see #a too' })
  const touched = lib.rewriteTag('a', '$&b')
  assert.equal(touched, 1, 'the rename still touches the task')
  const after = lib.open().call('getById', t.taskId)
  assert.equal(after.taskContent, 'buy #$&b now', 'red before the fix: `#$&` expanded to the matched text and mangled the title')
  assert.equal(after.taskDescribe, 'see #$&b too', 'the description is rewritten with the same literal semantics')

  // the new tag is still extractable (no ghost tag) and a second rename round-trips cleanly
  assert.ok(oracleExtract(after.taskContent).includes('$&b'), 'the $-bearing name is extractable')
  lib.rewriteTag('$&b', 'safe')
  assert.equal(lib.open().call('getById', t.taskId).taskContent, 'buy #safe now', 'the $-bearing name renames away cleanly')
})

test('F2 P2: `$1`-style and trailing-`$` names are also literal (full replacement-pattern family)', () => {
  for (const next of ['$1x', "x$'y", 'end$']) {
    const t = lib.addTodo({ content: 'task #q1 body' })
    lib.rewriteTag('q1', next)
    assert.equal(lib.open().call('getById', t.taskId).taskContent, `task #${next} body`, `rename to "${next}" is byte-literal`)
  }
})

/* ==================== P2: rename-target legality (shared source) ==================== */

test('F2 P2: shared isValidTagName mirrors TAG_RE extractability exactly', () => {
  assert.ok(isValidTagName('dairy'))
  assert.ok(isValidTagName('#dairy')) // leading # is tolerated (UIs strip it anyway)
  assert.ok(isValidTagName('$&b'))
  for (const bad of ['foo.', 'foo,bar', 'foo，', 'foo。', 'fo o', 'foo!', 'foo？', 'foo#bar', '']) {
    assert.equal(isValidTagName(bad), false, `"${bad}" must be rejected`)
  }
})

test('F2 P2: CLI rewriteTag rejects a terminator-bearing target with a structured error, corpus untouched', () => {
  const t = lib.addTodo({ content: 'keep #a intact' })
  assert.throws(() => lib.rewriteTag('a', 'ghost.'), e => e.code === 'TAG_NAME_INVALID', 'red before the fix: the ghost name was accepted')
  assert.throws(() => lib.rewriteTag('a', 'ghost,comma'), e => e.code === 'TAG_NAME_INVALID')
  assert.throws(() => lib.rewriteTag('a', ''), e => e.code === 'TAG_NAME_INVALID')
  assert.equal(lib.open().call('getById', t.taskId).taskContent, 'keep #a intact', 'the corpus is NOT rewritten on a rejected rename')
  // a legal name still works after the rejections
  const touched = lib.rewriteTag('a', 'ok-name')
  assert.equal(touched, 1)
})

/* ==================== P3: CLI sort midpoint exhaustion → reorderScale recovery ==================== */

test('F2 P3: a long run of `sort up` moves the task all the way to the top (no silent stall)', () => {
  const mover = lib.addTodo({ content: 'up-stall-MOVER', date: '2099-01-04' }).taskId // created FIRST → oldest → bottom of the pool
  for (let i = 1; i <= 16; i++) lib.addTodo({ content: `up-stall-${String(i).padStart(2, '0')}`, date: '2099-01-04' }) // each add lands on top; dated pool = isolated from the earlier tag tests' no-date rows
  // walk the bottom task up to the top
  let steps = 0; let r = null
  while (steps < 30) {
    r = lib.sortTask(mover, 'up'); steps++
    if (r.dayOrder[0].includes('★')) break
  }
  assert.ok(steps <= 18, `red before the fix: midpoint halving stalled the moves (needed ${steps})`)
  assert.ok(r.dayOrder[0].includes('★'), 'mover reaches the top')
  assert.ok(r.dayOrder[r.dayOrder.length - 1].includes('up-stall-01'), 'the oldest non-mover task stays at the bottom (order preserved)')

  // the pool was rescaled on the exhausted move: adjacent gaps are healthy again (all > threshold)
  const sorts = lib.open().call('queryTodos', { deleted: 0 }).filter(t => (t.taskContent || '').startsWith('up-stall-')).map(t => t.taskSort).sort((a, b) => b - a)
  let minGap = Infinity
  for (let i = 1; i < sorts.length; i++) minGap = Math.min(minGap, Math.abs(sorts[i - 1] - sorts[i]))
  assert.ok(minGap >= 2, `rescale rebuilt healthy gaps (min adjacent gap ${minGap})`)

  // and subsequent moves keep working: the new bottom task climbs without stalling
  const bottom = lib.open().call('queryTodos', { deleted: 0 }).filter(t => (t.taskContent || '').startsWith('up-stall-'))
    .sort((a, b) => (b.taskSort || 0) - (a.taskSort || 0)).pop()
  const r2 = lib.sortTask(bottom.taskId, 'up')
  assert.ok(!r2.dayOrder[r2.dayOrder.length - 1].includes('★'), 'first climb moves the bottom task')
  const r3 = lib.sortTask(bottom.taskId, 'up')
  assert.ok(!r3.dayOrder[r3.dayOrder.length - 1].includes('★'), 'second climb works too (no stall after a rescale)')
})

test('F2 P3: sort down into an exhausted gap also recovers (rescale keeps display order)', () => {
  const ids = []
  for (let i = 1; i <= 10; i++) ids.push(lib.addTodo({ content: `down-move-${String(i).padStart(2, '0')}`, date: '2099-01-05' }).taskId) // dated pool: isolated from the up-stall tasks
  // the NEWEST task (last created) sits on TOP — walk it to the bottom, 9 moves; ids are keyword-ambiguous (-1 vs -10) so use taskIds
  let r
  for (let step = 1; step <= 9; step++) r = lib.sortTask(ids[9], 'down')
  assert.ok(r.dayOrder[r.dayOrder.length - 1].includes('★'), 'mover reaches the bottom without stalling')
  assert.equal(r.dayOrder[0], 'down-move-09', 'the previous task took the top spot (order intact through the rescale)')
})

/* ==================== P3: UI-side source anchors (SnManageTagsModal.vue) ==================== */

test('F2 P3: the modal uses the shared isValidTagName guard, functional replacement and a named confirm button', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer/js/components/side-nav/SnManageTagsModal.vue'), 'utf8')

  // shared validation guard with an explicit error toast
  assert.match(src, /import \{ isValidTagName \} from '(\.\.\/)+shared\/tag-name\.mjs'/, 'the legality check is the SHARED single source, not a private regex')
  const renameIdx = src.indexOf('async renameTag (t)')
  const renameBody = src.slice(renameIdx, src.indexOf('async removeTag', renameIdx))
  assert.match(renameBody, /if \(!isValidTagName\(next\)\) return this\.\$message\.error\(this\.\$t\('statsG\.SideNav\.tagNameInvalid'/, 'illegal names are rejected with a toast BEFORE any rewrite')

  // functional replacement: no string replacement left in the rename path
  assert.match(renameBody, /\.replace\(re, \(\) => '#' \+ next\)/, 'rename uses a FUNCTIONAL replacement')
  assert.doesNotMatch(renameBody, /\.replace\(re, '#' \+ next\)/, 'red before the fix: the string replacement expands $-patterns')

  // destructive confirm names its button after the action
  assert.match(src, /confirmButtonText: this\.\$t\('statsG\.SideNav\.tagDeleteConfirmBtn'\)/, 'the delete-tag confirm button is named after the action')
})

test('F2 P3: the CLI rewrite path has no string replacement left either (source anchor)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'cli/lib-tags.cjs'), 'utf8')
  assert.match(src, /\.replace\(re, \(\) => '#' \+ target\)/g)
  assert.doesNotMatch(src, /\.replace\(re, '#' \+ next\)/)
  assert.match(src, /isValidTagName/, 'the CLI validates via the same shared module')
})
