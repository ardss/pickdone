/** Scheduling chips (dayPlanState) cross-component shared ops — the sole frontend channel after the storage-layer root fix
 *  2026-09-03 root fix: chips migrated from the meta.dayPlanState whole-package JSON (triple concurrent writes, root cause of four data-loss incidents) into
 *  SQLite plan_chips row storage. This is just a thin wrapper over db atomic ops:
 *  - Single write channel: each operation is one atomic db op, no read-modify-write race window
 *  - Cross-end sync: plan* ops are write ops; the main process auto-broadcasts todos-changed (even CLI direct-writes to the db file are detected and broadcast by the main process)
 *  - Same-window immediacy: the post-write broadcast excludes the initiator, so a window event is re-emitted here so this window's timeline also refreshes */
const LS_KEY = 'dayPlanState'

const dbCall = (op, params) => window.todoAPI.dbCall(op, params)

/** Full chips → DayRail's plans shape { day: { taskId: [{ mm, id }] } } */
export async function allPlans () {
  const rows = await dbCall('planAll', [])
  const plans = {}
  for (const r of rows) {
    if (!plans[r.day]) plans[r.day] = {}
    if (!Array.isArray(plans[r.day][r.taskId])) plans[r.day][r.taskId] = []
    plans[r.day][r.taskId].push({ mm: r.mm, id: r.id })
  }
  return plans
}

/** Same-window timeline immediate-refresh broadcast (cross-window goes via the todos-changed main-process broadcast) */
function pingLocal () {
  try { window.dispatchEvent(new CustomEvent('day-plans-changed')) } catch {}
}

export async function addChips (chips) {
  const ids = await dbCall('planAddMany', chips)
  pingLocal()
  return ids
}

export async function updateChip (id, day, mm) {
  const r = await dbCall('planUpdateChip', { id, day, mm })
  pingLocal()
  return r
}

export async function removeChips (ids) {
  const r = await dbCall('planRemoveIds', Array.isArray(ids) ? ids : [ids])
  pingLocal()
  return r
}

/** Task reschedule: migrate chips wholesale (time unchanged) */
export async function moveTaskChips (taskId, fromDay, toDay) {
  if (!fromDay || !toDay || fromDay === toDay) return
  const n = await dbCall('planMoveTask', { taskId, fromDay, toDay })
  if (n > 0) pingLocal()
  return n
}

/** Schedule date removed / task deleted: clear all chips */
export async function clearTaskChips (taskId) {
  const r = await dbCall('planDeleteTask', taskId)
  pingLocal()
  return r
}

/** Expired day-bucket cleanup (outside the [-31d,+7d] window), called by DayRail prune */
export async function pruneDays (keepDays) {
  const r = await dbCall('planPrune', { keepDays })
  pingLocal()
  return r
}

/** Fallback migration: an old version's LS snapshot may have landed one more write after the meta migration (a leftover of the last overwrite incident).
 *  When the library is non-empty, neither import nor delete the LS (warn, left for manual verification); the LS key is deleted only after a genuinely successful import, preventing silent loss of leftover data. */
export async function importLegacyOnce () {
  try {
    const rows = await dbCall('planAll', [])
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return 0
    if (rows.length) { console.warn('[dayPlans] DB already has chips and LS still has leftover snapshots, neither imported nor deleted, manual review needed:', LS_KEY); return 0 }
    const doc = JSON.parse(raw)
    const chips = []
    for (const day of Object.keys(doc)) {
      if (day.startsWith('_') || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
      for (const [taskId, arr] of Object.entries(doc[day])) {
        if (!Array.isArray(arr)) continue
        for (const e of arr) {
          if (e && /^\d{2}:\d{2}$/.test(String(e.mm))) chips.push({ taskId, day, mm: String(e.mm) })
        }
      }
    }
    if (!chips.length) return 0
    await dbCall('planAddMany', chips)
    localStorage.removeItem(LS_KEY)
    return chips.length
  } catch { return 0 }
}

/** Snapshot a task's chips to meta before deletion (used for write-back on restore, eliminating the "delete→restore loses schedule" regression) */
export async function snapshotForDelete (taskId) {
  try {
    const rows = (await dbCall('planAll', [])).filter(r => r.taskId === taskId)
    if (!rows.length) return
    await dbCall('setMeta', ['planChipsSnapshot:' + taskId, JSON.stringify(rows)])
    await dbCall('planDeleteTask', taskId)
  } catch { /* Snapshot failure doesn't block deletion; chips left in the library as orphans can still be converged by planPrune */ }
}

/** Write back snapshot chips when restoring a task */
export async function restoreSnapshot (taskId) {
  try {
    const raw = await dbCall('getMeta', 'planChipsSnapshot:' + taskId)
    if (!raw) return
    const rows = JSON.parse(raw)
    if (Array.isArray(rows) && rows.length) await dbCall('planAddMany', rows)
    await dbCall('setMeta', ['planChipsSnapshot:' + taskId, ''])
  } catch { /* Missing/corrupted snapshot treated as no schedule */ }
}
