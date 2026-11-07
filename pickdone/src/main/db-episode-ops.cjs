/**
 * Work-episode / source-ref / task-source-link ops (S1 vertical slice, migration v11).
 * Split modeled on db-plan-ops.js: pure domain functions taking the db handle; db.js keeps
 * thin delegates in OPS so every db.call surface and return shape stays unchanged.
 *
 * Semantics shared with the plan-chip family:
 * - Puts are id-referenced upserts (ON CONFLICT(id) DO UPDATE) that restore tombstoned rows
 *   (deleted=0, deletedAt=0); an explicit updatedAt (the sync-apply path carries the peer row's
 *   age) is preserved verbatim — re-stamping it would break LWW; the command bus stamps
 *   updatedAt for local callers that send none (manifest lwwField).
 * - Removes are tombstones (deleted=1) that return the ids ACTUALLY changed (row-granular
 *   contract like planRemoveIds — a ghost or already-deleted id is a no-op and minted no
 *   phantom delta).
 * - source_refs / task_source_links carry pair-unique indexes; the put ops pre-check the pair
 *   so a colliding caller gets an EXPLICIT error naming the pair, not a bare SQLITE message.
 */
const mintId = prefix => prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
// pd20 P0 (2026-11-07): freshness semantics single source (also consumed by handoff export).
// shared/*.mjs is the repo convention — CJS consumes it via require(esm) (Node >= 22.12).
const { isKnownLevel, sourceFreshness } = require('../../shared/source-freshness.mjs')

// pd20 (2026-11-08): episode attribution family — WHO produced this work round. Closed set
// (human / agent / qa) so the handoff's A→B→QA loop is honest: an out-of-family value is a
// caller bug, not a role (stores NULL; NULL reads 'human' at the view layer — legacy rows and
// role-less callers were the human plain-note round-trip all along).
const KNOWN_ROLES = new Set(['human', 'agent', 'qa'])
exports.isKnownRole = r => KNOWN_ROLES.has(String(r))

// ---- work_episodes ----
exports.episodePut = (db, ep = {}) => {
  if (!ep || ep.taskId == null || ep.taskId === '') {
    throw new Error('[db-episode-ops] episodePut: taskId is required')
  }
  const id = ep.id != null && ep.id !== '' ? String(ep.id) : mintId('ep')
  const now = Date.now()
  db.prepare(`INSERT INTO work_episodes (id, taskId, startedAt, endedAt, note, role, deleted, deletedAt, updatedAt)
    VALUES (@id,@taskId,@startedAt,@endedAt,@note,@role,0,0,@updatedAt)
    ON CONFLICT(id) DO UPDATE SET taskId=excluded.taskId, startedAt=excluded.startedAt, endedAt=excluded.endedAt,
      note=excluded.note, role=excluded.role, deleted=0, deletedAt=0, updatedAt=excluded.updatedAt`)
    .run({
      id,
      taskId: String(ep.taskId),
      startedAt: Number(ep.startedAt) || 0,
      endedAt: Number(ep.endedAt) || 0,
      note: ep.note != null ? String(ep.note) : null,
      // pd20 (2026-11-08): attribution role — known family member verbatim, anything else NULL
      // (same-id put can CORRECT a role; NULL legacy rows keep NULL, never stamped to 'human').
      role: KNOWN_ROLES.has(String(ep.role)) ? String(ep.role) : null,
      updatedAt: Number(ep.updatedAt) > 0 ? Number(ep.updatedAt) : now
    })
  return id
}

// Items may be plain ids (renderer/CLI) or {id, deletedAt, updatedAt} tombstone stamps (sync apply).
exports.episodeRemoveIds = (db, ids, opts = {}) => removeByIds(db, 'work_episodes', ids, opts)

