/**
 * W20 gate fixes (2026-10-30) — detection-side pins for the three gates NOT covered by the
 * gate-must-fail-golden family's GATE_ROOT harness (they derive their root from __dirname, so
 * each fixture copies the gate into a temp tree mirroring the repo layout):
 *   1. check-op-feedback.js  — allowlist keys are scan-surface-relative paths, not basenames
 *     (same-named components/Foo.vue vs views/Foo.vue could vouch for each other).
 *   2. check-fingerprint.js  — brand-name rule catches `Day  Todo` / `DAY TODO` / `Day-Todo`
 *     (separator class + /i) WITHOUT false-hitting camelCase identifiers (todayTodoList).
 *   3. check-ipc-op-coverage.cjs — the purge-channel guard assertion is anchored to the
 *     channel's OWN registration block, so a later handler's assertMainWindow(e) can no longer
 *     satisfy a channel that lost its guard (the old `[^]*?` spanned the whole file).
 * Run: node --test tests/unit/cli/w20-gate-fixes.test.mjs
 */
import { test } from 'node:test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')

function mkTree (prefix) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w20-' + prefix + '-'))
  return tmp
}

// —— 1. check-op-feedback: rel-key allowlists ——

const copyOpFeedbackGate = tmp => {
  fs.mkdirSync(path.join(tmp, 'cli'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'renderer/js/components'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'renderer/js/views'), { recursive: true })
  fs.copyFileSync(path.join(REPO, 'cli/check-op-feedback.js'), path.join(tmp, 'cli/check-op-feedback.js'))
  // W21: the gate now delegates its walker to the shared lib-filescan.cjs — the fixture copy
  // needs the dependency alongside or the gate dies with MODULE_NOT_FOUND
  fs.copyFileSync(path.join(REPO, 'cli/lib-filescan.cjs'), path.join(tmp, 'cli/lib-filescan.cjs'))
}

const runOpFeedback = tmp =>
  spawnSync(process.execPath, [path.join(tmp, 'cli', 'check-op-feedback.js')], { timeout: 180000, encoding: 'utf8' })

