/**
 * lib-work — pd20 (2026-11-05) P0-4: the external-agent SAME-SOURCE work interface.
 *
 * `work <taskId>` and its sub-commands expose the task's work-handoff state through the SAME
 * authorized doors the app itself uses — no second task database, no raw SQLite/shell exposure:
 *   - reads go through db.call('queryEpisodesByTask' / 'querySourcesByTask') — the exact
 *     read-only whitelisted ops the renderer's EditPanel uses (single source, same view models);
 *   - writes go through the command bus (episode.put / source.put / tasksource.put — the ONE
 *     mutation door, manifest-validated, oplog-captured, LAN-synced since P0-3);
 *   - the handoff format is shared/handoff.mjs buildHandoff — the SAME pure function
 *     the EditPanel's Copy-Handoff buttons use (no second protocol; required via require(esm)).
 *
 * Contracts (mission P0-4):
 *   work <taskId>                       → get_task_context: {task, episodes, sources, handoff.json}
 *   work <taskId> episodes              → get_task_episodes: the episode list only
 *   work <taskId> handoff [--out DIR]   → export_handoff: markdown (+ --out writes .md + .json)
 *   work <taskId> add-episode           → record a work round (--goal required; --outcome/--next/--role)
 *   work <taskId> add-source            → link a provenance ref (--provider --uri --title)
 *   work <taskId> add-finding           → record an observed fact (--statement required;
 *                                         --confidence high|medium|low, --level
 *                                         observed|inferred|speculation, --refs, --by, --status)
 *   work <taskId> list-finding          → the finding list (view models)
 *   work <taskId> add-decision          → record a choice (--choice required; --alternatives a|b,
 *                                         --tradeoffs x|y, --decider, --rationale, --findings ids,
 *                                         --supersedes decisionId)
 *   work <taskId> list-decision         → the decision list (with supersedes/supersededBy)
 *
 * English-only output (CLI doctrine). --json emits structured results for agent consumption.
 */
const fs = require('fs')
const path = require('path')
const { buildHandoff } = require('../shared/handoff.mjs') // require(esm), Node >= 22 — single source with the renderer (packaged extraResources ships shared/, NOT renderer/ source)

// The note field serializes the three form fields with the SAME round-trip the EditPanel uses
// (renderer EditPanelWork.noteFromForm) — plain notes stay legible as the goal line.
function noteFromFields (goal, outcome, nextAction) {
  if (!outcome && !nextAction) return goal
  return 'goal: ' + goal + '\noutcome: ' + outcome + '\nnextAction: ' + nextAction
}

// Parse the storage note back into the three fields (same regexes as EditPanelWork.parseNote —
// the serialization is the shared contract, duplicated HERE only because the renderer module is
// an SFC-adjacent component file, not importable from pure Node without the vue toolchain).
function parseNote (note) {
  const s = String(note || '')
  const grab = (re) => { const m = s.match(re); return m ? m[1].trim() : '' }
  const goal = grab(/(?:^|\n)goal:[ \t]*([\s\S]*?)(?=\noutcome:|\nnextAction:|$)/)
  if (!goal) return { goal: s, outcome: '', nextAction: '' }
  return { goal, outcome: grab(/(?:^|\n)outcome:[ \t]*([\s\S]*?)(?=\noutcome:|\nnextAction:|$)/), nextAction: grab(/(?:^|\n)nextAction:[ \t]*([\s\S]*?)(?=\noutcome:|\nnextAction:|$)/) }
}