// Read-side (pd20 S3 'continue work' section): the EditPanel reads a task's episodes via
// dbCall('queryEpisodesByTask', taskId). The renderer's contract (editpanel-work pins) is a
// view model — {episodeId, summary, resources} — so the storage columns (id/note) are mapped
// HERE, once: the renderer never learns the row schema. Oldest startedAt first; tombstoned
// episodes and tombstoned links/refs are invisible. Read-only → no manifest row needed (same
// class as tomatoGetById); whitelisted for any renderer window in handlers/todo.js.
exports.queryEpisodesByTask = (db, taskId) => {
  if (taskId == null || taskId === '') return []
  const eps = db.prepare(
    'SELECT id, startedAt, endedAt, note, role FROM work_episodes WHERE taskId = @taskId AND deleted = 0 ORDER BY startedAt ASC, id ASC'
  ).all({ taskId: String(taskId) })
  const resources = db.prepare(
    'SELECT sr.title FROM task_source_links tsl JOIN source_refs sr ON sr.id = tsl.sourceRefId' +
    ' WHERE tsl.taskId = @taskId AND tsl.deleted = 0 AND sr.deleted = 0 ORDER BY sr.id ASC'
  ).all({ taskId: String(taskId) }).map(r => r.title || '').filter(Boolean)
  return eps.map(e => ({
    episodeId: e.id,
    startedAt: e.startedAt,
    endedAt: e.endedAt,
    summary: e.note || '',
    // pd20 (2026-11-08): real attribution for the handoff loop; NULL (legacy/omitted) reads
    // 'human' at the VIEW layer only — the storage row keeps NULL so a later correction is honest.
    role: KNOWN_ROLES.has(String(e.role)) ? String(e.role) : 'human',
    resources
  }))
}

// Read-side (pd20 handoff copy): the EditPanel 'continue work' section's Copy-Handoff button
// assembles the handoff from this task's linked source refs (buildHandoff's `sources` input:
// L0..Ln provenance rows with canonicalUri). Storage models a source as (providerId, externalId);
// the canonical URI is composed HERE, once — the renderer never learns the row schema (same
// doctrine as queryEpisodesByTask). Read-only → no manifest row needed; whitelisted alongside
// queryEpisodesByTask in handlers/todo.js.
exports.querySourcesByTask = (db, taskId) => {
  if (taskId == null || taskId === '') return []
  const now = Date.now()
  return db.prepare(
    'SELECT sr.id AS refId, sr.providerId, sr.externalId, sr.title, sr.level, sr.lastVerifiedAt, tsl.id AS linkId' +
    ' FROM task_source_links tsl JOIN source_refs sr ON sr.id = tsl.sourceRefId' +
    ' WHERE tsl.taskId = @taskId AND tsl.deleted = 0 AND sr.deleted = 0 ORDER BY sr.id ASC'
  ).all({ taskId: String(taskId) }).map(r => ({
    linkId: r.linkId,
    sourceRefId: r.refId,
    providerId: r.providerId,
    externalId: r.externalId,
    // Real provenance level + verification state (pd20 P0): NULL legacy level displays as the
    // L0 baseline; freshness degrades honestly (unknown / stale / fresh — source-freshness.cjs).
    level: isKnownLevel(r.level) ? String(r.level) : 'L0',
    lastVerifiedAt: Number(r.lastVerifiedAt) || 0,
    freshness: sourceFreshness(r, now),
    canonicalUri: String(r.providerId) + '://' + String(r.externalId),
    title: r.title || ''
  }))
}

