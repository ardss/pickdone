// G2 mobile first-screen four-zone classifier (contract §4, normative).
// Pure function — no Vue, no transport, no DB. Input is whatever the real data
// doors already produce: repository rows (todos/work_episodes), sync-cycle
// conflicts and the last sync outcome.
//
// Field reality (honest, 2026-11-10): the bridge DTO contract (mobile/src/sync/
// pair-contract.js) carries todos {title, description, scheduled*, ...} and
// episodes {summary, startedAt, endedAt} only. Handoff targeting fields
// (handoffTo/handoffFrom/handoffAckedAt) and agent-actor fields (actorType/
// agentId/role) are NOT yet in the DTO set — decoders carry unknown DTO fields
// verbatim (carryUnknown), so this classifier reads them if/when the desktop
// side starts emitting them. Until then zones 2 and 3 stay legitimately empty;
// this is the documented OPEN backend gap, not a fake-data substitute.
const PUSH_VISIBLE_MAX = 5
const isLive = row => !row?.deleted && !row?.delete && !row?.complete

function handoffOf(task, deviceId) {
  // Unacked handoff addressed to THIS device. handoffTo is the device the
  // desktop addressed; empty/absent means the DTO layer never carried it yet.
  if (!task || typeof task.handoffTo !== 'string' || !task.handoffTo) return null
  if (deviceId && task.handoffTo !== deviceId) return null
  if (task.handoffAckedAt) return null
  return { id: String(task.id), kind: 'handoff', from: String(task.handoffFrom || ''), note: String(task.handoffNote || ''), task }
}

function agentEpisodeOf(episode) {
  // Live = open-ended (endedAt falsy). Actor = explicit agent fields; the
  // desktop handoff model (shared/handoff.mjs) uses role, S1 episodes use
  // actorType — accept either, carried verbatim by the DTO decoders.
  if (!episode || Number(episode.endedAt || 0) > 0) return null
  const isAgent = episode.actorType === 'agent' || episode.role === 'agent'
  if (!isAgent) return null
  return { id: String(episode.id), kind: 'agent-episode', agentId: String(episode.agentId || episode.role || 'agent'), startedAt: Number(episode.startedAt || 0), note: String(episode.note || ''), episode }
}

/**
 * classifyFirstScreen({tasks, episodes, conflicts, syncError, lastSyncAt, today, showAll})
 * -> {
 *   zones: ['push','waiting','agent','blocked'],   // fixed order, contract §4
 *   push:    { rows, total, hidden },              // rows capped at 5 unless showAll
 *   waiting: { rows },
 *   agent:   { rows },
 *   blocked: { rows, healthy, lastSyncAt },        // healthy zero-state MUST be explicit
 * }
 */
export function classifyFirstScreen({ tasks = [], episodes = [], conflicts = [], syncError = '', lastSyncAt = 0, today, deviceId = '', showAll = false } = {}) {
  const blockedRows = []
  for (const conflict of conflicts || []) {
    const title = conflict.title || conflict.incoming?.content || conflict.incoming?.name || conflict.incoming?.note || conflict.id
    blockedRows.push({ id: 'conflict:' + conflict.entity + ':' + conflict.id, kind: 'conflict', entity: conflict.entity, refId: conflict.id, verdict: conflict.verdict, title: String(title), action: 'resolve-conflict' })
  }
  if (syncError) blockedRows.push({ id: 'sync-error', kind: 'sync-error', title: String(syncError), action: 'retry-sync' })

  const claimed = new Set(blockedRows.map(row => row.refId))
  const waitingRows = []
  const agentRows = []
  const pushRows = []
  const agentClaimedTasks = new Set()
  for (const episode of episodes || []) {
    const row = agentEpisodeOf(episode)
    if (row) { agentRows.push(row); agentClaimedTasks.add(String(episode.taskId)) }
  }
  for (const task of tasks || []) {
    if (!isLive(task)) continue
    const id = String(task.id)
    const handoff = handoffOf(task, deviceId)
    if (handoff && !agentClaimedTasks.has(id)) { waitingRows.push(handoff); claimed.add(id) }
  }
  for (const task of tasks || []) {
    if (!isLive(task)) continue
    const id = String(task.id)
    if (claimed.has(id) || agentClaimedTasks.has(id)) continue
    const day = Number(task.scheduledDay || 0)
    if (!day || day > Number(today)) continue
    pushRows.push({ id, kind: 'push', nextAction: String(task.description || '').trim(), task })
  }
  const visible = showAll ? pushRows : pushRows.slice(0, PUSH_VISIBLE_MAX)
  return {
    zones: ['push', 'waiting', 'agent', 'blocked'],
    push: { rows: visible, total: pushRows.length, hidden: showAll ? 0 : Math.max(0, pushRows.length - PUSH_VISIBLE_MAX) },
    waiting: { rows: waitingRows },
    agent: { rows: agentRows },
    blocked: { rows: blockedRows, healthy: blockedRows.length === 0, lastSyncAt: Number(lastSyncAt || 0) },
  }
}
