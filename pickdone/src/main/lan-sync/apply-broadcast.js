/* Post-round renderer broadcast, extracted from lan-sync-bootstrap.js (2026-09-27 structure
 * size ratchet). Same injected-deps pattern as lan-sync/paired-peers.js: the bootstrap's
 * swappable module-level `state` (via getState) still applies, so __test.setState keeps working.
 * DATA_CHANNEL_KINDS stays declared in the bootstrap (cli/check-sync-matrix.cjs parses it there)
 * and is injected here. */
module.exports = ({ getState, busWrite, syncApply, HABITS_BLOB_FIELDS, DATA_CHANNEL_KINDS, BLOB_SETTINGS_KEY, emitSyncEvent, log }) => {
  function sendToRenderers (channel, msg) {
    try {
      const state = getState()
      const senders = state.getWindowSenders ? state.getWindowSenders() : []
      for (const s of senders) { try { if (s && !s.isDestroyed()) s.send(channel, msg) } catch { /* dying sender */ } }
    } catch { /* renderer notification is best-effort */ }
  }

  /** P1-2a / F1 (2026-09-20): fold applied setting rows back into the blob they came from so
   *  blob-vs-rows converge (no re-stamp churn). The settings_rows key IS the source blob's field
   *  name (db-sync-schema's setMeta bridge mirrors each blob's top-level fields row-for-row), so
   *  the source blob is known statically: the habits blob (renderer store/habits.js persist shape)
   *  carries exactly schemaV/habits/moments/savedAt; every other key lives in the settings blob.
   *  Folding into the WRONG blob made applied habits fields (habits/moments/savedAt) vanish from
   *  db.habitsState — the receiving habits store reads only that blob and its next persist()
   *  re-mirrored the stale blob over the fresh rows with a fresh savedAt (stale clobber of the peer).
   *  Guards against re-stamping newer rows backwards: the fold goes through setMeta, whose bridge
   *  (db-sync-schema registerOps) runs mergeDoc -> putRow, which is a strict identical-content
   *  no-op (the rows already hold these exact values, so no updatedAt is re-stamped), and the blob
   *  meta keys themselves never sync (isSyncBlobMetaKey), so the fold cannot echo.
   *  Best-effort: a corrupt blob skips the fold (rows stay the sync truth).
   *  Round-2 P1 (2026-09-21): a MISSING blob no longer skips the fold — on a fresh-paired device
   *  the blob is absent, the hot-apply deliberately does not persist, and nothing else rebuilt the
   *  blob from rows: restart lost the whole habits view, and the next local persist wrote the
   *  renderer's stale/empty blob over the peer's fresh rows (data loss). When the blob is missing
   *  but applied rows exist, the blob is now MATERIALIZED from the rows (fold = create).
   *  Returns the parsed patches per blob for the renderer hot-apply broadcasts. */
  const HABITS_BLOB_KEY = 'db.habitsState'
  function foldIntoBlob (blobKey, entries) {
    if (!entries.length) return
    try {
      const state = getState()
      let doc = null
      try { doc = JSON.parse(state.db.call('getMeta', blobKey)) } catch { doc = null }
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        // Round-2 P1: materialize instead of skip. The habits blob carries the renderer store's
        // persist shape (schemaV/habits/moments/savedAt); every other blob is the settings blob.
        if (blobKey === HABITS_BLOB_KEY) doc = { schemaV: 1, habits: [], moments: [], savedAt: 0 }
        else doc = {}
        log.info('[LanSync] materializing missing blob from applied rows:', blobKey)
      }
      for (const [k, v] of entries) {
        if (v === undefined) delete doc[k] // tombstone: drop the field from the blob
        else doc[k] = v
      }
      busWrite('setMeta', [blobKey, JSON.stringify(doc)])
    } catch (e) { log.warn('[LanSync] settings blob fold failed:', blobKey, e.message) }
  }

  function foldSettingsIntoBlob (patch) {
    const settings = []
    const habits = []
    for (const k of Object.keys(patch || {})) {
      if (syncApply.isMachineLocalSettingKey(k)) continue
      ;(HABITS_BLOB_FIELDS.has(k) ? habits : settings).push([k, patch[k]])
    }
    foldIntoBlob(BLOB_SETTINGS_KEY, settings)
    foldIntoBlob(HABITS_BLOB_KEY, habits)
    const toPatch = list => { const p = {}; for (const [k, v] of list) if (v !== undefined) p[k] = v; return p }
    return { settingsPatch: toPatch(settings), habitsPatch: toPatch(habits) }
  }

  function emitAppliedRound () {
    const state = getState()
    const round = syncApply.consumeAppliedRound(state)
    if (!round) return
    // Sync writes are main-process writes: re-baseline the external-write watcher so its next poll
    // does not mistake them for CLI writes and fire a second (undo-stack-wiping) full reload.
    try { if (state.resyncExternalWatch) state.resyncExternalWatch() } catch { /* best-effort */ }
    const at = Date.now()
    if (round.kinds.some(k => DATA_CHANNEL_KINDS.includes(k))) {
      sendToRenderers('todos-changed', { reason: 'lan-sync-apply', op: round.kinds.join(','), at })
    }
    if (round.kinds.includes('tomato')) {
      sendToRenderers('tomato-records-changed', { reason: 'lan-sync-apply', at })
    }
    const settingKeys = Object.keys(round.settingsPatch || {})
    if (settingKeys.length) {
      // F1 (2026-09-20): fold each applied row into ITS source blob (settings vs habits) and
      // hot-apply each on its own channel. external-habits-changed mirrors external-settings-changed
      // 1:1 (S2 renderer wiring contract):
      //   channel: 'external-habits-changed'
      //   payload: flat object of APPLIED habits-blob fields -> parsed values, e.g.
      //            { habits: [...], moments: [...], savedAt: 1712345678901 }
      //            (keys omitted when the applied row was a tombstone = field deleted).
      //            Consumed like external-settings-changed: merge the fields into the habits store
      //            state; savedAt LWW in store/habits.js already dedupes stale applications.
      const { settingsPatch, habitsPatch } = foldSettingsIntoBlob(round.settingsPatch)
      // Settings hot-apply path reuses the CLI settings watcher's channel: the renderer dispatches
      // settings/update, which syncs LS/config.json/shortcuts and mirrors the blob back (now
      // value-identical to the rows, so the bridge stamps nothing — the churn loop stays dead).
      if (Object.keys(settingsPatch).length) sendToRenderers('external-settings-changed', settingsPatch)
      if (Object.keys(habitsPatch).length) sendToRenderers('external-habits-changed', habitsPatch)
    }
    // P1-5: one conflict toast per round, max.
    if (round.conflicts && round.conflicts.length) {
      const c = round.conflicts[0]
      emitSyncEvent('sync-conflict', { entity: c.entity, name: c.name, applied: c.applied, count: round.conflicts.length })
    }
  }

  return { sendToRenderers, foldIntoBlob, foldSettingsIntoBlob, emitAppliedRound }
}
