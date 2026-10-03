#!/usr/bin/env node
/**
 * SCHEMA/MIGRATIONS dual-manifest gate (PA-3) — statically proves the two hand-maintained
 * schema manifests stay convergent for the todos table, replacing the runtime self-healing
 * backstop that used to live in db.js's init path.
 *
 * Root removed: db.js used to diff todoToRow's keys against PRAGMA table_info(todos) at every
 * startup (electron main AND the CLI share the same open path) and silently ALTER TABLE'd any
 * missing column with heuristic defaults (NULL-able for anything without a JS default — diverging
 * from the intended NOT NULL contract; index/trigger side effects not replayed), logging a warn
 * and carrying on. That backstop masked the real invariant — a column must be registered in BOTH
 * the SCHEMA CREATE TABLE (fresh install) and the MIGRATIONS chain (existing-DB upgrade) — by
 * healing its violation on every startup path instead of failing red.
 *
 * The gate asserts, at CI/test time:
 *   1. every column todoToRow can emit exists in the SCHEMA todos CREATE TABLE
 *      (the upsert prepare references exactly these keys — a miss dies loudly at prepare);
 *   2. every migration's `ALTER TABLE todos ADD COLUMN x` exists in the SCHEMA CREATE TABLE
 *      (fresh installs never replay migrations — a miss means an upgradable DB has a column
 *      a fresh install lacks);
 *   3. the runtime self-healing probe stays deleted from db.js (no `ALTER TABLE` in main
 *      code — schema shape changes belong to SCHEMA + MIGRATIONS, nowhere else).
 *
 * Usage: node cli/check-schema-manifests.cjs          # gate
 *       SCHEMA_MANIFEST_SELFTEST=1 node cli/check-schema-manifests.cjs   # negative self-test
 *       (injects a fake todoToRow column expectation; gate must turn red — prevents an
 *        always-green gate, and doubles as the regression test for the invariant)
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const DB_JS = path.join(ROOT, 'src', 'main', 'db.js')
const MIGRATIONS_JS = path.join(ROOT, 'src', 'main', 'db-migrations.js')
const SELFTEST = !!process.env.SCHEMA_MANIFEST_SELFTEST

// db-rows is pure (no db handle, no electron) — loadable under plain node
const { todoToRow } = require(path.join(ROOT, 'src', 'main', 'db-rows'))

/** Parse the todos column list out of db.js's SCHEMA template literal */
function schemaTodosCols (dbSrc) {
  const m = dbSrc.match(/CREATE TABLE IF NOT EXISTS todos \(([\s\S]*?)\n\);/)
  if (!m) throw new Error('todos CREATE TABLE not found in src/main/db.js — SCHEMA shape changed, update the gate')
  return m[1].split('\n')
    .map(l => l.replace(/--.*$/, '').trim())
    .filter(l => l && !/^--/.test(l))
    .map(l => l.split(/[\s(]/)[0].replace(/,$/, ''))
    .filter(c => c && c !== 'PRIMARY' && c !== 'UNIQUE' && !/^(FOREIGN|CONSTRAINT|CHECK)$/i.test(c))
}

/** Parse every `ALTER TABLE todos ADD COLUMN <name>` from the migrations file */
function migrationAddCols (migSrc) {
  return [...new Set([...migSrc.matchAll(/ALTER TABLE todos ADD COLUMN (\w+)/g)].map(m => m[1]))]
}

function main () {
  const dbSrc = fs.readFileSync(DB_JS, 'utf8')
  const migSrc = fs.readFileSync(MIGRATIONS_JS, 'utf8')
  const schemaCols = schemaTodosCols(dbSrc)
  const want = Object.keys(todoToRow({ taskId: '' }))
  if (SELFTEST) want.push('selftestFakeColumn') // negative self-test: fake expectation must turn the gate red

  let failed = 0
  const bad = m => { console.error('  ✗ ' + m); failed++ }
  const ok = m => console.log('  ✓ ' + m)

  const missingInSchema = want.filter(c => !schemaCols.includes(c))
  if (missingInSchema.length) {
    bad('todoToRow emits columns absent from the SCHEMA todos CREATE TABLE (register them in BOTH manifests before shipping): ' + missingInSchema.join(', '))
  } else {
    ok(`todoToRow (${want.length} cols) ⊆ SCHEMA todos (${schemaCols.length} cols)`)
  }

  const addCols = migrationAddCols(migSrc)
  const missingFromFreshInstall = addCols.filter(c => !schemaCols.includes(c))
  if (missingFromFreshInstall.length) {
    bad('migrations ADD COLUMN names absent from the SCHEMA todos CREATE TABLE (fresh installs never replay migrations): ' + missingFromFreshInstall.join(', '))
  } else {
    ok(`migration ADD COLUMN todos (${addCols.length}: ${addCols.join(', ')}) ⊆ SCHEMA todos`)
  }

  if (/ALTER TABLE todos ADD COLUMN/.test(dbSrc)) {
    bad('src/main/db.js contains an ALTER TABLE backstop — the runtime self-healing probe must stay deleted; schema shape changes belong to SCHEMA + db-migrations only')
  } else {
    ok('no runtime ALTER backstop in src/main/db.js (drift now fails red here / at upsert prepare, never self-heals)')
  }

  console.log(`[check-schema-manifests] todoToRow ${want.length} / SCHEMA todos ${schemaCols.length} / migrations ADD COLUMN ${addCols.length}`)
  if (SELFTEST) {
    const caught = failed > 0
    console.log(caught ? '[check-schema-manifests] negative self-test: fake column expectation correctly intercepted ✓' : '[check-schema-manifests] negative self-test FAILED: fake column expectation not caught ✗')
    process.exit(caught ? 0 : 1)
  }
  if (failed) process.exit(1)
  console.log('[check-schema-manifests] SCHEMA/MIGRATIONS/todoToRow manifests convergent ✓')
}

main()
