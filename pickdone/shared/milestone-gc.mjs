/**
 * D20-DOMB1 (2026-10-02): single source for milestone-blob scrubbing, shared by every route
 * that permanently removes task ids: the renderer purge (scrubMilestonesForPurged in
 * renderer/js/utils/milestones.js), the CLI purgeBin (cli/lib.js), and the SYNC tombstone
 * landing (src/main/sync-apply.js — a peer purge used to leave the dead id inside
 * projectMilestones:<catId> blobs, so milestoneState (ids.size > 0, zero EXISTING linked
 * tasks) fell through to the date-driven 'done' branch and flipped an UNMET milestone to
 * done cross-machine).
 *
 * Pure by design: takes the raw meta blob and the dead-id set, returns the re-serialized
 * blob or null when the caller must leave the key alone (corrupt JSON, non-array, or
 * nothing to change — never rewrite an unmodified blob).
 */

/**
 * Scrub the dead ids from every milestone's taskIds in one blob.
 * @param {string|null} raw the stored JSON (null/'' = empty list, nothing to do)
 * @param {Set<string>} purgedIds ids whose last link is gone
 * @returns {string|null} the new JSON blob when something was scrubbed, else null
 */
export function scrubMilestoneBlob (raw, purgedIds) {
  let list
  try { list = JSON.parse(raw || '[]') } catch { return null /* corrupt blob → leave alone (cli parity) */ }
  if (!Array.isArray(list)) return null
  let changed = false
  for (const m of list) {
    if (Array.isArray(m.taskIds) && m.taskIds.some(id => purgedIds.has(id))) {
      m.taskIds = m.taskIds.filter(id => !purgedIds.has(id))
      changed = true
    }
  }
  return changed ? JSON.stringify(list) : null
}