// Read-side (pd20 P1-01 project overview work-handoff): per-task episode rollup for every LIVE,
// non-deleted todo of a category (Project = folder-category). One JOIN/GROUP BY for the counts +
// one batched episode fetch for the latest-note fields — no N+1 per task. The last goal/outcome/
// nextAction are parsed from the latest episode's single `note` column with the SAME round-trip
// doctrine as the EditPanelWork form (plain notes with no recognized field lines → the whole
// note IS the goal; outcome/nextAction stay ''). Returns { tasks, recent }: `tasks` is the
// per-task rollup array (tasks without episodes come back with episodeCount 0 / 0 timestamps /
// '' fields, INCLUDED — filtering them out is the RENDERER's toggle, never the storage layer's);
// `recent` is the project-level last-8 episodes (startedAt desc, time + goal one-liner).
// Read-only → no manifest row; whitelisted alongside
// queryEpisodesByTask in handlers/todo.js.
const parseNoteFields = note => {
  const s = String(note || '')
  const grab = re => { const m = s.match(re); return m ? m[1].trim() : '' }
  const goal = grab(/(?:^|\n)goal:[ \t]*([\s\S]*?)(?=\noutcome:|\nnextAction:|$)/)
  if (!goal) return { goal: s.trim(), outcome: '', nextAction: '' }
  return {
    goal,
    outcome: grab(/(?:^|\n)outcome:[ \t]*([\s\S]*?)(?=\noutcome:|\nnextAction:|$)/),
    nextAction: grab(/(?:^|\n)nextAction:[ \t]*([\s\S]*?)(?=\noutcome:|\nnextAction:|$)/)
  }
}

exports.queryEpisodesByCategory = (db, categoryId) => {
  if (categoryId == null || categoryId === '' || !isFinite(Number(categoryId))) return { tasks: [], recent: [], timeline: [] }
  const catId = Number(categoryId)
  const rollup = db.prepare(
    'SELECT t.id AS taskId, t.content AS taskContent, COUNT(e.id) AS episodeCount,' +
    ' MAX(e.startedAt) AS lastEpisodeAt' +
    ' FROM todos t LEFT JOIN work_episodes e ON e.taskId = t.id AND e.deleted = 0' +
    ' WHERE t.categoryId = @catId AND t.deleted = 0' +
    ' GROUP BY t.id ORDER BY lastEpisodeAt DESC, t.id ASC'
  ).all({ catId })
  if (!rollup.length) return { tasks: [], recent: [], timeline: [] }
  // Batched second pass: every live episode of these tasks (newest first) — the first hit per
  // taskId in JS is that task's latest episode, and the same list yields the project-level
  // recent-8. Two prepared statements total, no N+1 per task.
  const ids = rollup.map(r => r.taskId)
  const notes = db.prepare(
    'SELECT id, taskId, startedAt, note FROM work_episodes' +
    ' WHERE deleted = 0 AND taskId IN (' + ids.map(() => '?').join(',') + ')' +
    ' ORDER BY startedAt DESC, id DESC'
  ).all(...ids)
  const latest = new Map()
  const recent = []
  const timeline = []
  // pd20 P1 (2026-11-06): the full per-project episode stream (beyond the recent-8 rollup)
  // feeds the lightweight timeline view. The rows were already fetched; the cap only bounds
  // the wire shape of a pathological project, it is not a pagination contract.
  for (const row of notes) {
    if (!latest.has(row.taskId)) latest.set(row.taskId, row)
    const f = parseNoteFields(row.note)
    if (recent.length < 8) {
      recent.push({ episodeId: row.id, taskId: row.taskId, startedAt: row.startedAt || 0, goal: f.goal })
    }
    timeline.push({ episodeId: row.id, taskId: row.taskId, startedAt: row.startedAt || 0, goal: f.goal })
  }
  const tasks = rollup.map(r => {
    const hit = latest.get(String(r.taskId))
    const f = hit ? parseNoteFields(hit.note) : { goal: '', outcome: '', nextAction: '' }
    return {
      taskId: r.taskId,
      taskContent: r.taskContent || '',
      episodeCount: Number(r.episodeCount) || 0,
      lastEpisodeAt: r.lastEpisodeAt || 0,
      lastGoal: f.goal,
      lastOutcome: f.outcome,
      lastNextAction: f.nextAction
    }
  })
  return { tasks, recent, timeline }
}

