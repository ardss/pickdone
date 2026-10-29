/* W19 (2026-10-30) — check-dualwrite multi-line/dynamic-key escape fix, fixture-tree unit tests.
 *
 * The old scan regex required the ledger key to sit right after `(` on the same line and to be
 * an identifier or '...'/"..." literal — a MULTI-LINE call whose key sat on a continuation line
 * inside a template literal (or any first arg not starting with [A-Za-z_$'"]) made the whole
 * write point invisible to the scan, so it could never enter tests/dualwrite-ledger.json.
 * Run: node --test tests/unit/cli/w19-dualwrite.test.mjs
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const CLI = path.join(import.meta.dirname, '../../../cli')
const FIX_ROOT = path.join(import.meta.dirname, '../../../.tmp-w19-dualwrite')
const madeDirs = []

// scrub GIT_* pointers (see gate-must-fail-golden for the 2026-10-11 incident this prevents)
const GIT_SAFE_ENV = (() => {
  const e = { ...process.env }
  for (const k of Object.keys(e)) { if (/^GIT_/i.test(k)) delete e[k] }
  return e
})()

function mkTree (name) {
  const root = fs.mkdtempSync(FIX_ROOT + '-' + name + '-')
  madeDirs.push(root)
  const write = (rel, content) => {
    const p = path.join(root, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
    return p
  }
  return { root, write }
}

function runGate (root, extraEnv = {}) {
  const env = { ...GIT_SAFE_ENV, GATE_ROOT: root, ...extraEnv }
  const r = spawnSync(process.execPath, [path.join(CLI, 'check-dualwrite.cjs')], { timeout: 60000, env, encoding: 'utf8' })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

const LEDGER_BASE = {
  'renderer/js/ok.js::todoList': { authority: 'sqlite', note: 'LS is a cache of todos table; recalibrated on boot via loadAll()' }
}

afterEach(() => {
  for (const d of madeDirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* next run cleans via .tmp-* */ }
  }
})

test('W19 dualwrite: a MULTI-LINE write point with a string-literal key on a continuation line is red when unregistered, green when registered', () => {
  const mk = (name, ledger) => {
    const { root, write } = mkTree(name)
    write('renderer/js/ok.js', "export function save (v) {\n  localStorage.setItem(\n    'todoList',\n    JSON.stringify(v)\n  )\n}\n")
    write('tests/dualwrite-ledger.json', JSON.stringify(ledger, null, 2))
    return root
  }
  const rb = runGate(mk('dw-ml-bad', {}))
  assert.equal(rb.code, 1, 'unregistered multi-line write point must be red: ' + rb.out)
  assert.match(rb.out, /renderer\/js\/ok\.js::todoList/, 'the multi-line write point must be named with its resolved key')

  const rg = runGate(mk('dw-ml-good', LEDGER_BASE))
  assert.equal(rg.code, 0, 'registered multi-line write point must pass: ' + rg.out)
})

test('W19 dualwrite: a template-literal (statically unparseable) key bail-outs as <expr:...> — inventory-visible and warned, NOT red', () => {
  // The hole this closes: `localStorage.setItem(`${ns}:k`, ...)` matched NOTHING before —
  // the write point left the ledger surface entirely. Bail-out semantics: loud warning, no red
  // (red stays reserved for "unregistered STATIC write point you must answer for").
  const { root, write } = mkTree('dw-dynamic')
  write('renderer/js/dyn.js', "const ns = 'repeatRule'\nexport function put (id, v) {\n  localStorage.setItem(\n    `${ns}:${id}`,\n    v\n  )\n}\n")
  write('tests/dualwrite-ledger.json', JSON.stringify({}, null, 2))
  const r = runGate(root)
  assert.equal(r.code, 0, 'a dynamic-key write point must NOT red the gate (warning only): ' + r.out)
  assert.match(r.out, /<expr:/, 'the bail-out <expr:...> key must appear in the output')
  assert.match(r.out, /无法静态解析/, 'the dynamic-key warning must fire')

  // and the inventory mode lists it, so the naming pass has something to work from
  const ri = runGate(root, { DUALWRITE_INVENTORY: '1' })
  assert.match(ri.out, /renderer\/js\/dyn\.js::<expr:/, 'inventory must carry the expr bail-out entry: ' + ri.out)
})

test('W19 dualwrite: leading string-literal prefix in a concatenated arg still registers by prefix (repeatRule: shape)', () => {
  // Ledger-parity pin: the old regex registered `'repeatRule:' + id` under the literal prefix;
  // the new extractor must not regress that into an <expr> entry (or the ledger would rot).
  const { root, write } = mkTree('dw-prefix')
  write('renderer/js/pfx.js', "export function put (id, v) { localStorage.setItem('repeatRule:' + id, v) }\n")
  write('tests/dualwrite-ledger.json', JSON.stringify({
    'renderer/js/pfx.js::repeatRule:': { authority: 'local-only', note: 'runtime repeat rule cache keyed by todo id; rebuilt on open' }
  }, null, 2))
  const rg = runGate(root)
  assert.equal(rg.code, 0, 'literal-prefix concatenated key must still match its ledger entry: ' + rg.out)
})

test('W19 dualwrite: negative self-test still catches an injected fake write point (detector alive)', () => {
  const { root, write } = mkTree('dw-selftest')
  write('renderer/js/ok.js', "export const noop = () => {}\n")
  write('tests/dualwrite-ledger.json', JSON.stringify(LEDGER_BASE, null, 2))
  const r = runGate(root, { DUALWRITE_SELFTEST: '1' })
  assert.equal(r.code, 0, 'SELFTEST must report the fake write point caught: ' + r.out)
  assert.match(r.out, /假写点被正确拦截/, 'negative self-test marker missing')
})