function loadContext (lib, taskIdRef) {
  const t = lib.resolveTask(taskIdRef)
  const db = lib.open()
  const episodes = db.call('queryEpisodesByTask', t.taskId) || []
  const sources = db.call('querySourcesByTask', t.taskId) || []
  // pd20 S1 closure (2026-11-10): the observed facts and the decisions made from them are part
  // of the context an agent needs — same read-only whitelisted db.call doors as episodes/sources.
  const findings = db.call('queryFindingsByTask', t.taskId) || []
  const decisions = db.call('queryDecisionsByTask', t.taskId) || []
  // pd20 P0-6 (2026-11-05): the hierarchy composes — phases/subtasks stay the existing
  // todos.subtasks JSON (read via lib.parseSubs, the same parser the CLI subtask commands use);
  // the context shows them read-only alongside the execution record (episodes) so an agent
  // sees 大任务 → 子任务 → 执行记录 in ONE same-source view. No write-back path here: subtask
  // writes stay in the existing authorized subtask commands (add/check/rm).
  let subtasks = []
  try { subtasks = lib.parseSubs(t) || [] } catch { /* legacy/unparsable subtask JSON: present as empty, never block the context */ }
  const handoffEpisodes = episodes.map(ep => {
    const f = parseNote(ep.summary)
    return {
      startedAt: ep.startedAt ? new Date(ep.startedAt).toISOString() : '',
      // pd20 (2026-11-08): real attribution (human/agent/qa) — the A→B→QA loop is visible in
      // the handoff; queryEpisodesByTask already falls back to 'human' for legacy NULL rows.
      role: ep.role || 'human',
      goal: f.goal,
      outcome: f.outcome,
      nextAction: f.nextAction
    }
  })
  // The handoff carries findings/decisions (buildHandoff's optional 4th/5th inputs) so the
  // receiver sees the observed facts and the choices — not just episode prose.
  const handoff = buildHandoff(handoffEpisodes, sources, { id: t.taskId, title: t.taskContent || t.content || '' }, findings, decisions)
  return { task: t, subtasks, episodes, sources, findings, decisions, handoff }
}