// ---- source_refs ----
exports.sourcePut = (db, row = {}) => {
  if (!row || row.providerId == null || row.providerId === '' || row.externalId == null || row.externalId === '') {
    throw new Error('[db-episode-ops] sourcePut: providerId and externalId are required')
  }
  const id = row.id != null && row.id !== '' ? String(row.id) : mintId('src')
  const providerId = String(row.providerId)
  const externalId = String(row.externalId)
  const now = Date.now()
  // Pair-unique DEDUPE (j-pd20): put is an upsert by (providerId, externalId). A pair that
  // already exists — LIVE or TOMBSTONED — is reused (same id, deleted=0, title refreshed),
  // never duplicated; the UNIQUE index is the storage backstop for races. The renderer's
  // Link form has no way to know a prior ref's id, so erroring on a live pair would make the
  // ordinary unlink→re-link UI round-trip impossible (caught live by j-pd20-episode T4).
  const pair = db.prepare('SELECT id FROM source_refs WHERE providerId = ? AND externalId = ?').get(providerId, externalId)
  const rowId = pair ? pair.id : id
  db.prepare(`INSERT INTO source_refs (id, providerId, externalId, title, level, lastVerifiedAt, deleted, deletedAt, updatedAt)
    VALUES (@id,@providerId,@externalId,@title,@level,@lastVerifiedAt,0,0,@updatedAt)
    ON CONFLICT(id) DO UPDATE SET providerId=excluded.providerId, externalId=excluded.externalId, title=excluded.title,
      level=excluded.level, lastVerifiedAt=excluded.lastVerifiedAt,
      deleted=0, deletedAt=0, updatedAt=excluded.updatedAt`)
    .run({
      id: rowId, providerId, externalId,
      title: row.title != null ? String(row.title) : null,
      // Provenance verification state (pd20 P0, 2026-11-07): an out-of-family level stores as
      // NULL (never fabricate provenance — 'L9' is a caller bug, not an L9 source); a
      // non-positive stamp stores 0 (= never verified → reads 'unknown').
      level: isKnownLevel(row.level) ? String(row.level) : null,
      lastVerifiedAt: Number(row.lastVerifiedAt) > 0 ? Number(row.lastVerifiedAt) : 0,
      updatedAt: Number(row.updatedAt) > 0 ? Number(row.updatedAt) : now
    })
  return rowId
}

exports.sourceRemoveByIds = (db, ids, opts = {}) => removeByIds(db, 'source_refs', ids, opts)

// ---- task_source_links ----
exports.taskSourcePut = (db, row = {}) => {
  if (!row || row.taskId == null || row.taskId === '' || row.sourceRefId == null || row.sourceRefId === '') {
    throw new Error('[db-episode-ops] taskSourcePut: taskId and sourceRefId are required')
  }
  const id = row.id != null && row.id !== '' ? String(row.id) : mintId('tsl')
  const taskId = String(row.taskId)
  const sourceRefId = String(row.sourceRefId)
  const now = Date.now()
  // Same pair-unique dedupe as sourcePut: an existing (taskId, sourceRefId) pair — live or
  // tombstoned — is re-linked through the upsert's deleted=0 revive with the SAME id.
  const pair = db.prepare('SELECT id FROM task_source_links WHERE taskId = ? AND sourceRefId = ?').get(taskId, sourceRefId)
  const rowId = pair ? pair.id : id
  db.prepare(`INSERT INTO task_source_links (id, taskId, sourceRefId, deleted, deletedAt, updatedAt)
    VALUES (@id,@taskId,@sourceRefId,0,0,@updatedAt)
    ON CONFLICT(id) DO UPDATE SET taskId=excluded.taskId, sourceRefId=excluded.sourceRefId,
      deleted=0, deletedAt=0, updatedAt=excluded.updatedAt`)
    .run({ id: rowId, taskId, sourceRefId, updatedAt: Number(row.updatedAt) > 0 ? Number(row.updatedAt) : now })
  return rowId
}

exports.taskSourceRemove = (db, ids, opts = {}) => removeByIds(db, 'task_source_links', ids, opts)

