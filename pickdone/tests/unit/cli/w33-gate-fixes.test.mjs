/* W33 (2026-11-03) — anchor tests for the F3 gate-maintenance lane.
 *
 * Covers:
 *   #1 src/main/command-manifest.js — setMetaMany (the last WRITE_OPS entry without a manifest
 *      row) now has an internal meta.putMany command: via the bus its commitOp used to throw
 *      USAGE while the direct db.call path was silent (two outcomes for one write path).
 *   #2 cli/check-esm-graph.cjs — dynamic imports nested in function/arrow bodies
 *      (defineAsyncComponent(() => import(...)), .then chains, awaited imports) now produce
 *      real graph edges: a nested dynamic import of a MISSING target must be RED, of a real
 *      target GREEN.
 *   #3 cli/check-esm-graph.cjs — dynamic BARE names are no longer unconditionally exempt:
 *      an unresolvable bare name (no alias, no node_modules entry) must be RED; 'vue' (alias)
 *      and a real node_modules package stay GREEN.
 *   #4 cli/check-ipc-op-coverage.cjs — the db.js OPS key-extraction regex uses the same
 *      identifier class as OP_ID ([A-Za-z_][A-Za-z0-9_]*): a digit-carrying OPS key must be
 *      captured whole (PATTERNS export).
 * Run: node --test tests/unit/cli/w33-gate-fixes.test.mjs
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require_ = createRequire(import.meta.url)
const CLI = path.join(import.meta.dirname, '../../../cli')
const ROOT = path.join(import.meta.dirname, '../../..')
const madeDirs = []

const GIT_SAFE_ENV = (() => {
  const e = { ...process.env }
  for (const k of Object.keys(e)) { if (/^GIT_/i.test(k)) delete e[k] }
  return e
})()

function mkFixture (tag) {
  const root = fs.mkdtempSync(path.join(ROOT, '.tmp-w33-' + tag + '-'))
  madeDirs.push(root)
  return root
}

afterEach(() => {
  for (const d of madeDirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* next run cleans via .tmp-* */ } }
})

/** Minimal renderer tree the esm-graph gate can walk from its entry */
function esmFixture (root, extraFiles) {
  fs.mkdirSync(path.join(root, 'renderer/js/utils'), { recursive: true })
  fs.writeFileSync(path.join(root, 'renderer/js/main.js'),
    "import { helper } from './utils/host.js'\nexport default helper\n")
  // host.js is statically reachable from the entry (the dynamic-import scan runs per visited
  // file — unreachable modules only get the parse backstop, same as the real tree). Tests
  // override host.js via extraFiles with the dynamic import under test; it must keep the
  // `helper` named export the entry imports.
  fs.writeFileSync(path.join(root, 'renderer/js/utils/host.js'), 'export const helper = 1\n')
  for (const [rel, src] of Object.entries(extraFiles)) {
    const p = path.join(root, 'renderer/js', rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, src)
  }
}

function runGate (root, script, extraEnv = {}) {
  return spawnSync(process.execPath, [path.join(CLI, script)], {
    cwd: root, encoding: 'utf8',
    env: { ...GIT_SAFE_ENV, GATE_ROOT: root, ...extraEnv },
    timeout: 120000 })
}

// ---- #2: nested dynamic imports become real graph edges ----
test('W33 #2: nested dynamic import of a MISSING target must be RED (edge is now checked)', () => {
  const root = mkFixture('esm-nested-missing')
  esmFixture(root, {
    'utils/host.js':
      "// arrow-body + promise-chain spellings, both used to escape the top-level-only scan\n" +
      "export const helper = 1\n" +
      "export const openIt = () => import('./does-not-exist.js')\n" +
      "export const lazy = () => import('./also-missing.vue').then(m => m.default)\n"
  })
  const r = runGate(root, 'check-esm-graph.cjs')
  assert.equal(r.status, 1, 'nested dynamic import edges must be checked: ' + (r.stdout + r.stderr))
  const out = r.stdout + r.stderr
  assert.match(out, /does-not-exist\.js/)
  assert.match(out, /also-missing\.vue/)
})

test('W33 #2: nested dynamic import of a REAL target stays GREEN', () => {
  const root = mkFixture('esm-nested-real')
  esmFixture(root, {
    'utils/host.js': "export const helper = 1\nexport const comp = () => import('./real-lazy.js')\n",
    'utils/real-lazy.js': "export default {}\n"
  })
  const r = runGate(root, 'check-esm-graph.cjs')
  assert.equal(r.status, 0, 'real nested dynamic targets must pass: ' + (r.stdout + r.stderr))
})

test('W33 #2: relative target containing "node_modules" stays IN-GRAPH (W28 fix kept)', () => {
  const root = mkFixture('esm-nested-rel-node_modules')
  esmFixture(root, {
    'utils/host.js': "export const helper = 1\nexport const load = () => import('../vendor/node_modules-shim/x.js')\n"
  })
  const r = runGate(root, 'check-esm-graph.cjs')
  assert.equal(r.status, 1, 'a relative path with node_modules in it must not escape existence check: ' + (r.stdout + r.stderr))
  assert.match(r.stdout + r.stderr, /node_modules-shim\/x\.js/)
})

