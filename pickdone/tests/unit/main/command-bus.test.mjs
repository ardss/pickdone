/**
 * Command-bus unit tests (Phase 1, docs/refactor-command-bus.md) — the bus contract:
 *   - unknown command throws USAGE (never a silent no-op)
 *   - stamp normalization: the bus stamps the manifest's lwwField; explicit peer ages and
 *     opts.preserveStamp survive untouched (sync-apply internal use)
 *   - machine-local key classification (meta/settings localKeys filters)
 *   - post-commit fanout runs in registration order, same-name registration replaces, and a
 *     throwing subscriber never breaks the commit result
 *   - op-keyed route (commitOp/commandForOp) matches the manifest reverse index
 *   - manifest gate self-test (cli/check-command-bus.cjs --selftest) passes
 * Run: node --test tests/unit/main/command-bus.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')

function makeBus () {
  const calls = []
  const bus = require(join(root, 'src/main/command-bus.js')).createBus((op, params) => {
    calls.push({ op, params })
    return { ok: true, op }
  })
  return { bus, calls }
}

test('unknown command throws USAGE, known command dispatches to the manifest op', () => {
  const { bus, calls } = makeBus()
  assert.throws(() => bus.commit('todo', 'nukeFromOrbit', {}), e => e.code === 'USAGE')
  assert.throws(() => bus.commit('bogus', 'put', {}), e => e.code === 'USAGE')
  const r = bus.commit('todo', 'put', { taskId: 't1', taskContent: 'x' })
  assert.equal(r.op, 'upsert')
  assert.equal(calls.length, 1)
  // op-keyed route shares the same door
  assert.equal(bus.commitOp('hardDelete', 't1').op, 'hardDelete')
  assert.throws(() => bus.commitOp('notAManifestOp', {}), e => e.code === 'USAGE')
})

test('stamp normalization: bus stamps lwwField; explicit age and preserveStamp survive', () => {
  const { bus, calls } = makeBus()
  bus.commit('todo', 'put', { taskId: 't1' })
  assert.ok(Number(calls[0].params.updatedAt) > 0, 'bus stamps updatedAt')
  const peerAge = 1234567890123
  bus.commit('todo', 'put', { taskId: 't2', updatedAt: peerAge })
  assert.equal(calls[1].params.updatedAt, peerAge, 'explicit peer age preserved (sync-apply path)')
  bus.commit('todo', 'put', { taskId: 't3' }, { preserveStamp: true })
  assert.equal(calls[2].params.updatedAt, undefined, 'preserveStamp skips stamping')
  // payload is never mutated in place (callers may hold reactive rows)
  const row = { taskId: 't4' }
  bus.commit('todo', 'put', row)
  assert.equal(row.updatedAt, undefined)
  // ops without an lwwField are passed through verbatim
  bus.commit('todo', 'hardDelete', 't1')
  assert.equal(calls[4].params, 't1')
})

test('local-key filter: meta/settings rows classify machine-local keys, user keys stay syncable', () => {
  const { bus } = makeBus()
  const metaRow = bus.resolve('meta', 'put')
  const setRow = bus.resolve('setting', 'put')
  for (const k of ['sync.peer.x', '_cliStamp', 'securityLockPin', 'cliTomatoCmd', 'cliSyncSeq', 'todosVersion', 'firedReminders:t1', 'reminderLastSeenAt', 'snowDedup:t:k', 'metaConflictBackup.k']) {
    assert.ok(bus.isLocalKey(metaRow, k), 'meta local: ' + k)
  }
  assert.ok(!bus.isLocalKey(metaRow, 'repeatRule:r1'), 'repeatRule is user data')
  assert.ok(!bus.isLocalKey(metaRow, 'projectMilestones:c1'), 'milestones are user data')
  for (const k of ['sync.x', '_stamp', 'securityLockA']) assert.ok(bus.isLocalKey(setRow, k), 'setting local: ' + k)
  assert.ok(!bus.isLocalKey(setRow, 'habits.pomodoro'), 'habits settings are user data')
  assert.ok(!bus.isLocalKey(bus.resolve('todo', 'put'), 'anything'), 'rows without localKeys classify nothing')
})

test('fanout: hooks run post-commit in registration order, replace by name, failures are swallowed', () => {
  const { bus, calls } = makeBus()
  const order = []
  bus.onCommit('first', () => order.push('first'))
  bus.onCommit('second', () => order.push('second'))
  bus.onCommit('ls-mirror', () => order.push('mirror'))
  bus.commit('meta', 'put', ['k', 'v'])
  assert.deepEqual(order, ['first', 'second', 'mirror'])
  assert.equal(calls.length, 1, 'hooks run AFTER the db write landed')
  // same-name registration replaces (idempotent re-register)
  bus.onCommit('second', () => order.push('second-2'))
  bus.commit('meta', 'put', ['k', 'v'])
  assert.deepEqual(order, ['first', 'second', 'mirror', 'first', 'second-2', 'mirror'])
  // a throwing subscriber must never break the commit result
  bus.onCommit('bomb', () => { throw new Error('subscriber exploded') })
  const r = bus.commit('meta', 'put', ['k2', 'v'])
  assert.equal(r.op, 'setMeta')
  bus.offCommit('bomb')
})

test('commandForOp routes every write op the renderer whitelist exposes; manifest gate self-test passes', () => {
  const { bus } = makeBus()
  for (const op of ['upsert', 'upsertMany', 'commitSyncBatch', 'hardDelete', 'hardDeleteMany', 'setMeta', 'deleteMeta', 'bumpSnow', 'upsertCategory', 'filterUpsert', 'filterDelete', 'planAddMany', 'planUpdateChip', 'planRemoveIds', 'planMoveTask', 'planDeleteTask', 'planDeleteTaskDay', 'planPrune', 'tomatoAppendMany', 'tomatoUpdateById', 'tomatoRemoveByIds', 'tomatoMigrateFromMeta', 'settingsRowPut', 'settingsRowPutMany', 'settingsRowDelete', 'syncSetEnabled', 'syncSetPeerAlias']) {
    assert.ok(bus.commandForOp(op), 'manifest covers ' + op)
  }
  assert.equal(bus.commandForOp('getAll'), null, 'reads are not manifest commands')
  assert.equal(bus.commandForOp('queryTodos'), null)
  // manifest gate self-test (negative cases baked into the gate script)
  const out = execFileSync(process.execPath, [join(root, 'cli/check-command-bus.cjs'), '--selftest'], { encoding: 'utf8' })
  assert.match(out, /self-test passed/)
})