// ---- raw row reads (pd20 LAN sync, 2026-11-05) ----
// The sync engine's snapshot/seed enumeration (lan-sync-egress allRows) needs the RAW row
// shapes (storage columns, tombstones included) — NOT the renderer view models above. Same
// doctrine as categoriesAllRows/planTombstones: the egress side pushes `data: null` for
// tombstones and the raw row for live rows; sync-apply lands peers' rows back through
// episodePut/sourcePut/taskSourcePut with the wire-carried stamps (those ops preserve an
// explicit updatedAt verbatim, so LWW ordering survives the hop).
const rowAll = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY id ASC`).all()
const rowTombstones = (db, table) => db.prepare(`SELECT id, updatedAt, deletedAt FROM ${table} WHERE deleted = 1 ORDER BY id ASC`).all()

exports.episodeAllRows = db => rowAll(db, 'work_episodes')
exports.episodeTombstones = db => rowTombstones(db, 'work_episodes')
exports.sourceAllRows = db => rowAll(db, 'source_refs')
exports.sourceTombstones = db => rowTombstones(db, 'source_refs')
exports.taskSourceAllRows = db => rowAll(db, 'task_source_links')
exports.taskSourceTombstones = db => rowTombstones(db, 'task_source_links')
exports.findingAllRows = db => rowAll(db, 'work_findings')
exports.findingTombstones = db => rowTombstones(db, 'work_findings')
exports.decisionAllRows = db => rowAll(db, 'work_decisions')
exports.decisionTombstones = db => rowTombstones(db, 'work_decisions')

// Pair lookups for the sync-apply pair-collapse rule (see sync-apply.js): a peer source/link
// row whose (providerId, externalId) / (taskId, sourceRefId) pair already exists locally under
// a DIFFERENT id must merge onto the local row — UNIQUE(pair) makes a second id impossible.
// Used only by the sync ingress path; the renderer never sees these.
exports.sourceFindPair = (db, row) => db.prepare('SELECT id, updatedAt, deleted FROM source_refs WHERE providerId = ? AND externalId = ?').get(String(row && row.providerId), String(row && row.externalId)) || null
exports.taskSourceFindPair = (db, row) => db.prepare('SELECT id, updatedAt, deleted FROM task_source_links WHERE taskId = ? AND sourceRefId = ?').get(String(row && row.taskId), String(row && row.sourceRefId)) || null

// Shared tombstone core (planRemoveIds shape): row-granular changed-id list, stamp opts honored.
function removeByIds (db, table, ids, opts = {}) {
  const list = Array.isArray(ids) ? ids : [ids]
  const now = Date.now()
  const dAt = (opts && opts.deletedAt) || now
  const stamp = (opts && opts.updatedAt) || dAt
  const del = db.prepare(`UPDATE ${table} SET deleted=1, deletedAt=?, updatedAt=? WHERE id = ? AND deleted=0`)
  const changed = []
  const tr = db.transaction(() => list.forEach(i => {
    const o = (i && typeof i === 'object') ? i : null
    const r = del.run((o && o.deletedAt) || dAt, (o && o.updatedAt) || stamp, String(o ? o.id : i))
    if (r.changes > 0) changed.push(String(o ? o.id : i))
  }))
  tr()
  return changed
}

// ---- work_findings / work_decisions (pd20 S1 closure, migration v14, 2026-11-10) ----
// The two mission §04 entities v13 left out. Same family doctrine as episode.role /
// source_refs.level: an out-of-family enum value stores NULL (a caller bug is not a fact),
// list-shaped columns store a JSON array or NULL (never a fabricated shape).
//
// THE STORAGE RULE (mission: "禁止把猜测变成验收结论" — a guess must not become an acceptance
// conclusion): a finding whose verificationLevel is 'speculation' can never persist with
// status 'confirmed' — findingPut normalizes that combination to 'open'. An observed finding
// MAY be confirmed, and a same-id put can correct the level (speculation → observed), which
// is the honest path from a guess to a verified conclusion.
const KNOWN_CONFIDENCE = new Set(['high', 'medium', 'low'])
const KNOWN_VLEVEL = new Set(['observed', 'inferred', 'speculation'])
const KNOWN_FSTATUS = new Set(['open', 'confirmed', 'retracted'])

const famOrNull = (set, v) => (v != null && set.has(String(v))) ? String(v) : null

// JSON-array-or-NULL column codec: only an array of string-able scalars persists (as JSON);
// anything else — a bare string, a number, garbage — stores NULL. Round-trips verbatim.
const jsonArrOrNull = v => {
  if (!Array.isArray(v)) return null
  const clean = v.filter(x => x != null && typeof x !== 'object').map(String)
  return clean.length ? JSON.stringify(clean) : null
}
const parseJsonArr = s => {
  if (s == null) return []
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : [] } catch { return [] }
}

exports.findingPut = (db, f = {}) => {
  if (!f || f.taskId == null || f.taskId === '') {
    throw new Error('[db-episode-ops] findingPut: taskId is required')
  }
  if (f.statement == null || String(f.statement).trim() === '') {
    throw new Error('[db-episode-ops] findingPut: statement is required (an empty fact is not a fact)')
  }
  const id = f.id != null && f.id !== '' ? String(f.id) : mintId('fnd')
  const now = Date.now()
  const confidence = famOrNull(KNOWN_CONFIDENCE, f.confidence)
  const verificationLevel = famOrNull(KNOWN_VLEVEL, f.verificationLevel)
  let status = famOrNull(KNOWN_FSTATUS, f.status)
  // THE STORAGE RULE: speculation never persists as confirmed. An out-of-family status on a
  // speculation stays NULL (the caller bug is not papered over with a family member).
  if (verificationLevel === 'speculation' && status === 'confirmed') status = 'open'
  db.prepare(`INSERT INTO work_findings (id, taskId, statement, confidence, verificationLevel, sourceRefs, createdBy, status, ts, deleted, deletedAt, updatedAt)
    VALUES (@id,@taskId,@statement,@confidence,@verificationLevel,@sourceRefs,@createdBy,@status,@ts,0,0,@updatedAt)
    ON CONFLICT(id) DO UPDATE SET taskId=excluded.taskId, statement=excluded.statement, confidence=excluded.confidence,
      verificationLevel=excluded.verificationLevel, sourceRefs=excluded.sourceRefs, createdBy=excluded.createdBy,
      status=excluded.status, ts=excluded.ts, deleted=0, deletedAt=0, updatedAt=excluded.updatedAt`)
    .run({
      id,
      taskId: String(f.taskId),
      statement: String(f.statement),
      confidence,
      verificationLevel,
      sourceRefs: jsonArrOrNull(f.sourceRefs),
      createdBy: f.createdBy != null ? String(f.createdBy) : null,
      status,
      ts: Number(f.ts) > 0 ? Number(f.ts) : now,
      updatedAt: Number(f.updatedAt) > 0 ? Number(f.updatedAt) : now
    })
  return id
}

exports.findingRemoveIds = (db, ids, opts = {}) => removeByIds(db, 'work_findings', ids, opts)

// Read-side view model (EditPanelWork Finding block + CLI list-finding + handoff export):
// live rows of one task, oldest ts first (chronological like the episodes). NULL family
// values read honestly at the view layer — 'unknown', never a fabricated family member.
// Read-only → no manifest row; whitelisted in handlers/todo.js (queryEpisodesByTask class).
exports.queryFindingsByTask = (db, taskId) => {
  if (taskId == null || taskId === '') return []
  return db.prepare(
    'SELECT id, statement, confidence, verificationLevel, sourceRefs, createdBy, status, ts' +
    ' FROM work_findings WHERE taskId = @taskId AND deleted = 0 ORDER BY ts ASC, id ASC'
  ).all({ taskId: String(taskId) }).map(r => ({
    findingId: r.id,
    statement: r.statement || '',
    confidence: KNOWN_CONFIDENCE.has(String(r.confidence)) ? String(r.confidence) : 'unknown',
    verificationLevel: KNOWN_VLEVEL.has(String(r.verificationLevel)) ? String(r.verificationLevel) : 'unknown',
    sourceRefs: parseJsonArr(r.sourceRefs),
    createdBy: r.createdBy || '',
    status: KNOWN_FSTATUS.has(String(r.status)) ? String(r.status) : (r.status == null ? 'open' : 'unknown'),
    ts: r.ts || 0
  }))
}

exports.decisionPut = (db, dec = {}) => {
  if (!dec || dec.taskId == null || dec.taskId === '') {
    throw new Error('[db-episode-ops] decisionPut: taskId is required')
  }
  if (dec.choice == null || String(dec.choice).trim() === '') {
    throw new Error('[db-episode-ops] decisionPut: choice is required (an empty choice is not a decision)')
  }
  const id = dec.id != null && dec.id !== '' ? String(dec.id) : mintId('dec')
  const now = Date.now()
  db.prepare(`INSERT INTO work_decisions (id, taskId, choice, alternatives, tradeoffs, decider, rationale, relatedFindings, supersedes, ts, deleted, deletedAt, updatedAt)
    VALUES (@id,@taskId,@choice,@alternatives,@tradeoffs,@decider,@rationale,@relatedFindings,@supersedes,@ts,0,0,@updatedAt)
    ON CONFLICT(id) DO UPDATE SET taskId=excluded.taskId, choice=excluded.choice, alternatives=excluded.alternatives,
      tradeoffs=excluded.tradeoffs, decider=excluded.decider, rationale=excluded.rationale,
      relatedFindings=excluded.relatedFindings, supersedes=excluded.supersedes, ts=excluded.ts,
      deleted=0, deletedAt=0, updatedAt=excluded.updatedAt`)
    .run({
      id,
      taskId: String(dec.taskId),
      choice: String(dec.choice),
      alternatives: jsonArrOrNull(dec.alternatives),
      tradeoffs: jsonArrOrNull(dec.tradeoffs),
      decider: dec.decider != null ? String(dec.decider) : null,
      rationale: dec.rationale != null ? String(dec.rationale) : null,
      relatedFindings: jsonArrOrNull(dec.relatedFindings),
      supersedes: dec.supersedes != null && dec.supersedes !== '' ? String(dec.supersedes) : null,
      ts: Number(dec.ts) > 0 ? Number(dec.ts) : now,
      updatedAt: Number(dec.updatedAt) > 0 ? Number(dec.updatedAt) : now
    })
  return id
}

exports.decisionRemoveIds = (db, ids, opts = {}) => removeByIds(db, 'work_decisions', ids, opts)

// Read-side view model: live decisions of one task, oldest ts first. The reverse supersede
// relation (supersededBy) is computed HERE from the LIVE rows of the same task — a tombstoned
// successor no longer counts as superseding (the revocation history stays honest at read time).
exports.queryDecisionsByTask = (db, taskId) => {
  if (taskId == null || taskId === '') return []
  const rows = db.prepare(
    'SELECT id, choice, alternatives, tradeoffs, decider, rationale, relatedFindings, supersedes, ts' +
    ' FROM work_decisions WHERE taskId = @taskId AND deleted = 0 ORDER BY ts ASC, id ASC'
  ).all({ taskId: String(taskId) })
  const supersededBy = new Map()
  for (const r of rows) {
    if (r.supersedes != null) {
      if (!supersededBy.has(r.supersedes)) supersededBy.set(r.supersedes, [])
      supersededBy.get(r.supersedes).push(r.id)
    }
  }
  return rows.map(r => ({
    decisionId: r.id,
    choice: r.choice || '',
    alternatives: parseJsonArr(r.alternatives),
    tradeoffs: parseJsonArr(r.tradeoffs),
    decider: r.decider || '',
    rationale: r.rationale || '',
    relatedFindings: parseJsonArr(r.relatedFindings),
    supersedes: r.supersedes || null,
    supersededBy: supersededBy.get(r.id) || null,
    ts: r.ts || 0
  }))
}
exports.parseNoteFields = parseNoteFields // read door (PD20 VS Code ext): /handoff maps vm episodes with the SAME round-trip as EditPanelWork
