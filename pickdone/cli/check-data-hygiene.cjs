#!/usr/bin/env node
/* eslint-env node */
/**
 * Data-hygiene linter (maint/d24) — READ-ONLY diagnostic gate. NOT part of check:all: it lints the
 * CONFIGURED database (TODO_DB_DIR > TODO_USER_DATA_DIR > platform default), and a real user DB with
 * historical junk would trip it, so it is a standalone tool: `node cli/check-data-hygiene.cjs`.
 * The linter itself never writes: it only calls read ops on the db module (the same idempotent
 * schema-init/read path every read command uses).
 *
 * Flags:
 *   (a) live categories with empty/whitespace names (unaddressable junk for resolveCategory)
 *   (b) duplicate normalized names among live categories (NFKC + casefold + whitespace strip,
 *       the same normKey the CLI resolves with)
 *   (c) category rows with createTime = 0 (un-datable rows, statistics/audit hostile)
 *   (d) id clusters > 5 within one millisecond (categories are minted Date.now()*1000 + jitter —
 *       a >5 cluster signals a broken/fast mint loop that once caused silent upsert overwrites)
 *   (e) live tasks whose categoryId points at a tombstoned/missing category (dangling references
 *       — the App falls back to unfiled, the CLI keyword paths resolve to nothing)
 *
 * Output: human-readable list on stdout; exit 1 when anything is flagged (gate-style), 0 when clean.
 * Run: node cli/check-data-hygiene.cjs
 */
const dbm = require('../src/main/db.js')
const { userDataDir } = require('../src/main/user-dir.js')

// Same normalization the CLI resolves categories with (cli/lib.js normKey, injected into lib-tasks)
const normKey = v => String(v).normalize('NFKC').toLowerCase().replace(/[\s\u00A0\u3000\u200B\u2003]/g, '')

// Pure finding pass over already-read rows (exported so tests can pin the thresholds deterministically)
function collectFindings (cats, liveTasks) {
  const findings = []
  const flag = (check, detail) => findings.push({ check, detail })

  const { isBlankishName } = require('../src/main/blankish-name.cjs') // D25 W1
  const emptyNamed = cats.filter(c => isBlankishName(c.categoryName))
  for (const c of emptyNamed) flag('empty-category-name', `category id ${c.categoryId} has an empty/whitespace name`)

  const byNorm = new Map()
  for (const c of cats) {
    const k = normKey(c.categoryName || '')
    if (!k) continue // empty names are already flagged under (a)
    if (!byNorm.has(k)) byNorm.set(k, [])
    byNorm.get(k).push(c)
  }
  for (const [k, group] of byNorm) {
    if (group.length > 1) flag('duplicate-category-name', `normalized name "${k}" is shared by ${group.length} live categories: ${group.map(c => c.categoryId).join(', ')}`)
  }

  for (const c of cats) {
    if (!c.createTime) flag('category-createTime-zero', `category id ${c.categoryId} (${c.categoryName || '(empty name)'}) has createTime = 0`)
  }

  const byMs = new Map()
  for (const c of cats) {
    const ms = Math.floor(Number(c.categoryId) / 1000) // mint shape: Date.now()*1000 + jitter
    if (!Number.isFinite(ms) || ms <= 0) continue
    if (!byMs.has(ms)) byMs.set(ms, [])
    byMs.get(ms).push(c.categoryId)
  }
  for (const [ms, ids] of byMs) {
    if (ids.length > 5) flag('category-id-cluster', `${ids.length} category ids minted within the same millisecond (${ms}): ${ids.join(', ')}`)
  }

  const liveIds = new Set(cats.map(c => String(c.categoryId)))
  const dangling = liveTasks.filter(t => t.categoryId && !liveIds.has(String(t.categoryId)))
  for (const t of dangling) flag('dangling-task-category', `live task ${t.taskId} ("${t.taskContent}") points at category ${t.categoryId} which is tombstoned or missing`)

  return findings
}

function scan () {
  dbm.init(userDataDir())
  const cats = dbm.call('getAllCategories') // live rows only (deleted = 0), same read as the CLI
  const liveTasks = dbm.call('queryTodos', { deleted: 0 })
  const findings = collectFindings(cats, liveTasks)
  return { total: findings.length, findings, categories: cats.length, liveTasks: liveTasks.length }
}

function main () {
  let r
  try {
    r = scan()
  } catch (e) {
    console.error('check-data-hygiene: cannot open the configured database (' + (e && e.message ? e.message : e) + ')')
    process.exit(1)
  }
  if (!r.findings.length) {
    console.log(`OK: data hygiene clean (${r.categories} live categories, ${r.liveTasks} live tasks, 0 findings)`)
    process.exit(0)
  }
  console.log(`data hygiene: ${r.findings.length} finding(s) across ${r.categories} live categories / ${r.liveTasks} live tasks:`)
  for (const f of r.findings) console.log(`  [${f.check}] ${f.detail}`)
  console.log('exit 1 (findings above are diagnostic — fix via the CLI/App; this tool never writes)')
  process.exit(1)
}

if (require.main === module) main()
module.exports = { scan, collectFindings, normKey }
