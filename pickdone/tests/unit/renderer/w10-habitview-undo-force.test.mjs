/**
 * W10 renderer fixes (2026-10-26) — HabitView undo-after-delete regression.
 *
 * Covered:
 *   W10-1 HabitView.vue `delHabitWithUndo` / `delMomentWithUndo` snapshotted the habits blob
 *         with `savedAt: Date.now()` BEFORE the delete commit, but the delete's persist()
 *         re-stamps state.savedAt afterwards — so `habits/replaceAll`'s LWW guard
 *         (`blob.savedAt < s.savedAt → return`) made the Undo toast a silent no-op. The
 *         snapshots now carry `force: true` (replaceAll's restore-backup override, which it
 *         strips before persisting — never reaches LS/DB/sync). Source contract pins the
 *         force flag on both snapshot builders; behavior test proves the store's force path
 *         applies an OLDER-savedAt blob and strips `force` from the persisted copy.
 *
 * Run: node --test tests/unit/renderer/w10-habitview-undo-force.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const HABIT_VIEW = readFileSync(path.join(ROOT, 'renderer/js/views/HabitView.vue'), 'utf8')

/* Extract a method body from the .vue <script> by name, e.g. "delHabitWithUndo (h) { ... }" */
const fnSource = (src, name) => {
  const start = src.indexOf(name + ' (')
  assert.ok(start >= 0, `${name} (…) must exist in the component source`)
  const open = src.indexOf('{', start)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open + 1, i) }
  }
  assert.fail(`${name} body not balanced`)
}

/* Stand up the store-module globals the same way tests/unit/store/g1-habits-streak-relay does */
const LS = {}
globalThis.localStorage = {
  getItem: k => (k in LS ? LS[k] : null),
  setItem: (k, v) => { LS[k] = String(v) },
  removeItem: k => { delete LS[k] }
}
globalThis.window = {
  location: { hash: '' },
  dayjs: globalThis.window.dayjs
  // no todoAPI.dbCall: persist() takes its silent no-DB branch in this environment
}
const mod = await import('../../../renderer/js/store/habits.js')
const habits = mod.default

test('W10-1 contract: both undo snapshot builders stamp force:true (LWW override)', () => {
  for (const name of ['delHabitWithUndo', 'delMomentWithUndo']) {
    const body = fnSource(HABIT_VIEW, name)
    assert.match(body, /savedAt:\s*Date\.now\(\)/, `${name} snapshot still stamps savedAt`)
    assert.match(body, /force:\s*true/,
      `${name} snapshot must carry force:true — without it the delete's persist() re-stamp makes the restore blob older than state and replaceAll's LWW guard silently drops it`)
  }
  // the Undo click still routes through habits/replaceAll with the snapshot
  const undoBody = fnSource(HABIT_VIEW, 'undoToastFor')
  assert.match(undoBody, /habits\/replaceAll/, 'undo click commits habits/replaceAll with the snapshot')
})

test('W10-1 behavior: replaceAll rejects an OLDER savedAt without force (the silent-no-op path)', () => {
  const state = { habits: [{ id: 'after-delete', records: {} }], moments: [], savedAt: 500 }
  // undo-shaped snapshot whose savedAt predates the post-delete state stamp (no force) — rejected
  habits.mutations.replaceAll(state, { habits: [{ id: 'pre-delete', records: {} }], moments: [], savedAt: 100 })
  assert.equal(state.habits[0].id, 'after-delete', 'an older savedAt blob is dropped by the LWW guard — exactly the bug the Undo button hit')
})

test('W10-1 behavior: force:true applies an OLDER savedAt blob and strips force from the persisted copy', () => {
  const state = { habits: [{ id: 'after-delete', records: {} }], moments: [], savedAt: 500 }
  habits.mutations.replaceAll(state, {
    schemaV: 1, habits: [{ id: 'pre-delete', records: {} }], moments: [{ id: 'm1' }], savedAt: 100, force: true
  })
  assert.equal(state.habits[0].id, 'pre-delete', 'force restore overrides the LWW guard — Undo actually restores')
  assert.equal(state.moments[0].id, 'm1', 'moments restore with the blob too')
  const persisted = JSON.parse(LS.habitsState)
  assert.equal(persisted.force, undefined, 'force is an internal control flag — never persisted to LS (same discipline as the restore-backup path)')
  assert.equal(persisted.habits[0].id, 'pre-delete', 'the restored blob reached LS')
})