// ---- #3: dynamic bare names must resolve (alias ∪ node_modules) ----
test('W33 #3: dynamic bare name with NO alias and NO node_modules entry must be RED', () => {
  const root = mkFixture('esm-bare-unresolvable')
  esmFixture(root, {
    'utils/host.js': "export const helper = 1\nexport const load = () => import('totally-made-up-package-w33')\n"
  })
  const r = runGate(root, 'check-esm-graph.cjs')
  assert.equal(r.status, 1, 'unresolvable dynamic bare name must be red: ' + (r.stdout + r.stderr))
  assert.match(r.stdout + r.stderr, /totally-made-up-package-w33/)
})

test('W33 #3: alias bare (vue) and a real node_modules package stay GREEN as dynamic imports', () => {
  const root = mkFixture('esm-bare-resolvable')
  esmFixture(root, {
    'utils/host.js':
      "export const helper = 1\n" +
      "export const loadVue = () => import('vue')\n" +
      "export const loadTs = () => import('typescript')\n"
  })
  // the real node_modules entry the bare name resolves against (fixture-scoped)
  fs.mkdirSync(path.join(root, 'node_modules', 'typescript'), { recursive: true })
  const r = runGate(root, 'check-esm-graph.cjs')
  assert.equal(r.status, 0, 'resolvable dynamic bare names must pass: ' + (r.stdout + r.stderr))
})

// ---- #1: manifest census covers setMetaMany ----
test('W33 #1: setMetaMany has a manifest row (internal meta.putMany) — census is total', () => {
  const manifest = require_(path.join(ROOT, 'src/main/command-manifest.js'))
  const row = manifest.COMMANDS['meta.putMany']
  assert.ok(row, 'meta.putMany manifest row missing — setMetaMany drifts between bus USAGE throw and silent db.call')
  assert.equal(row.op, 'setMetaMany')
  assert.equal(row.internal, true, 'internal commands carry no facade row by design')
  assert.equal(row.lwwField, null, 'meta is a KV table: no age column (mirror of meta.put)')
  assert.equal(row.localKeys, manifest.isMachineLocalMetaKey, 'mirror meta.put machine-local filtering')
  // and the write-op census is now total
  const { WRITE_OPS } = require_(path.join(ROOT, 'src/main/db-write-ops.cjs'))
  const ops = new Set(Object.values(manifest.COMMANDS).map(r => r.op))
  for (const op of WRITE_OPS) assert.ok(ops.has(op), `WRITE_OPS "${op}" has no manifest row`)
})

test('W33 #1: full command-bus gate stays green with the new row', () => {
  const r = spawnSync(process.execPath, [path.join(CLI, 'check-command-bus.cjs')], {
    cwd: ROOT, encoding: 'utf8', env: GIT_SAFE_ENV, timeout: 120000 })
  assert.equal(r.status, 0, 'check-command-bus must pass: ' + (r.stdout + r.stderr))
})

// ---- #4: OPS key extraction shares OP_ID's identifier class ----
test('W33 #4: OPS-key regex captures digit-carrying keys whole (same class as OP_ID)', () => {
  const gateSrc = fs.readFileSync(path.join(CLI, 'check-ipc-op-coverage.cjs'), 'utf8')
  // The gate's own extraction (mirrored below) must use OP_ID's identifier class — the comment
  // in the file requires the two calibers stay identical.
  assert.match(gateSrc, /const OP_ID = '\(\[A-Za-z_\]\[A-Za-z0-9_\]\*\)'/)
  assert.match(gateSrc, /matchAll\(\/\^ \{2}\(\[A-Za-z_\]\[A-Za-z0-9_\]\*\)\(\?::\|,\)\/gm\)/)
  // Mirror of the db.js OPS table extraction (check-ipc-op-coverage.cjs) — a digit-carrying op
  // (export_v2) must not be split at the digit the way [A-Za-z_]+ did.
  function opsKeysSample (src) {
    const m = src.match(/\nconst OPS = \{([\s\S]*?)\n\}/)
    return new Set([...m[1].matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*)(?::|,)/gm)].map(x => x[1]))
  }
  const dbJs = `
const OPS = {
  upsert: () => {},
  export_v2: () => {},
  plan80: () => {},
  _recToRow: () => {},
}
`
  const ops = opsKeysSample(dbJs)
  assert.ok(ops.has('export_v2'), 'digit-carrying underscore key must be captured whole')
  assert.ok(ops.has('plan80'), 'trailing-digit key must be captured whole')
  assert.ok(ops.has('_recToRow'), 'internal underscore keys still captured (visible for the no-whitelist direction)')
  assert.ok(![...ops].some(k => /[^A-Za-z0-9_]/.test(k)), 'no split fragments like export_v')
})
