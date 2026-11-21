/* pd20 P1-01 — ProjectView work-handoff section: source contracts (same harness doctrine as
 * projectview-scroll.test.mjs — the renderer views are asserted via their SFC source, no mount).
 * User-visible behavior pinned:
 *   (a) ProjectView mounts the section as a component (same-source overview, NOT a new page
 *       and NOT an agent console);
 *   (b) ProjectHandoff reads ONLY the read-only op (queryEpisodesByCategory) — no write ops;
 *   (c) the 'tasks with episodes only' filter defaults ON and filters renderer-side;
 *   (d) an empty nextAction renders the i18n 'no record' placeholder — the component never
 *       fabricates status (no "AI done"-style labels anywhere in the section);
 *   (e) a task-row click opens the EXISTING EditPanel through ui/openEdit, and stays inert
 *       when the task is not in the live store list;
 *   (f) styles are scoped (css-freeze discipline: no new global CSS).
 * Run: node --test tests/unit/components/projectview-handoff.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = (() => {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i++) {
    try { readFileSync(join(dir, 'package.json')); return dir } catch { dir = join(dir, '..') }
  }
  throw new Error('repo root not found')
})()

const viewSrc = readFileSync(join(ROOT, 'renderer/js/views/ProjectView.vue'), 'utf8')
const compSrc = readFileSync(join(ROOT, 'renderer/js/components/ProjectHandoff.vue'), 'utf8')

test('ProjectView mounts the handoff section as a same-source component inside the overview body', () => {
  assert.match(viewSrc, /import ProjectHandoff from '\.\.\/components\/ProjectHandoff\.vue'/, 'component imported')
  assert.match(viewSrc, /components: \{[^}]*ProjectHandoff[^}]*\}/, 'component registered')
  // inside the overview proj-body branch, before the todo groups (not a new page/route)
  const overview = viewSrc.indexOf('v-else class="proj-body"')
  const mount = viewSrc.indexOf('<project-handoff v-if="settings.developerMode === true && (settings.workEpisode || {}).enabled" :cat-id="projectId"/>')
  assert.ok(mount > overview, 'section mounts in the overview body only with explicit preview')
  assert.ok(!/ProjectHandoff/.test(viewSrc.match(/<template>[\s\S]*?<\/template>/)[0].split('proj-tabs')[0]), 'not hoisted above the tabs (overview-tab-only surface)')
})

test('ProjectHandoff reads only the read-only op; failure degrades to the empty state', () => {
  assert.match(compSrc, /dbCall\('queryEpisodesByCategory', this\.catId\)/, 'one read op per refresh')
  for (const writeOp of ['episodePut', 'episodeRemoveIds', 'sourcePut', 'taskSourcePut', 'setMeta']) {
    assert.ok(!compSrc.includes("'" + writeOp + "'"), 'no write op in the section: ' + writeOp)
  }
  assert.match(compSrc, /catch \{[\s\S]*?this\.tasks = \[\]/s, 'read failure degrades to the empty state')
})

test('filter defaults ON and lives in the component (renderer-side, never in the op)', () => {
  assert.match(compSrc, /episodesOnly: true/, "'tasks with episodes only' default on")
  assert.match(compSrc, /this\.episodesOnly \? this\.tasks\.filter\(r => r\.episodeCount > 0\) : this\.tasks/, 'filter applies to the fetched rows')
})

test('no fabricated status: empty nextAction renders the no-record placeholder; no AI-done labels', () => {
  assert.match(compSrc, /r\.lastNextAction \|\| \$t\('statsJ\.ProjectView\.handoffNoRecord'\)/, 'placeholder comes from i18n')
  assert.ok(!/AI done|已完成|自动完成/.test(compSrc), 'the section never fabricates completion/status labels')
})

test('task-row click opens the existing EditPanel via ui/openEdit; unknown task stays inert', () => {
  // pd20 P1 multi-view: the open path moved to utils/projectOpenTask.js (shared with the
  // board/timeline views) — the component must delegate, and the util keeps the SAME door
  // (ui/openEdit) with the inert-click guard and the todo/init cache-miss retry.
  assert.match(compSrc, /openProjectTask\(this\.\$store, this\.catId, r\.taskId\)/, 'component delegates to the shared project open path')
  const utilSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'renderer', 'js', 'utils', 'projectOpenTask.js'), 'utf8')
  assert.match(utilSrc, /commit\('ui\/openEdit', raw\)/, 'same door as the list views')
  assert.match(utilSrc, /if \(raw\) store\.commit\('ui\/openEdit'/, 'guard: no raw todo → inert click')
  assert.match(utilSrc, /dispatch\('todo\/init'\)/, 'cache-miss retry rides the canonical store refresh')
})

test('styles stay in the SFC block (never scoped — global cascade contract), unique proj-ho prefix', () => {
  // structure.test.mjs forbids <style scoped>; the sanctioned outlet for component styles is the
  // component's own <style> block, so the contract here is: unscoped + collision-free prefix.
  assert.ok(!/<style[^>]*\sscoped/.test(compSrc), 'component style block must NOT be scoped')
  assert.match(compSrc, /<style>/, 'component carries its own style block')
  for (const m of compSrc.matchAll(/\.proj-ho[a-z_-]*/g)) {
    assert.ok(!new RegExp('\\.' + m[0].slice(1) + '\\b').test(viewSrc.replace(/<project-handoff[^>]*\/>/, '')), 'class defined in the component only: ' + m[0])
  }
  const viewStyles = viewSrc.match(/<style[^>]*>[\s\S]*?<\/style>/g) || []
  for (const block of viewStyles) assert.ok(!/proj-ho-row|proj-ho-recent/.test(block), 'no handoff row rules leaked into ProjectView global styles')
})
