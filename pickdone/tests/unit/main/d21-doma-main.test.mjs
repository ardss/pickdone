// D21 domain fixes (2026-10-02) — main-process side:
//   finding 1 (pin + convention): white-noise tmp files use the `.att-tmp-<ts>-<rand>` suffix so
//               the D19 residue sweep regex matches them.
//   finding 4: sustained audit IO failure counts dropped chunks and console.errors every 10.
//   finding 8: db-revisions list/exportToStore/verifyHash survive one torn JSON row (per-row skip).
//   finding 10: dbRecovery.markRecoveryPending writes parseably (durable path, source pinned).
//   finding 11: db-sync-schema rowPut honors an explicit updatedAt like rowPutMany does.
//   findings 3/5/9 (source pins): windows.js retry timer cleared on 'closed'; scheduler evict-path
//               flush coalesced behind the pending persist timer; backup-dirs durable write.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, existsSync, readFileSync as rf } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const srcOf = (p) => readFileSync(join(ROOT, p), 'utf8')

// ---------------------------------------------------------------- finding 1 (convention + pin)
test('D21: white-noise tmp suffix matches the D19 crash-residue sweep regex (finding 1)', () => {
  const attSrc = srcOf('src/main/attachments.js')
  const m = attSrc.match(/const ATT_TMP_RE = (\/.+\/)/)
  assert.ok(m, 'sweep regex present')
  const ATT_TMP_RE = eval(m[1]) // the literal itself is the fixture under test
  // The suffix minted in handlers/attachments.js for the white-noise copy:
  const tmpName = 'noise-custom.mp3' + '.att-tmp-' + Date.now() + '-' + Math.floor(Math.random() * 1e6)
  assert.match(tmpName, ATT_TMP_RE, 'crash residue sweep must age the white-noise tmp out')
  // And the handler actually mints that suffix now:
  const hSrc = srcOf('src/main/handlers/attachments.js')
  assert.match(hSrc, /key \+ '\.att-tmp-' \+ Date\.now\(\) \+ '-' \+ Math\.floor\(Math\.random\(\) \* 1e6\)/)
  assert.doesNotMatch(hSrc, /\.tmp-' \+ process\.pid/, 'old pid-based invisible suffix must be gone')
})

// ------------------------------------------------------------------------ finding 4 (behavior)
test('D21: sustained audit IO failure warns once per 10 dropped chunks (finding 4)', async () => {
  const audit = require('../../../src/main/audit.js')
  const dir = mkdtempSync(join(tmpdir(), 'd21-audit-'))
  // Poison the append target: a DIRECTORY where the audit file must be → every append EISDIRs.
  mkdirSync(join(dir, 'cli-audit.jsonl'))
  audit.setDirResolver(() => dir)
  const errs = []
  const origError = console.error
  console.error = (...a) => errs.push(a.map(String).join(' '))
  try {
    for (let i = 0; i < 10; i++) {
      audit.recordCustom('d21-drop-test-' + i, ['x'], [], ['c' + i], null) // distinct: never folded
      audit.flushNow() // one drain = one chunk = one drop
    }
  } finally {
    console.error = origError
    audit.resetForTests()
  }
  const warns = errs.filter((l) => /audit chunks dropped/.test(l))
  assert.equal(warns.length, 1, 'exactly one warn at the 10th drop, not one per chunk')
  assert.match(warns[0], /\b10\b/)
})

// ------------------------------------------------------------------------ finding 8 (behavior)
function fakeRevDb ({ revRows, payloadRows, singlePayload }) {
  const calls = []
  const db = {
    open: true,
    prepare (sql) {
      calls.push(sql)
      return {
        all: () => (sql.includes('sync_revision_payloads') ? payloadRows : revRows),
        get: () => singlePayload,
        run: () => ({ changes: 0 }),
      }
    },
  }
  return { db, calls }
}

test('D21: db-revisions list/export survive one torn JSON row (per-row skip, finding 8)', () => {
  const create = require('../../../src/main/db-revisions.cjs')
  const warns = []
  const { db } = fakeRevDb({
    revRows: [
      { revisionId: 'r1', entity: 'todo', entityId: '1', hlcPhysical: 1, hlcLogical: 0, authorDeviceId: 'a', parents: '[ ]', payloadHash: 'h1', status: 'live' },
      { revisionId: 'r2', entity: 'todo', entityId: '1', hlcPhysical: 2, hlcLogical: 0, authorDeviceId: 'a', parents: '{torn', payloadHash: 'h2', status: 'live' },
    ],
    payloadRows: [
      { revisionId: 'r1', payload: '{"ok":1}' },
      { revisionId: 'r2', payload: '{"torn' },
    ],
  })
  const rec = create({ getDb: () => db, log: { warn: (...a) => warns.push(a.join(' ')) } })
  // list(): the torn parents row is skipped, the good row survives, nothing throws.
  const listed = rec.list('1')
  assert.deepEqual(listed.map(r => r.revisionId), ['r1'])
  assert.ok(warns.some(w => /skipping torn JSON parents/.test(w)))
  // exportToStore(): torn payload skipped, good envelope applied.
  const applied = []
  const store = rec.exportToStore(() => ({}), (_s, env) => applied.push(env.revisionId))
  assert.ok(store)
  assert.deepEqual(applied, ['r1'])
  // verifyHash(): torn payload → false without throwing.
  assert.equal(rec.verifyHash('r2'), false)
})

// ---------------------------------------------------- findings 10 + 9 (behavior / durable pin)
test('D21: markRecoveryPending still writes a parseable sentinel (finding 10, durable path)', () => {
  const rec = require('../../../src/main/dbRecovery.cjs')
  const ud = mkdtempSync(join(tmpdir(), 'd21-rec-'))
  assert.equal(rec.markRecoveryPending(ud, { reason: 'd21-test' }), true)
  const p = rec.recoveryPendingPath ? rec.recoveryPendingPath(ud) : join(ud, 'recovery-pending.json')
  const target = existsSync(p) ? p : join(ud, 'db-recovery-pending.json')
  const raw = rf(existsSync(target) ? target : findJson(ud))
  assert.deepEqual(JSON.parse(raw).reason, 'd21-test')
  // Durable routing is pinned: the sentinel must go through the shared durable writer.
  assert.match(srcOf('src/main/dbRecovery.cjs'), /writeFileDurable\(/)
  function findJson (dir) { // name-agnostic: exactly one JSON sentinel was written into ud
    const { readdirSync } = require('node:fs')
    const hit = readdirSync(dir).find((f) => f.endsWith('.json'))
    assert.ok(hit, 'sentinel json written')
    return join(dir, hit)
  }
  assert.match(srcOf('src/main/backup-dirs.js'), /writeFileDurable\(/, 'finding 9: backup whitelist persists durably')
})

// ----------------------------------------------------------------------- finding 11 (behavior)
test('D21: rowPut honors an explicit updatedAt like rowPutMany (finding 11)', () => {
  const createSchema = require('../../../src/main/db-sync-schema.js')
  let captured = null
  const db = {
    open: true,
    prepare (sql) {
      if (/INSERT INTO settings_rows/.test(sql)) {
        return { run: (...a) => { captured = a; return { changes: 1 } } }
      }
      return { get: () => null, all: () => [], run: () => ({ changes: 0 }) }
    },
    transaction: (fn) => fn,
  }
  const schema = createSchema({ getDb: () => db, log: console })
  schema.rowPut({ key: 'k', value: { a: 1 }, updatedAt: 12345 })
  assert.equal(captured[2], 12345, 'sync-applied explicit stamp must win over Date.now()')
  const before = Date.now()
  schema.rowPut({ key: 'k', value: { a: 2 } })
  assert.ok(Math.abs(captured[2] - before) < 5000, 'local writes without a stamp keep the now-stamp')
})

// ------------------------------------------------------------ findings 3/5 source pins (Electron)
test('D21 source pins: windows retry timer cleared on closed; scheduler flush coalesced', () => {
  const wSrc = srcOf('src/main/windows.js')
  assert.match(wSrc, /let loadRetryTimer = null/)
  assert.match(wSrc, /closed'.*loadRetryTimer|loadRetryTimer; loadRetryTimer = null/s, "retry timer must clear in the 'closed' handler")

  const sSrc = srcOf('src/main/scheduler.js')
  assert.match(sSrc, /if \(!_persistTimer\) flushFiredNow\(\)/, 'evict-path flush must coalesce behind a pending persist')
  assert.doesNotMatch(sSrc, /^\s*flushFiredNow\(\)\s*$/, 'no bare hot-path flush left in the eviction branch')
})
