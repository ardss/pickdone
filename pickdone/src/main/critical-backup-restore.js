/* Critical-backup restore wiring (moved verbatim out of index.js 2026-10-30): the boot-time
   JSON restore pipeline. busCommit commits through the Phase-2 command bus (preserveStamp:
   restore replays the backup's own row ages verbatim — re-stamping would skew LWW against
   peers); the lazy require keeps the exact historical timing (command-bus is only loaded when
   a restore actually commits). The recovery-dialog caller in index.js keeps the
   jsonRestoreAllowed gate, the sentinel lifecycle and the watermark invalidation — this module
   is only the segment-replay wiring itself. */
function createCriticalBackupRestore ({ dbRecovery, log }) {
  // Phase-2 command bus: the critical-backup restore pipeline commits through the bus
  // (todo.putMany / category.put / tomato.appendMany) like every other write path,
  // preserveStamp: restore replays the backup's own row ages verbatim — re-stamping would skew
  // LWW against peers. The 'undo-barrier'/'ls-mirror' subscribers only exist after registerIpc,
  // so the startup recovery path commits with no fanout, exactly as before.
  const busCommit = (entity, verb, payload) => require('./command-bus').commit(entity, verb, payload, { preserveStamp: true })
  // [F4 #9] recovery-dialog disclosure of a degraded dump (mirrors renderer todoBackup.describeDegradedSegments; the main process cannot require the ESM renderer module, so the segment→surface map is duplicated here on purpose)
  const describeRecoveryDegraded = segs => (Array.isArray(segs) ? segs.filter(s => s === 'planState' || s === 'metaState').map(s => s === 'planState' ? 'planState (schedule chips)' : 'metaState (repeat rules/estimates/project meta)').join(', ') : '')
  // F11 (dw wave6) + Sync-3 (D12): startup recovery re-imports the SAME segment set the UI restore accepts (filter/plan/meta/habits ride the same command-bus doors, idempotent by id) and the wrapper returns the per-segment REPORT (tasks / imported / failedSegments / unconsumedSegments / proved) — the plain-bak cleanup gate needs to know whether EVERY segment was consumed, not just that todoState imported rows.
  function restoreFromCriticalBackup (ud) {
    const r = dbRecovery.restoreSegmentsFromCriticalBackup(ud,
      list => busCommit('todo', 'putMany', list),
      c => busCommit('category', 'put', c),
      rows => busCommit('tomato', 'appendMany', rows),
      {
        filterPutMany: rows => busCommit('filter', 'putMany', rows),
        planPutMany: chips => busCommit('plan', 'putMany', chips),
        habitsPut: pair => busCommit('meta', 'put', pair),
        // metaState (2026-09-26, meta-keys-omitted): repeat rules / tomato estimates / project // deadline+status+flag+milestones live only in the meta table — re-put them like habits.
        metaPut: pair => busCommit('meta', 'put', pair),
        // F1 (2026-10-17) sync-identity restore: sync.deviceId / sync.pairingSecret live in settings_rows
        // (lan-sync-bootstrap reads settingsRowsAll), NOT the meta table — without this door the whitelist-preserved
        // identity keys would land in the wrong table (inert) and a JSON restore would mint a fresh deviceId.
        settingsPut: pair => busCommit('setting', 'put', { key: pair[0], value: pair[1] })
      })
    // [Sync-13 reader + F4 #9] a degraded dump's missing segments must be visible: logged here and surfaced in the recovery dialog below (describeRecoveryDegraded).
    if (r && Array.isArray(r.degradedSegments) && r.degradedSegments.length) {
      log.warn('[Init] critical backup was collected degraded — segments missing from this dump:', r.degradedSegments.join(', '))
    }
    return r
  }
  return { restoreFromCriticalBackup, describeRecoveryDegraded }
}

module.exports = { createCriticalBackupRestore }
