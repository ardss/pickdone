/**
 * [H2 2026-10-25, rootcause audit] syncEvent toast wiring for the main shell, extracted
 * from main.js for the structure ratchet ("split, never grow"). Two listeners:
 * - conflict: AT MOST ONE visible toast, 30s minimum between shows (the edit-war contract).
 * - increment-loss faces (oplog-append-failed / flush-quarantined / sync-degraded): ONE
 *   toast PER TYPE per session — the main side used to log-only these, so the user saw a
 *   quiet settings badge at best while their changes silently stopped flowing.
 */
export function installSyncEventToasts ({ onSyncEvent, i18n, toast, EP }) {
  if (!onSyncEvent) return
  let conflictToast = null
  let conflictShownAt = 0
  const shown = new Set()
  onSyncEvent(evt => {
    if (!evt || evt.type !== 'sync-conflict') return
    try {
      if (!EP || !EP.ElMessage) return
      if (Date.now() - conflictShownAt < 30 * 1000) return // rate-limit: one conflict notice per 30s window
      if (conflictToast) { try { conflictToast.close() } catch (e) { /* already gone */ } conflictToast = null }
      const key = evt.applied ? 'sync.conflictApplied' : 'sync.conflictKept'
      conflictToast = toast({ type: 'warning', message: i18n.global.t(key, { name: evt.name || '' }), duration: 6000, showClose: true })
      conflictShownAt = Date.now()
    } catch (e) { console.warn('[lan-sync] conflict toast failed', e) }
  })
  onSyncEvent(evt => {
    if (!evt) return
    const key = evt.type === 'oplog-append-failed' || evt.type === 'sync-degraded'
      ? 'sync.degradedOplog'
      : evt.type === 'flush-quarantined' ? 'sync.degradedFlush' : null
    if (!key || shown.has(key)) return
    try {
      if (!EP || !EP.ElMessage) return
      toast({ type: 'warning', message: i18n.global.t(key), duration: 8000, showClose: true })
      // [w16 P3 fix] mark shown only AFTER the toast actually surfaced: the add used to sit
      // before the EP availability check, so an event arriving before EP was ready burned the
      // one-shot alarm without the user ever seeing it.
      shown.add(key)
    } catch (e) { console.warn('[lan-sync] degraded toast failed', e) }
  })
}
