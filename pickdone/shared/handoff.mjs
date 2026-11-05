/**
 * buildHandoff — S2 slice pure function (zero dependencies).
 * Assembles a session handoff from authoritative inputs: episodes (human/agent turns),
 * sources (L0..Ln provenance with canonicalUri), and the task record.
 * Returns { text, json }. Pure read-side assembly: no DB writes, no IPC, no mutation
 * of the inputs (episodes are copied before sorting by startedAt ascending).
 * Empty episodes -> 'no episodes' placeholder in text; json keeps an empty array.
 */

function normalizeEpisode(e) {
  return {
    startedAt: e?.startedAt ?? '',
    role: e?.role ?? 'unknown',
    goal: e?.goal ?? '',
    outcome: e?.outcome ?? '',
    nextAction: e?.nextAction ?? '',
  }
}

function normalizeSource(s) {
  return {
    level: s?.level ?? 'L0',
    canonicalUri: s?.canonicalUri ?? '',
  }
}

export function buildHandoff(episodes, sources, task) {
  const eps = Array.isArray(episodes) ? episodes : []
  const sorted = eps
    .map(normalizeEpisode)
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
  const srcs = (Array.isArray(sources) ? sources : []).map(normalizeSource)

  const json = {
    task: {
      id: task?.id ?? null,
      title: task?.title ?? '',
    },
    episodes: sorted,
    sources: srcs,
  }

  const lines = []
  lines.push('# Handoff')
  lines.push(`Task: ${json.task.title || '(untitled)'}${json.task.id ? ` [${json.task.id}]` : ''}`)

  if (sorted.length === 0) {
    lines.push('Episodes: no episodes recorded.')
  } else {
    lines.push('Episodes:')
    for (const e of sorted) {
      lines.push(`- [${e.startedAt}] (${e.role})`)
      lines.push(`  goal: ${e.goal}`)
      lines.push(`  outcome: ${e.outcome}`)
      lines.push(`  nextAction: ${e.nextAction}`)
    }
  }

  if (srcs.length > 0) {
    lines.push('Sources:')
    for (const s of srcs) {
      lines.push(`- [${s.level}] ${s.canonicalUri}`)
    }
  }

  return { text: lines.join('\n'), json }
}

export default buildHandoff
