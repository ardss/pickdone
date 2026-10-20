/**
 * F1 (2026-10-21): entry-level union merge for the two ARRAY-shaped user-data meta blobs that
 * previously synced whole-key LWW:
 *   - `projectMilestones:<catId>`  [{ id, title, date, taskIds? }]
 *   - `projectDocs:<catId>`        [{ id, title, body, updatedAt }]
 *
 * Whole-key LWW loses data whenever two devices concurrently ADD an entry: the writer's blob
 * overwrites the loser's whole document and the loser's milestone/doc vanishes silently (the
 * meta conflict backup exists but the loss should not happen at all — entries are independently
 * addressable by id). Union merge instead: local-only entries survive, incoming-only entries are
 * added, and a same-id collision resolves per entry ("同 id 取较新"):
 *   - entries carrying a numeric `updatedAt` (docs): the larger stamp wins, incoming wins ties;
 *   - entries WITHOUT a per-entry stamp (milestones): no comparable age exists in this schema
 *     (no vector clocks — a full CRDT is out of scope), so the resolver is SYMMETRIC
 *     (argument-order independent): identical content collapses, otherwise the lexicographically
 *     larger serialized form wins. Arbitrary but deterministic on BOTH peers, which is what
 *     guarantees convergence and kills the apply/push echo loop (see preferEntry).
 *
 * Returns the MERGED JSON string, or null when the shape is not a clean id-addressable array on
 * both sides — the caller then falls back to whole-key LWW (with the metaConflictBackup safety
 * net). Deterministic: the result is sorted by the blob's date field so both peers converge on
 * byte-identical output for the same input pair (echo of the merged blob then hits the
 * identical-content no-op and the loop dies).
 */

const UNION_MERGE_META_PREFIXES = ['projectMilestones:', 'projectDocs:']

/** True for the meta keys this module merges (single source shared by sync-apply + tests). */
export function isUnionMergeMetaKey (key) {
  const k = String(key || '')
  return UNION_MERGE_META_PREFIXES.some(p => k.startsWith(p))
}

function parseList (raw) {
  let v
  try { v = JSON.parse(raw) } catch { return null }
  if (!Array.isArray(v)) return null
  // Every entry must be an object with a usable id — otherwise entries are not independently
  // addressable and a union merge could duplicate or mis-resolve them: bail out to whole-key LWW.
  for (const m of v) {
    if (!m || typeof m !== 'object' || m.id == null || m.id === '') return null
  }
  return v
}

/** Per-entry LWW: entries carrying a numeric `updatedAt` (docs) resolve to the larger stamp,
 *  ties to the incoming side. STAMP-LESS entries (milestones) have no comparable age, so the
 *  resolver must be SYMMETRIC (argument-order independent) or the two peers could converge on
 *  different blobs for the same input pair and re-echo forever: content-identical entries
 *  collapse trivially; otherwise the lexicographically larger serialized form wins — arbitrary,
 *  but deterministic and identical on both ends, which is what kills the loop (a full CRDT
 *  needs vector clocks — out of scope, see the module docstring). */
function preferEntry (localEntry, incomingEntry) {
  const lt = Number(localEntry && localEntry.updatedAt)
  const it = Number(incomingEntry && incomingEntry.updatedAt)
  if (Number.isFinite(lt) && Number.isFinite(it)) return it >= lt ? incomingEntry : localEntry
  const ls = JSON.stringify(localEntry)
  const is = JSON.stringify(incomingEntry)
  return ls === is ? incomingEntry : (is > ls ? incomingEntry : localEntry)
}

/** Sort key per blob family: milestones order by `date` (saveMilestones contract), docs by
 *  `updatedAt` (ProjectDocs sortedDocs contract). Tolerant: garbage reads as 0 instead of
 *  poisoning the comparator with NaN. */
function sortKeyOf (key, entry) {
  const field = String(key).startsWith('projectDocs:') ? 'updatedAt' : 'date'
  const n = Number(entry[field])
  return Number.isFinite(n) ? n : 0
}

/**
 * Union-merge the two blob values. @param localVal raw local JSON string (non-empty)
 * @param incomingVal raw inbound JSON string (non-empty) @returns merged JSON string, or null
 * when either side is not a clean id-addressable array (caller falls back to whole-key LWW).
 */
export function mergeBlobMetaValue (key, localVal, incomingVal) {
  if (!isUnionMergeMetaKey(key)) return null
  const local = parseList(localVal)
  const incoming = parseList(incomingVal)
  if (!local || !incoming) return null
  const merged = new Map()
  for (const m of local) merged.set(String(m.id), m)
  for (const m of incoming) {
    const k = String(m.id)
    merged.set(k, merged.has(k) ? preferEntry(merged.get(k), m) : m)
  }
  const out = [...merged.values()].sort((a, b) => sortKeyOf(key, a) - sortKeyOf(key, b))
  return JSON.stringify(out)
}
