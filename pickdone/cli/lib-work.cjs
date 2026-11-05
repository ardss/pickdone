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
 *   work <taskId> add-episode           → record a work round (--goal required; --outcome/--next)
 *   work <taskId> add-source            → link a provenance ref (--provider --uri --title)
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
      role: 'human',
      goal: f.goal,
      outcome: f.outcome,
      nextAction: f.nextAction
    }
  })
  const handoff = buildHandoff(handoffEpisodes, sources, { id: t.taskId, title: t.taskContent || t.content || '' })
  return { task: t, subtasks, episodes, sources, handoff }
}

function runWork ({ opts, lib, emit }) {
  if (!opts._[0]) throw new lib.CliError('usage: work <taskId|keyword> [episodes|handoff|add-episode|add-source] [options]', 'USAGE')
  const taskIdRef = opts._[0]
  const sub = opts._[1] || 'context'

  if (sub === 'context') {
    // get_task_context: everything a fresh agent needs to take the task over WITHOUT reading
    // the chat history: the task row, the full work history, linked provenance, and the
    // ready-to-paste handoff (both formats).
    const { task, subtasks, episodes, sources, handoff } = loadContext(lib, taskIdRef)
    if (opts.json) {
      return emit({ task, subtasks, episodes, sources, handoff: handoff.json, handoffMarkdown: handoff.text })
    }
    console.log(JSON.stringify({ task, subtasks, episodes, sources, handoff: handoff.json, handoffMarkdown: handoff.text }, null, 2))
    return
  }

  if (sub === 'episodes') {
    const { episodes } = loadContext(lib, taskIdRef)
    if (opts.json) return emit(episodes)
    if (!episodes.length) return console.log('(no episodes)')
    console.log(episodes.map(e => {
      const f = parseNote(e.summary)
      const bits = [e.episodeId, e.startedAt ? new Date(e.startedAt).toISOString() : '(no start)']
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
    const t = lib.resolveTask(taskIdRef)
    // The ONE mutation door: manifest-validated bus commit — the row is oplog-captured and
    // (since pd20 P0-3) LAN-synced to the paired device. Bus stamps updatedAt (LWW age).
    const id = lib.commit('episode', 'put', {
      taskId: t.taskId,
      startedAt: Date.now(),
      note: noteFromFields(goal, outcome, nextAction)
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

  throw new lib.CliError(`unknown work sub-command: ${sub} (context | episodes | handoff | add-episode | add-source)`, 'USAGE')
}

module.exports = { runWork, loadContext, parseNote, noteFromFields }
