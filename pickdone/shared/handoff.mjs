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

import { sourceFreshness } from './source-freshness.mjs'

function normalizeSource(s) {
  // pd20 P0 (2026-11-07): verification state rides along (single semantics source:
  // shared/source-freshness.cjs). A handoff consumer must SEE when a ref is unverified
  // ('unknown') or aged-out ('stale') instead of trusting it silently.
  const at = Number(s?.lastVerifiedAt) || 0
  return {
    level: s?.level ?? 'L0',
    canonicalUri: s?.canonicalUri ?? '',
    lastVerifiedAt: at,
    freshness: s?.freshness ?? sourceFreshness({ lastVerifiedAt: at }, Date.now()),
  }
}

// pd20 S1 closure (2026-11-10): findings/decisions ride the handoff (optional 4th/5th inputs,
// backwards compatible — existing two/three-arg callers keep the same output plus nothing).
// Normalizers are honest: unknown fields read '' / [], never fabricated.
function normalizeFinding(f) {
  return {
    findingId: f?.findingId ?? '',
    statement: f?.statement ?? '',
    confidence: f?.confidence ?? 'unknown',
    verificationLevel: f?.verificationLevel ?? 'unknown',
    status: f?.status ?? 'open',
    createdBy: f?.createdBy ?? '',
    ts: f?.ts ?? 0,
    sourceRefs: Array.isArray(f?.sourceRefs) ? f.sourceRefs : [],
  }
}

function normalizeDecision(d) {
  return {
    decisionId: d?.decisionId ?? '',
    choice: d?.choice ?? '',
    alternatives: Array.isArray(d?.alternatives) ? d.alternatives : [],
    tradeoffs: Array.isArray(d?.tradeoffs) ? d.tradeoffs : [],
    decider: d?.decider ?? '',
    rationale: d?.rationale ?? '',
    relatedFindings: Array.isArray(d?.relatedFindings) ? d.relatedFindings : [],
    supersedes: d?.supersedes ?? null,
    supersededBy: Array.isArray(d?.supersededBy) ? d.supersededBy : [],
    ts: d?.ts ?? 0,
  }
}

export function buildHandoff(episodes, sources, task, findings, decisions) {
  const eps = Array.isArray(episodes) ? episodes : []
  const sorted = eps
    .map(normalizeEpisode)
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
  const srcs = (Array.isArray(sources) ? sources : []).map(normalizeSource)
  // pd20 S1 closure: the observed facts and the choices made from them travel WITH the handoff
  // — an agent taking over must not rebuild context from episode prose alone. A speculation
  // finding carries its verificationLevel verbatim, so the receiver can SEE it is a guess
  // (the storage layer already blocked it from ever being 'confirmed').
  const fnds = (Array.isArray(findings) ? findings : []).map(normalizeFinding)
  const decs = (Array.isArray(decisions) ? decisions : []).map(normalizeDecision)

  const json = {
    task: {
      id: task?.id ?? null,
      title: task?.title ?? '',
    },
    episodes: sorted,
    sources: srcs,
    findings: fnds,
    decisions: decs,
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
      const state = s.freshness === 'fresh' ? 'verified' : s.freshness
      lines.push(`- [${s.level}] ${s.canonicalUri} (${state})`)
    }
  }

  if (fnds.length > 0) {
    lines.push('Findings:')
    for (const f of fnds) {
      lines.push(`- [${f.verificationLevel}/${f.confidence}] (${f.status}) ${f.statement} — by ${f.createdBy || 'unknown'}`)
    }
  }

  if (decs.length > 0) {
    lines.push('Decisions:')
    for (const d of decs) {
      lines.push(`- ${d.choice} (decider: ${d.decider || 'unknown'})`)
      if (d.alternatives.length > 0) lines.push(`  alternatives: ${d.alternatives.join(' | ')}`)
      if (d.tradeoffs.length > 0) lines.push(`  tradeoffs: ${d.tradeoffs.join(' | ')}`)
      if (d.rationale) lines.push(`  rationale: ${d.rationale}`)
      if (d.supersedes) lines.push(`  supersedes: ${d.supersedes}`)
    }
  }

  return { text: lines.join('\n'), json }
}

export default buildHandoff