test('W20 op-feedback: a same-named file in views/ is NOT excused by an allowlist entry for components/Foo.vue', () => {
  const tmp = mkTree('opf-samename')
  copyOpFeedbackGate(tmp)
  // views/Foo.vue violates R2; only components/Foo.vue is allowlisted (same basename, other dir)
  let gate = fs.readFileSync(path.join(tmp, 'cli/check-op-feedback.js'), 'utf8')
  gate = gate.replace(/const UPDATE_FIELDS_ALLOWLIST = \[[\s\S]*?\]/,
    "const UPDATE_FIELDS_ALLOWLIST = [\n  'components/Foo.vue',\n]")
  fs.writeFileSync(path.join(tmp, 'cli/check-op-feedback.js'), gate)
  fs.writeFileSync(path.join(tmp, 'renderer/js/views/Foo.vue'),
    "<script setup>\nimport { useStore } from 'vuex'\nconst store = useStore()\nstore.dispatch('todo/updateTodoFields', {})\n</script>\n")
  const r = runOpFeedback(tmp)
  assert.equal(r.status, 1, `same-name basename excuse must be gone: ${r.stderr}`)
  assert.match(r.stderr, /views\/Foo\.vue/, 'the violating same-named file must be named in the hit')
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('W20 op-feedback: the correct rel-form entry (views/Foo.vue) keeps its file green', () => {
  const tmp = mkTree('opf-rel-live')
  copyOpFeedbackGate(tmp)
  let gate = fs.readFileSync(path.join(tmp, 'cli/check-op-feedback.js'), 'utf8')
  gate = gate.replace(/const UPDATE_FIELDS_ALLOWLIST = \[[\s\S]*?\]/,
    "const UPDATE_FIELDS_ALLOWLIST = [\n  'views/Foo.vue',\n]")
  fs.writeFileSync(path.join(tmp, 'cli/check-op-feedback.js'), gate)
  fs.writeFileSync(path.join(tmp, 'renderer/js/views/Foo.vue'),
    "<script setup>\nimport { useStore } from 'vuex'\nconst store = useStore()\nstore.dispatch('todo/updateTodoFields', {})\n</script>\n")
  const r = runOpFeedback(tmp)
  assert.equal(r.status, 0, `rel-form allowlist entry must keep the gate green: ${r.stderr}`)
  fs.rmSync(tmp, { recursive: true, force: true })
})

// —— 2. check-fingerprint: brand-name regex ——

const SCAN_DIRS = ['src', 'renderer', 'cli', 'assets/css', 'browser-dev', 'shared']

const runFingerprint = (body) => {
  const tmp = mkTree('fp')
  fs.mkdirSync(path.join(tmp, 'cli'), { recursive: true })
  for (const d of SCAN_DIRS) fs.mkdirSync(path.join(tmp, d), { recursive: true })
  fs.copyFileSync(path.join(REPO, 'cli/check-fingerprint.js'), path.join(tmp, 'cli/check-fingerprint.js'))
  if (body !== null) fs.writeFileSync(path.join(tmp, 'renderer/probe.js'), body + '\n')
  const r = spawnSync(process.execPath, [path.join(tmp, 'cli', 'check-fingerprint.js')], { timeout: 180000, encoding: 'utf8' })
  fs.rmSync(tmp, { recursive: true, force: true })
  return r
}

test('W20 fingerprint: `Day  Todo` / `DAY TODO` / `Day-Todo` brand mentions are red', () => {
  for (const probe of ['const x = "Day  Todo"', 'const x = "DAY TODO"', 'const x = "Day-Todo"', 'const x = "TODO 清单"']) {
    const r = runFingerprint(probe)
    assert.equal(r.status, 1, `must red on ${JSON.stringify(probe)}: ${r.stdout}${r.stderr}`)
    assert.match(r.stderr, /遗留品牌名/)
  }
})

test('W20 fingerprint: camelCase identifiers (todayTodoList / switchToDaytodo) stay green', () => {
  const r = runFingerprint('const todayTodoList = []\nconst switchToDaytodo = 1\n')
  assert.equal(r.status, 0, `camelCase identifiers must not false-hit: ${r.stdout}${r.stderr}`)
})

// —— 3. check-ipc-op-coverage: block-anchored purge-channel guard ——

const runIpcCoverage = (handlersBody) => {
  const tmp = mkTree('ipc')
  fs.mkdirSync(path.join(tmp, 'cli'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'src/main/handlers'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'renderer/js'), { recursive: true })
  fs.copyFileSync(path.join(REPO, 'cli/check-ipc-op-coverage.cjs'), path.join(tmp, 'cli/check-ipc-op-coverage.cjs'))
  fs.writeFileSync(path.join(tmp, 'src/main/handlers/todo.js'), `
const ALLOWED_RENDERER_OPS = new Set([
  'getTodoList',
])
function makeHandlers () {
  return {
${handlersBody}
  }
}
`)
  fs.writeFileSync(path.join(tmp, 'src/main/db.js'), '\nconst OPS = {\n  getTodoList: () => {},\n}\n')
  const r = spawnSync(process.execPath, [path.join(tmp, 'cli', 'check-ipc-op-coverage.cjs')], { timeout: 180000, encoding: 'utf8' })
  fs.rmSync(tmp, { recursive: true, force: true })
  return r
}

test('W20 ipc-coverage: a purge channel without its guard is red EVEN when a later handler carries assertMainWindow(e)', () => {
  // The exact topping shape the old whole-file `[^]*?` regex blessed: purge-recycle-bin lost
  // its guard, but 'other:ch' right after it still has assertMainWindow(e).
  const r = runIpcCoverage(`    'todo-db:call': (e) => {},
    'db:purge-recycle-bin': (e) => {
      noop(e)
    },
    'other:ch': (e) => {
      assertMainWindow(e)
    },
    'db:purge-seed-todos': (e) => {
      assertMainWindow(e)
    }`)
  assert.equal(r.status, 1, `topping across handlers must be blocked: ${r.stdout}${r.stderr}`)
  assert.match(r.stderr, /db:purge-recycle-bin/, 'the unguarded channel must be named')
  assert.match(r.stderr, /缺 assertMainWindow/)
})

test('W20 ipc-coverage: guarded channels stay green', () => {
  const r = runIpcCoverage(`    'db:purge-recycle-bin': (e) => {
      assertMainWindow(e)
    },
    'db:purge-seed-todos': (e) => {
      assertMainWindow(e)
    }`)
  assert.equal(r.status, 0, `guarded channels must pass: ${r.stdout}${r.stderr}`)
})
