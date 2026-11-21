import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const GATE = path.join(ROOT, 'cli', 'check-sync-matrix.cjs')
const DOC = path.join(ROOT, 'docs', 'sync-matrix.md')

function runGate(env) {
  const r = spawnSync(process.execPath, [GATE], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

function tmpDoc(overrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-matrix-gate-'))
  let text = fs.readFileSync(DOC, 'utf8')
  for (const [find, replace] of overrides) {
    assert.ok(text.includes(find), `fixture anchor not found in doc: ${find}`)
    text = text.replace(find, replace)
  }
  const file = path.join(dir, 'sync-matrix.md')
  fs.writeFileSync(file, text)
  return file
}

test('gate passes on the real repo (doc and code sync surface agree)', () => {
  const r = runGate({})
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}:\n${r.out}`)
  assert.match(r.out, /matrix doc and code sync surface agree/)
})

test('entity drift doc→code exits 1', () => {
  const doc = tmpDoc([['`todo`, `setting`, `tomato`', '`todo`, `setting`, `tomato`, `ghost`']])
  const r = runGate({ SYNC_MATRIX_DOC: doc })
  assert.equal(r.code, 1)
  assert.match(r.out, /matrix entity "ghost"/)
})

test('entity drift code→doc exits 1 (doc drops a syncable entity)', () => {
  const doc = tmpDoc([['`todo`, `setting`, `tomato`, `category`, `plan`, `filter`, `meta`', '`todo`, `setting`, `category`, `plan`, `filter`, `meta`']])
  const r = runGate({ SYNC_MATRIX_DOC: doc })
  assert.equal(r.code, 1)
  assert.match(r.out, /missing from docs\/sync-matrix\.md §3/)
})

test('DATA_CHANNEL_KINDS drift doc→code exits 1', () => {
  const doc = tmpDoc([["DATA_CHANNEL_KINDS = ['todo', 'category', 'plan', 'filter', 'meta']", "DATA_CHANNEL_KINDS = ['todo', 'category', 'plan', 'filter', 'meta', 'setting']"]])
  const r = runGate({ SYNC_MATRIX_DOC: doc })
  assert.equal(r.code, 1)
  assert.match(r.out, /DATA_CHANNEL_KINDS member "setting" declared in the matrix doc is absent/)
})

test('op census declared in the doc matches the manifest sync:full ops (both directions)', () => {
  const r = runGate({})
  assert.equal(r.code, 0, `gate should pass with the op census in place, got ${r.code}:\n${r.out}`)
  assert.match(r.out, /op census/)
})

test('op drift doc→code exits 1 (doc declares an op no manifest command dispatches to)', () => {
  const doc = tmpDoc([["'settingsRowPut'", "'settingsRowPut', 'phantomOp'"]])
  const r = runGate({ SYNC_MATRIX_DOC: doc })
  assert.equal(r.code, 1)
  assert.match(r.out, /op "phantomOp"/)
})

test('op drift code→doc exits 1 (a sync:full op is missing from the doc census)', () => {
  const doc = tmpDoc([["'settingsRowPut', 'settingsRowPutMany'", "'settingsRowPut'"]])
  const r = runGate({ SYNC_MATRIX_DOC: doc })
  assert.equal(r.code, 1)
  assert.match(r.out, /op "settingsRowPutMany"/)
})