function runWork ({ opts, lib, emit }) {
  if (!opts._[0]) throw new lib.CliError('usage: work <taskId|keyword> [episodes|handoff|add-episode|add-source] [options]', 'USAGE')
  const taskIdRef = opts._[0]
  const sub = opts._[1] || 'context'

  if (sub === 'context') {
    // get_task_context: everything a fresh agent needs to take the task over WITHOUT reading
    // the chat history: the task row, the full work history, linked provenance, and the
    // ready-to-paste handoff (both formats).
    const { task, subtasks, episodes, sources, findings, decisions, handoff } = loadContext(lib, taskIdRef)
    if (opts.json) {
      return emit({ task, subtasks, episodes, sources, findings, decisions, handoff: handoff.json, handoffMarkdown: handoff.text })
    }
    console.log(JSON.stringify({ task, subtasks, episodes, sources, findings, decisions, handoff: handoff.json, handoffMarkdown: handoff.text }, null, 2))
    return
  }

  if (sub === 'episodes') {
    const { episodes } = loadContext(lib, taskIdRef)
    if (opts.json) return emit(episodes)
    if (!episodes.length) return console.log('(no episodes)')
    console.log(episodes.map(e => {
      const f = parseNote(e.summary)
      const bits = [e.episodeId, e.startedAt ? new Date(e.startedAt).toISOString() : '(no start)', '[' + (e.role || 'human') + ']']
      if (f.goal) bits.push('goal: ' + f.goal)
      if (f.outcome) bits.push('outcome: ' + f.outcome)
      if (f.nextAction) bits.push('next: ' + f.nextAction)
      return bits.join('\t')
    }).join('\n'))
    return
  }

  if (sub === 'handoff') {
    const { handoff } = loadContext(lib, taskIdRef)
    if (opts.out != null && opts.out !== true) {
      // export_handoff file form: writes <out>/handoff.md + handoff.json (agent-consumable pair)
      const dir = opts.out
      fs.mkdirSync(dir, { recursive: true })
      const mdPath = path.join(dir, 'handoff.md')
      const jsonPath = path.join(dir, 'handoff.json')
      fs.writeFileSync(mdPath, handoff.text, 'utf8')
      fs.writeFileSync(jsonPath, JSON.stringify(handoff.json, null, 2), 'utf8')
      if (opts.json) return emit({ markdown: mdPath, json: jsonPath })
      console.log('wrote ' + mdPath + '\nwrote ' + jsonPath)
      return
    }
    if (opts.json) return emit(handoff)
    process.stdout.write(handoff.text + '\n')
    return
  }

  if (sub === 'add-episode') {
    const goal = opts.goal != null && opts.goal !== true ? String(opts.goal) : ''
    if (!goal) throw new lib.CliError('--goal=<text> is required (what this work round set out to do)', 'USAGE')
    const outcome = opts.outcome != null && opts.outcome !== true ? String(opts.outcome) : ''
    const nextAction = opts.next != null && opts.next !== true ? String(opts.next) : ''
    // pd20 (2026-11-08): --role=<human|agent|qa> — WHO produced this round (the A→B→QA loop).
    // Storage guards the family (out-of-family → NULL), but rejecting here gives the caller an
    // explicit CLI error instead of a silently-unattributed row.
    const role = opts.role != null && opts.role !== true ? String(opts.role) : ''
    if (role && !['human', 'agent', 'qa'].includes(role)) {
      throw new lib.CliError('--role must be one of: human, agent, qa', 'USAGE')
    }
    const t = lib.resolveTask(taskIdRef)
    // The ONE mutation door: manifest-validated bus commit — the row is oplog-captured and
    // (since pd20 P0-3) LAN-synced to the paired device. Bus stamps updatedAt (LWW age).
    const id = lib.commit('episode', 'put', {
      taskId: t.taskId,
      startedAt: Date.now(),
      note: noteFromFields(goal, outcome, nextAction),
      ...(role ? { role } : {})
    })
    const hints = ['work ' + t.taskId + ' episodes to read back', 'work ' + t.taskId + ' handoff --out <dir> to export']
    const result = { episodeId: id, taskId: t.taskId, goal, outcome, nextAction }
    if (opts.json) return emit(result)
    console.log('episode ' + id + ' recorded on task ' + t.taskId + '\n  ' + hints.join('\n  '))
    return
  }

  if (sub === 'add-source') {
    const uri = opts.uri != null && opts.uri !== true ? String(opts.uri) : ''
    if (!uri) throw new lib.CliError('--uri=<url-or-path> is required', 'USAGE')
    const provider = opts.provider != null && opts.provider !== true ? String(opts.provider) : (uri.startsWith('http://') || uri.startsWith('https://') ? 'web' : 'file')
    const title = opts.title != null && opts.title !== true ? String(opts.title) : ''
    const t = lib.resolveTask(taskIdRef)
    // sourcePut dedupes by (providerId, externalId) pair — a re-link never duplicates.
    const refId = lib.commit('source', 'put', { providerId: provider, externalId: uri, title: title || null })
    const linkId = lib.commit('tasksource', 'put', { taskId: t.taskId, sourceRefId: refId })
    const result = { sourceRefId: refId, linkId, taskId: t.taskId, provider, uri, title }
    if (opts.json) return emit(result)
    console.log('source ' + refId + ' linked to task ' + t.taskId + ' (link ' + linkId + ')')
    return
  }

  if (sub === 'add-finding') {
    const statement = opts.statement != null && opts.statement !== true ? String(opts.statement) : ''
    if (!statement) throw new lib.CliError('--statement=<text> is required (the OBSERVED fact — not a guess)', 'USAGE')
    // Family-guarded here too: the storage layer stores out-of-family values as NULL, but an
    // explicit CLI rejection tells the agent caller immediately instead of a silently-unknown row.
    const confidence = opts.confidence != null && opts.confidence !== true ? String(opts.confidence) : ''
    if (confidence && !['high', 'medium', 'low'].includes(confidence)) {
      throw new lib.CliError('--confidence must be one of: high, medium, low', 'USAGE')
    }
    const level = opts.level != null && opts.level !== true ? String(opts.level) : ''
    if (level && !['observed', 'inferred', 'speculation'].includes(level)) {
      throw new lib.CliError('--level must be one of: observed, inferred, speculation', 'USAGE')
    }
    const status = opts.status != null && opts.status !== true ? String(opts.status) : ''
    if (status && !['open', 'confirmed', 'retracted'].includes(status)) {
      throw new lib.CliError('--status must be one of: open, confirmed, retracted', 'USAGE')
    }
    // THE MISSION RULE surfaced at the CLI door as well: a speculation cannot be confirmed.
    if (level === 'speculation' && status === 'confirmed') {
      throw new lib.CliError('a speculation cannot be confirmed — an unverified guess is never an acceptance conclusion (storage normalizes this to open)', 'USAGE')
    }
    const t = lib.resolveTask(taskIdRef)
    const id = lib.commit('finding', 'put', {
      taskId: t.taskId,
      statement,
      ...(confidence ? { confidence } : {}),
      ...(level ? { verificationLevel: level } : {}),
      ...(status ? { status } : {}),
      createdBy: opts.by != null && opts.by !== true ? String(opts.by) : 'cli',
      ...(opts.refs != null && opts.refs !== true ? { sourceRefs: String(opts.refs).split(',').map(x => x.trim()).filter(Boolean) } : {})
    })
    const result = { findingId: id, taskId: t.taskId, statement, confidence: confidence || null, verificationLevel: level || null, status: status || 'open' }
    if (opts.json) return emit(result)
    console.log('finding ' + id + ' recorded on task ' + t.taskId + '\n  work ' + t.taskId + ' list-finding to read back')
    return
  }
  if (sub === 'list-finding') {
    const { findings } = loadContext(lib, taskIdRef)
    if (opts.json) return emit(findings)
    if (!findings.length) return console.log('(no findings)')
    console.log(findings.map(f => {
      const bits = [f.findingId, '[' + f.verificationLevel + '/' + f.confidence + ']', '(' + f.status + ')', f.statement]
      if (f.createdBy) bits.push('by ' + f.createdBy)
      if (f.sourceRefs && f.sourceRefs.length) bits.push('refs: ' + f.sourceRefs.join(','))
      return bits.join('\t')
    }).join('\n'))
    return
  }
  if (sub === 'add-decision') {
    const choice = opts.choice != null && opts.choice !== true ? String(opts.choice) : ''
    if (!choice) throw new lib.CliError('--choice=<text> is required (what was decided)', 'USAGE')
    const splitList = v => v != null && v !== true ? String(v).split('|').map(x => x.trim()).filter(Boolean) : null
    const t = lib.resolveTask(taskIdRef)
    const id = lib.commit('decision', 'put', {
      taskId: t.taskId,
      choice,
      ...(splitList(opts.alternatives) ? { alternatives: splitList(opts.alternatives) } : {}),
      ...(splitList(opts.tradeoffs) ? { tradeoffs: splitList(opts.tradeoffs) } : {}),
      decider: opts.decider != null && opts.decider !== true ? String(opts.decider) : 'cli',
      ...(opts.rationale != null && opts.rationale !== true ? { rationale: String(opts.rationale) } : {}),
      // --findings <id,id>: the relatedFindings back-references (evidence the choice rests on)
      ...(opts.findings != null && opts.findings !== true ? { relatedFindings: String(opts.findings).split(',').map(x => x.trim()).filter(Boolean) } : {}),
      // --supersedes <decisionId>: the revocable relation — this choice REPLACES that one
      ...(opts.supersedes != null && opts.supersedes !== true ? { supersedes: String(opts.supersedes) } : {})
    })
    const result = { decisionId: id, taskId: t.taskId, choice, decider: (opts.decider != null && opts.decider !== true ? String(opts.decider) : 'cli') }
    if (opts.json) return emit(result)
    console.log('decision ' + id + ' recorded on task ' + t.taskId + '\n  work ' + t.taskId + ' list-decision to read back')
    return
  }
  if (sub === 'list-decision') {
    const { decisions } = loadContext(lib, taskIdRef)
    if (opts.json) return emit(decisions)
    if (!decisions.length) return console.log('(no decisions)')
    console.log(decisions.map(d => {
      const bits = [d.decisionId, d.choice]
      if (d.decider) bits.push('decider: ' + d.decider)
      if (d.alternatives && d.alternatives.length) bits.push('alts: ' + d.alternatives.join(' | '))
      if (d.rationale) bits.push('rationale: ' + d.rationale)
      if (d.supersedes) bits.push('supersedes: ' + d.supersedes)
      if (d.supersededBy && d.supersededBy.length) bits.push('supersededBy: ' + d.supersededBy.join(','))
      return bits.join('\t')
    }).join('\n'))
    return
  }
  throw new lib.CliError(`unknown work sub-command: ${sub} (context | episodes | handoff | add-episode | add-source | add-finding | list-finding | add-decision | list-decision)`, 'USAGE')
}

module.exports = { runWork, loadContext, parseNote, noteFromFields }
