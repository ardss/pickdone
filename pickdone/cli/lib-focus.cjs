/* Focus-ledger sub-module extracted from cli/lib.js (2026-09-27 size-ratchet split).
 * Factory-injected deps keep it decoupled from lib.js (no circular require), same pattern as lib-settings.cjs.
 * Focus ledger (唯一事实源 = SQLite tomato_records 行表,同统计页/时间轴;CLI 直连 DB,无需 App 运行) + per-task tomato estimates. */
module.exports = ({ open, commit, audit, CliError, dayjs, resolveTask, liveTasks, parseDate, FOCUS_MAX_MINUTES, REST_MAX_MINUTES }) => {
  function tomatoRecords () {
    try {
      const rows = open().call('tomatoAll')
      return Array.isArray(rows) ? rows : []
    } catch { return [] }
  }

  /** Backfill one manual focus record: CLI 直写账本行(不再经 App 命令通道,App 关闭也可用)。
   *  tomatoId 与渲染端手动补录同形(幂等:重复导入同槽位不产生第二条)。 */
  function backfillRecord ({ taskId = null, content = '', date, at = '20:00', minutes = 25 }) {
    // B10: strict parse (db-tomato-ops contract: lower bound is 0, a bad value must NOT be inflated
    // into a phantom 1-minute ledger row). Non-numeric / 0 / negative → USAGE error, no row written.
    // FOCUS_MAX_MINUTES = the DB-layer clamp (shared/limits.mjs, db.js _recToRow): silently truncating 720 to 240/600 reported success while a different duration landed
    const raw = /^\d+$/.test(String(minutes).trim()) ? parseInt(minutes, 10) : NaN
    if (!Number.isFinite(raw) || raw < 1) throw new CliError('backfill --minutes must be a positive integer; got ' + JSON.stringify(minutes), 'USAGE')
    if (raw > FOCUS_MAX_MINUTES) throw new CliError('backfill duration max is ' + FOCUS_MAX_MINUTES + ' minutes (DB-layer clamp); got ' + raw, 'USAGE')
    const min = raw
    const base = dayjs(date)
    if (!base || !base.isValid()) throw new CliError('bad backfill date: ' + date, 'USAGE')
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(at))
    if (!m) throw new CliError('--at accepts HH:mm', 'USAGE')
    const endAt = base.hour(+m[1]).minute(+m[2]).second(0).millisecond(0)
    const endTime = endAt.valueOf()
    const startTs = endTime - min * 60000
    const rec = {
      tomatoId: 'tmt_m_' + startTs + '_' + min + '_' + String(taskId || 'free').slice(-8),
      endTime, dateKey: endAt.format('YYYY-MM-DD'),
      focus: content || '', focusTaskId: taskId || null,
      focusDuration: min, rest: 0, restDuration: 0,
      succeed: true, status: 'local', manual: true
    }
    // Single-row CLI path fails fast: a rejected row (bad at → NaN endTime etc.) must not print success
    // or write audit. Row-level tolerance ({accepted, rejected}) is for the renderer's batch queue.
    const res = commit('tomato', 'appendMany', rec)
    if (res && Array.isArray(res.rejected) && res.rejected.length) {
      throw new CliError('backfill rejected: ' + res.rejected.map(r => r.reason).join(', '), 'LEDGER_REJECT')
    }
    audit.record({ action: 'tomato.backfill', targets: taskId ? [{ taskId }] : [], changes: [], note: 'CLI backfill ' + min + 'min @ ' + rec.dateKey + ' ' + at + ' (ledger row direct)' })
    return rec
  }

  /* ---------------- Tomato estimate per task (per-task meta keys = plain integer string; X2 2026-09-20 contract) ----------------
     F-B3 (dw wave 3): the storage contract (key prefix / 0..20 clamp / TS_KEY / legacy blob key) moved
     to shared/estimate-core.mjs — single source with the renderer's utils/tomatoEstimate.js (the
     renderer consumes the same module in its wave). */
  const { ESTIMATE_KEY_PREFIX, estimateKeyOf, clampEstimate, TS_KEY: ESTIMATE_TS_KEY, LEGACY_KEY: ESTIMATE_LEGACY_KEY, ESTIMATE_MAX } = require('../shared/estimate-core.mjs')
  const estimateKey = estimateKeyOf
  /** Lazy legacy migration (first write): old whole-doc blob → per-task keys, then the legacy doc key
   *  is deleteMeta'd (a sync tombstone, so peers drop it too). Corrupt blob → dropped, not fatal. */
  function migrateLegacyEstimateBlob () {
    const legacy = open().call('getMeta', ESTIMATE_LEGACY_KEY)
    if (legacy == null) return null
    let map = {}
    try { map = JSON.parse(legacy) || {} } catch { /* corrupt → drop */ }
    for (const [taskId, v] of Object.entries(map)) {
      const n = clampEstimate(v)
      if (n > 0) commit('meta', 'put', [estimateKey(taskId), String(n)])
    }
    commit('meta', 'delete', ESTIMATE_LEGACY_KEY)
    return map
  }
  function setEstimate (input, n) {
    const t = resolveTask(input, liveTasks())
    const v = clampEstimate(n)
    const legacy = migrateLegacyEstimateBlob()
    // Setting = setMeta plain integer string; clearing = deleteMeta (tombstone propagates the removal)
    if (v > 0) commit('meta', 'put', [estimateKey(t.taskId), String(v)])
    else commit('meta', 'delete', estimateKey(t.taskId))
    // Timestamp convention mirrors the renderer's tomatoEstimate/initFromDb: when meta is newer it takes over LS at startup (otherwise CLI writes get clobbered by the UI's stale LS)
    commit('meta', 'put', [ESTIMATE_TS_KEY, String(Date.now())])
    audit.record({ action: 'edit', targets: [t], changes: [{ before: { tomatoEstimate: getEstimateOf(t.taskId, legacy && legacy[t.taskId]) }, after: { tomatoEstimate: v || null } }], note: 'tomato estimate set to ' + (v || '(none)') })
    return { taskId: t.taskId, content: t.taskContent, tomatoEstimate: v }
  }
  function getEstimateOf (taskId, legacyVal) {
    // Readers: per-task key first; legacy doc blob only as a read fallback (per-task miss)
    try {
      const per = open().call('getMeta', estimateKey(taskId))
      if (per != null) return clampEstimate(per)
      if (legacyVal != null) return Number(legacyVal) || 0
      const m = JSON.parse(open().call('getMeta', ESTIMATE_LEGACY_KEY) || '{}')
      return m[taskId] || 0
    } catch { return 0 }
  }

  /** Resolve a focus record by full tomatoId or unique prefix (tomatoIds are long; prefix is the human/AI-friendly handle) */
  function resolveRecord (ref) {
    const recs = tomatoRecords().filter(Boolean)
    const exact = recs.find(r => r.tomatoId === ref)
    if (exact) return exact
    const hits = recs.filter(r => r.tomatoId && String(r.tomatoId).startsWith(ref))
    if (!hits.length) throw new CliError('no focus record matches "' + ref + '" — tomato list to browse ids', 'RECORD_NOT_FOUND')
    if (hits.length > 1) {
      const preview = hits.slice(0, 10).map(r => `  - ${r.tomatoId}  ${r.dateKey} ${r.focusDuration}min ${r.focus || '(free)'}`).join('\n')
      throw new CliError(`"${ref}" matched ${hits.length} records; use a longer prefix:\n${preview}`, 'AMBIGUOUS_MATCH')
    }
    return hits[0]
  }

  /** Fix an existing focus record (wrong duration/time/task). The CLI writes the ledger row DIRECTLY via
   *  db.tomatoUpdateById — it does NOT route through the (retired) App command channel. Consequence: the
   *  running App does not learn about this write in-process. Convergence on the App side relies on external
   *  DB-write detection: db.js fires the ledger-changed hook for LEDGER_WRITE_OPS in the writer process
   *  (main/index.js setLedgerChangedHook → 'tomato-records-changed' broadcast), and external CLI writes are
   *  picked up by the main-process watcher / renderer store re-read (the same path that hot-applies
   *  `settings set`), or at worst on next launch. */
  function recordFix (ref, { minutes, date, at, rest, succeed, task, free }) {
    const rec = resolveRecord(ref)
    const patch = {}
    // FOCUS_MAX_MINUTES is the DB-layer clamp (shared/limits.mjs, db.js _recToRow). D17 strict parse
    // (same contract as backfillRecord): the old `parseInt||0` + Math.max(1,n) silently floored
    // garbage/0 into a 1-minute row — an explicit bad value must be a USAGE error instead.
    if (minutes != null) {
      const raw = /^\d+$/.test(String(minutes).trim()) ? parseInt(minutes, 10) : NaN
      if (!Number.isFinite(raw) || raw < 1) throw new CliError('focus duration must be a positive integer; got ' + JSON.stringify(minutes), 'USAGE')
      if (raw > FOCUS_MAX_MINUTES) throw new CliError('focus duration max is ' + FOCUS_MAX_MINUTES + ' minutes (DB-layer clamp); got ' + raw, 'USAGE')
      patch.focusDuration = raw
    }
    // restDuration clamp = REST_MAX_MINUTES, the same cap the db layer applies (_recToRow); the old CLI-only
    // 120 clamp silently rewrote a legitimate 300-min rest to 120 while a direct db append kept 600.
    if (rest != null) patch.restDuration = Math.max(0, Math.min(REST_MAX_MINUTES, parseInt(rest, 10) || 0))
    // B11: strict boolean enum — `--succeed <anything>` used to coerce to true, silently flipping an
    // abandoned record to succeeded. Only true|false|yes|no|1|0 accepted; anything else → USAGE.
    if (succeed != null && succeed !== true) {
      const s = String(succeed).trim().toLowerCase()
      if (!/^(true|false|yes|no|1|0)$/.test(s)) throw new CliError('--succeed accepts true|false|yes|no|1|0; got ' + JSON.stringify(String(succeed)), 'USAGE')
      patch.succeed = !/^(false|no|0)$/.test(s)
    }
    if (date || at) {
      // endTime reposition: endTime defines placement; dateKey re-derived here (was App-side).
      // The record's own endTime is the anchor for whichever of --date/--at the caller omitted.
      // It is DATA, not a display default: a missing/corrupt endTime must not silently anchor to
      // "today, right now" (that would land a wrong dateKey). Fail loud and demand explicit input.
      const recEnd = Number.isFinite(rec.endTime) && rec.endTime > 0 ? rec.endTime : null
      if (!recEnd && (!date || !at)) {
        throw new CliError('record ' + rec.tomatoId + ' has no valid endTime to anchor from — pass explicit --date (YYYY-MM-DD) and --at (HH:mm)', 'USAGE')
      }
      const endBase = parseDate(date || dayjs(recEnd).format('YYYY-MM-DD'))
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(at || dayjs(recEnd).format('HH:mm')))
      if (!m) throw new CliError('--at accepts HH:mm', 'USAGE')
      patch.endTime = dayjs(endBase).hour(+m[1]).minute(+m[2]).second(0).millisecond(0).valueOf()
      patch.dateKey = dayjs(patch.endTime).format('YYYY-MM-DD')
    }
    if (free === true) patch.focusTaskId = null
    else if (task) patch.focusTaskId = resolveTask(task, liveTasks()).taskId
    const ok = commit('tomato', 'updateById', { tomatoId: rec.tomatoId, patch })
    if (!ok) throw new CliError('record vanished from ledger: ' + rec.tomatoId, 'RECORD_NOT_FOUND')
    audit.record({ action: 'tomato.record-fix', targets: [], changes: [{ before: rec, after: Object.assign({}, rec, patch) }], note: 'CLI record fix (ledger row direct)' })
    return { rec: Object.assign({}, rec, patch) }
  }

  /** Delete an erroneous focus record (ledger row direct — the UI entry card deletes via the same op) */
  function recordRemove (ref) {
    const rec = resolveRecord(ref)
    commit('tomato', 'removeByIds', [rec.tomatoId])
    audit.record({ action: 'tomato.record-remove', targets: [], changes: [{ before: rec, after: null }], note: 'CLI record remove (ledger row direct)' })
    return { rec }
  }

  return {
    tomatoRecords, backfillRecord, resolveRecord, recordFix, recordRemove,
    migrateLegacyEstimateBlob, setEstimate, getEstimateOf,
    estimateKey, ESTIMATE_KEY_PREFIX, ESTIMATE_MAX, clampEstimate, ESTIMATE_TS_KEY
  }
}
