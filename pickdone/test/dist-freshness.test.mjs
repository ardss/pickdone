/* Regression (2026-09-28, ask leftover): app-dev.mjs's distFresh fingerprint missed shared/**
 * and assets/** — editing a shared module (or an asset) left the dist reading as "fresh", so
 * `npm start` skipped the vite rebuild and the dev session silently ran stale build output.
 * isDistFresh (extracted to scripts/dist-freshness.mjs) now fingerprints renderer/js,
 * renderer/index.html, vite.config.mjs, shared/** and assets/**. Plain node, temp fixtures. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isDistFresh } from '../scripts/dist-freshness.mjs'

function fixtureAppRoot () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-fresh-'))
  for (const f of [
    ['renderer', 'js', 'app.js'],
    ['renderer', 'index.html'],
    ['vite.config.mjs'],
    ['shared', 'sort-core.mjs'],
    ['assets', 'img', 'logo.png'],
  ]) {
    const p = path.join(root, ...f)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, 'x')
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(p, old, old) // all sources 60s old
  }
  const distIdx = path.join(root, 'renderer-dist', 'index.html')
  fs.mkdirSync(path.dirname(distIdx), { recursive: true })
  fs.writeFileSync(distIdx, 'x')
  return root
}

const touch = (root, segs) => fs.utimesSync(path.join(root, ...segs), new Date(), new Date())
const build = (root) => touch(root, ['renderer-dist', 'index.html']) // dist newer than everything

test('dist newer than ALL sources (incl. shared/assets) → fresh, rebuild skipped', () => {
  const root = fixtureAppRoot()
  build(root)
  assert.equal(isDistFresh(root), true)
})

test('THE FIX: a shared/** change newer than dist → NOT fresh (pre-fix: true, stale dist served)', () => {
  const root = fixtureAppRoot()
  build(root)
  touch(root, ['shared', 'sort-core.mjs'])
  assert.equal(isDistFresh(root), false, 'editing shared/** must invalidate the dist')
})

test('THE FIX: an assets/** change newer than dist → NOT fresh (pre-fix: true)', () => {
  const root = fixtureAppRoot()
  build(root)
  touch(root, ['assets', 'img', 'logo.png'])
  assert.equal(isDistFresh(root), false, 'editing assets/** must invalidate the dist')
})

test('renderer/js change newer than dist → NOT fresh (existing behavior preserved)', () => {
  const root = fixtureAppRoot()
  build(root)
  touch(root, ['renderer', 'js', 'app.js'])
  assert.equal(isDistFresh(root), false)
})

test('missing dist → NOT fresh (first run must build)', () => {
  const root = fixtureAppRoot()
  fs.rmSync(path.join(root, 'renderer-dist'), { recursive: true, force: true })
  assert.equal(isDistFresh(root), false)
})

test('THE FIX: stat failure inside recursive walk → NOT fresh, no throw (pre-fix: raw EPERM/ENOENT stack crashed npm start)', () => {
  const root = fixtureAppRoot()
  build(root)
  const realStatSync = fs.statSync
  let thrown = false
  try {
    // Simulate TOCTOU/EPERM: stat of one shared/** entry fails mid-walk
    fs.statSync = (p, ...rest) => {
      if (String(p).includes(path.join('shared', 'sort-core.mjs'))) {
        thrown = true
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      }
      return realStatSync(p, ...rest)
    }
    // must not throw; unknown subtree mtime → Infinity → fail toward rebuild
    assert.equal(isDistFresh(root), false, 'unreadable source must force a rebuild, not crash or read as fresh')
  } finally {
    fs.statSync = realStatSync
  }
  assert.equal(thrown, true, 'fixture must have actually triggered the failing stat')
})
