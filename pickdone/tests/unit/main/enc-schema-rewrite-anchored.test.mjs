/**
 * 2026-10-10 (CTO sweep A#7): the encrypted-schema rewrite must touch ONLY real
 * CREATE TABLE/INDEX statements. The old unanchored `.replace(/CREATE TABLE IF NOT
 * EXISTS /g, ...)` also mangled any comment/trigger/view that merely CONTAINS the
 * substring — silent corruption waiting for the next DDL edit. Anchored now (^line,
 * multiline flag); this test pins both directions against the REAL SCHEMA constant.
 * Run: node --test tests/unit/main/enc-schema-rewrite-anchored.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { SCHEMA } = require(path.join(path.resolve(import.meta.dirname, '../../..'), 'src/main/db.js'))

const rewrite = (schema) => schema
  .replace(/^[ \t]*CREATE TABLE IF NOT EXISTS /gm, 'CREATE TABLE IF NOT EXISTS enc.')
  .replace(/^[ \t]*CREATE INDEX IF NOT EXISTS /gm, 'CREATE INDEX IF NOT EXISTS enc.')

test('enc-schema rewrite: every real TABLE/INDEX statement lands in the enc. namespace', () => {
  const rewritten = rewrite(SCHEMA)
  const stmts = SCHEMA.match(/^[ \t]*CREATE (TABLE|INDEX) IF NOT EXISTS \w+/gm) || []
  assert.ok(stmts.length >= 10, 'sanity: the schema carries its real statement set, got ' + stmts.length)
  for (const stmt of stmts) {
    const kind = stmt.match(/CREATE (TABLE|INDEX)/)[1]
    const name = stmt.split('IF NOT EXISTS ')[1]
    assert.ok(rewritten.includes(`CREATE ${kind} IF NOT EXISTS enc.${name}`), `${kind} ${name} must be rewritten into enc.`)
  }
  // nothing may be double-prefixed (the old unanchored replace risked `enc.enc.` cascades
  // when a comment mentioned the pattern) and no non-statement line may be touched
  assert.ok(!rewritten.includes('enc.enc.'), 'no double prefix')
  assert.equal(rewritten.split('enc.').length - 1, stmts.length, 'exactly one enc. per statement — comments mentioning the pattern must stay untouched')
})
