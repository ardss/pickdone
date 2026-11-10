// G2 first-screen four-zone classifier — contract: docs/design/ux-contract-20261110.md §4.
// Zones in fixed order: 1 push-now, 2 waiting-on-me, 3 agent-working, 4 blocked/conflict.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyFirstScreen } from '../src/firstscreen.js'

const TODAY = 20261110
const base = { complete: 0, deleted: 0, scheduledDay: TODAY, description: '' }

function task(over = {}) { return { id: over.id || 't' + Math.random(), content: 'Task', ...base, ...over } }

test('zone 1 push-now: today queue tasks with a next action land in zone 1', () => {
  const r = classifyFirstScreen({
    tasks: [task({ id: 'a', description: 'Draft outline' }), task({ id: 'b' })],
    episodes: [], conflicts: [], syncError: '', today: TODAY,
  })
  assert.equal(r.push.total, 2)
  assert.equal(r.push.rows[0].id, 'a')
  assert.equal(r.push.rows[0].nextAction, 'Draft outline')
  assert.equal(r.push.rows[1].nextAction, '')
})

test('zone 1 excludes completed, deleted and future-scheduled tasks', () => {
  const r = classifyFirstScreen({
    tasks: [task({ id: 'x', complete: 1 }), task({ id: 'y', deleted: 1 }), task({ id: 'z', scheduledDay: 20261111 })],
    episodes: [], conflicts: [], today: TODAY,
  })
  assert.equal(r.push.total, 0)
  assert.equal(r.push.rows.length, 0)
})

test('zone 1 caps at 5 visible rows and reports the hidden count', () => {
  const tasks = Array.from({ length: 8 }, (_, i) => task({ id: 'c' + i }))
  const r = classifyFirstScreen({ tasks, episodes: [], conflicts: [], today: TODAY })
  assert.equal(r.push.rows.length, 5)
  assert.equal(r.push.total, 8)
  assert.equal(r.push.hidden, 3)
  const all = classifyFirstScreen({ tasks, episodes: [], conflicts: [], today: TODAY, showAll: true })
  assert.equal(all.push.rows.length, 8)
  assert.equal(all.push.hidden, 0)
})

test('zone 2 waiting-on-me: verbatim handoff fields addressed to this device, unacked', () => {
  const r = classifyFirstScreen({
    tasks: [
      task({ id: 'h1', handoffTo: 'android-1', handoffFrom: 'desktop-main', handoffNote: 'took over mid-way' }),
      task({ id: 'h2', handoffTo: 'android-1', handoffFrom: 'desktop-main', handoffAckedAt: 123 }),
      task({ id: 'h3', handoffTo: 'other-device' }),
    ],
    episodes: [], conflicts: [], today: TODAY, deviceId: 'android-1',
  })
  assert.equal(r.waiting.rows.length, 1)
  assert.equal(r.waiting.rows[0].id, 'h1')
  assert.equal(r.waiting.rows[0].from, 'desktop-main')
})

test('zone 3 agent-working: live agent episode (open-ended, actorType/role agent)', () => {
  const now = Date.now()
  const r = classifyFirstScreen({
    tasks: [task({ id: 'ag' })],
    episodes: [
      { id: 'e1', taskId: 'ag', actorType: 'agent', agentId: 'coder-x', startedAt: now - 60000, endedAt: 0 },
      { id: 'e2', taskId: 'ag', actorType: 'human', startedAt: now - 60000, endedAt: 0 },
      { id: 'e3', taskId: 'ag', role: 'agent', startedAt: now - 60000, endedAt: now },
    ],
    conflicts: [], today: TODAY,
  })
  assert.equal(r.agent.rows.length, 1)
  assert.equal(r.agent.rows[0].id, 'e1')
  assert.equal(r.agent.rows[0].agentId, 'coder-x')
})

test('overlap precedence: blocked > agent > waiting > push (a task never appears in two zones)', () => {
  const now = Date.now()
  const r = classifyFirstScreen({
    tasks: [
      task({ id: 'w', handoffTo: 'android-1' }),
      task({ id: 'g', handoffTo: 'android-1' }),
    ],
    episodes: [{ id: 'eg', taskId: 'g', actorType: 'agent', startedAt: now - 1, endedAt: 0 }],
    conflicts: [], today: TODAY, deviceId: 'android-1',
  })
  const pushIds = r.push.rows.map(row => row.id)
  assert.ok(!pushIds.includes('w'), 'handoff-claimed task sits in zone 2, not zone 1')
  assert.ok(!pushIds.includes('g'), 'agent-claimed task sits in zone 3, not zone 1')
  assert.deepEqual(r.waiting.rows.map(row => row.id), ['w'])
  assert.equal(r.agent.rows.length, 1)
})

test('zone 4 blocked: sync conflicts become blocker rows with one next-step action', () => {
  const r = classifyFirstScreen({
    tasks: [], episodes: [],
    conflicts: [{ entity: 'todos', id: 'k1', title: 'Shared task', verdict: 'conflict_edit_wins' }],
    today: TODAY,
  })
  assert.equal(r.blocked.rows.length, 1)
  assert.equal(r.blocked.rows[0].kind, 'conflict')
  assert.match(r.blocked.rows[0].title, /Shared task/)
  assert.ok(r.blocked.rows[0].action, 'every blocker row names exactly one next-step action')
})

test('zone 4 blocked: a sync error is a blocker row', () => {
  const r = classifyFirstScreen({ tasks: [], episodes: [], conflicts: [], syncError: 'failed to connect after 12000ms', today: TODAY })
  assert.equal(r.blocked.rows.length, 1)
  assert.equal(r.blocked.rows[0].kind, 'sync-error')
})

test('zone 4 zero state is an explicit healthy confirmation with last sync time', () => {
  const r = classifyFirstScreen({ tasks: [], episodes: [], conflicts: [], syncError: '', lastSyncAt: 1699999999999, today: TODAY })
  assert.equal(r.blocked.rows.length, 0)
  assert.equal(r.blocked.healthy, true)
  assert.equal(r.blocked.lastSyncAt, 1699999999999)
  const noSync = classifyFirstScreen({ tasks: [], episodes: [], conflicts: [], syncError: '', lastSyncAt: 0, today: TODAY })
  assert.equal(noSync.blocked.healthy, true)
  assert.equal(noSync.blocked.lastSyncAt, 0)
})

test('zone order is fixed and zero-item zones collapse (empty rows arrays, headers stay)', () => {
  const r = classifyFirstScreen({ tasks: [task({ id: 'only' })], episodes: [], conflicts: [], today: TODAY })
  assert.deepEqual(r.zones, ['push', 'waiting', 'agent', 'blocked'])
  assert.equal(r.waiting.rows.length, 0)
  assert.equal(r.agent.rows.length, 0)
  assert.equal(r.blocked.rows.length, 0)
  assert.equal(r.blocked.healthy, true)
})
