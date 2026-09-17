/**
 * Adapter-contract guard (P3a incident 2026-09-17): the lan-sync-bootstrap localStore adapter
 * missed `applyRow`, so engine.ingestSegment threw a TypeError on every pull and both devices
 * silently exchanged zero rows while rounds still reported success. The engine contract
 * (shared/sync-core/engine.mjs header) requires: getRowsSince/applyRow/getCursor/setCursor/
 * allRows/replaceAll. Assert the real adapter implements every required key.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '../../..')

test('lan-sync-bootstrap localStore adapter implements the full engine contract', () => {
  const REQUIRED = ['getRowsSince', 'applyRow', 'getCursor', 'setCursor', 'allRows', 'replaceAll']
  const src = fs.readFileSync(path.join(ROOT, 'src/main/lan-sync-bootstrap.js'), 'utf8')
  const start = src.indexOf('function createLocalStoreAdapter')
  assert.ok(start >= 0, 'createLocalStoreAdapter not found')
  const next = src.indexOf('\nfunction ', start + 10)
  const body = src.slice(start, next > 0 ? next : undefined)
  for (const key of REQUIRED) {
    assert.ok(body.includes(key), 'adapter is missing contract method: ' + key)
  }
})

test('engine header contract list matches the guard (drift alarm)', () => {
  const engineSrc = fs.readFileSync(path.join(ROOT, 'shared/sync-core/engine.mjs'), 'utf8')
  assert.match(engineSrc, /getRowsSince\(seq\) -> rows/, 'contract header changed — update the adapter guard')
  assert.match(engineSrc, /applyRow\(row\)\s+-> boolean/, 'contract header changed — update the adapter guard')
})
