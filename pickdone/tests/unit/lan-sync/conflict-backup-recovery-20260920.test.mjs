/* X4 regression tests (meta conflict backup recovery IPC ops, 2026-09-20):
 * syncConflictBackupsList returns [{key, originalKey, lostAt, preview(<=200)}] over the
 * machine-local metaConflictBackup.* keys; syncConflictBackupRestore re-applies the lost value
 * to the original key (re-backing-up the current live value first) and deletes the backup key.
 * Run: node --test tests/unit/lan-sync/conflict-backup-recovery-20260920.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const scb = require('../../../src/main/sync-conflict-backups.js')

function fixture () {
  const meta = new Map(Object.entries({
    'metaConflictBackup.projectMilestones:42.abc': JSON.stringify({ key: 'projectMilestones:42', value: JSON.stringify([{ id: 'm1', text: 'lost milestone' }]), lostAt: 1700000000000 }),
    'metaConflictBackup.tomatoEstimateState.def': JSON.stringify({ key: 'tomatoEstimateState', value: '{"t9":12}', lostAt: 1700000001000 }),
    'metaConflictBackup.corrupt.ghi': 'not-json{',
    'projectMilestones:42': JSON.stringify([{ id: 'm2', text: 'peer version' }]),
    'unrelated': 'keep',
  }))
  const calls = []
  const dbCall = () => (op, p) => {
    calls.push({ op, p })
    if (op === 'listMetaKeys') return [...meta.keys()]
    if (op === 'getMeta') return meta.has(String(p)) ? meta.get(String(p)) : null
    if (op === 'setMeta') { meta.set(String(p[0]), p[1]); return true }
    if (op === 'deleteMeta') { meta.delete(String(p)); return true }
    throw new Error('unexpected op ' + op)
  }
  return { ops: scb.ops(dbCall), meta, calls }
}

test('X4 list: only metaConflictBackup.* keys, payload shape {key, originalKey, lostAt, preview}, unreadable payloads skipped', () => {
  const { ops } = fixture()
  const list = ops.syncConflictBackupsList()
  assert.equal(list.length, 2, 'corrupt backup and non-backup keys are skipped')
  const m1 = list.find(b => b.key === 'metaConflictBackup.projectMilestones:42.abc')
  assert.equal(m1.originalKey, 'projectMilestones:42')
  assert.equal(m1.lostAt, 1700000000000)
  assert.ok(m1.preview.includes('lost milestone'))
  assert.ok(!('value' in m1), 'full value is NOT exposed, only the preview')
})

test('X4 list: preview is truncated at 200 chars', () => {
  const meta = new Map([['metaConflictBackup.big.k', JSON.stringify({ key: 'big', value: 'x'.repeat(500), lostAt: 1 })]])
  const ops = scb.ops(() => (op, p) => op === 'listMetaKeys' ? [...meta.keys()] : op === 'getMeta' ? meta.get(String(p)) : null)
  const [b] = ops.syncConflictBackupsList()
  assert.equal(b.preview.length, 200)
})

test('X4 restore: re-applies lost value to the original key, re-backs-up the current live value, deletes the backup key', () => {
  const { ops, meta } = fixture()
  const r = ops.syncConflictBackupRestore({ key: 'metaConflictBackup.projectMilestones:42.abc' })
  assert.deepEqual(r, { ok: true, key: 'projectMilestones:42' })
  assert.equal(meta.get('projectMilestones:42'), JSON.stringify([{ id: 'm1', text: 'lost milestone' }]), 'lost value restored to the original key')
  assert.equal(meta.has('metaConflictBackup.projectMilestones:42.abc'), false, 'consumed backup key deleted')
  const rebackups = [...meta.keys()].filter(k => k.startsWith('metaConflictBackup.projectMilestones:42.'))
  assert.equal(rebackups.length, 1, 'the PREVIOUS live value (peer version) was re-backed-up first — restore is reversible')
  const rb = JSON.parse(meta.get(rebackups[0]))
  assert.equal(rb.key, 'projectMilestones:42')
  assert.deepEqual(JSON.parse(rb.value), [{ id: 'm2', text: 'peer version' }])
})

test('X4 restore guards: rejects non-backup keys and unreadable payloads without touching meta', () => {
  const { ops, meta } = fixture()
  const before = new Map(meta)
  assert.throws(() => ops.syncConflictBackupRestore({ key: 'projectMilestones:42' }), /not a metaConflictBackup key/)
  assert.throws(() => ops.syncConflictBackupRestore({ key: 'metaConflictBackup.corrupt.ghi' }), /unreadable/)
  assert.deepEqual([...meta.entries()], [...before.entries()], 'failed restores mutate nothing')
})
