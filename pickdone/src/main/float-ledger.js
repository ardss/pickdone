/** Float-window ledger write gate — D3 (2026-09-24) verbatim extraction from
 *  handlers/todo.js execDbCall (the security-lock floatLedger determination, incl. its
 *  dbm.call row-existence/date-boundary queries). Pure decision module: callers inject the
 *  db accessor (call) and the isSelfSender verdict, so the gate is unit-testable without
 *  electron and todo.js shrinks to whitelist -> gate -> route -> broadcast.
 *
 *  Behavior contract (unchanged from the inline original):
 *  - Only the float window's own sender may qualify, and only for the three ledger ops
 *    tomatoAppendMany / tomatoUpdateById / bumpSnow.
 *  - bumpSnow (H2 2026-09-16): the target row must exist and not be soft-deleted.
 *  - tomatoUpdateById (D7 2026-09-22): the CURRENT row's dateKey must be local today AND any
 *    endTime present in the patch must land on local today too (db re-derives dateKey from
 *    endTime, so a historical endTime would migrate a today row into the past).
 *  - tomatoAppendMany (2026-09-09 P2): every row's endTime must fall on local today.
 *  Returns true when the write may proceed while the app is locked. */
const fixUtil = require('./fix-util')

function evalFloatLedger ({ op, params, isSelfSender, call }) {
  let floatLedger = !!isSelfSender && /^(tomatoAppendMany|tomatoUpdateById|bumpSnow)$/.test(op) // bumpSnow=挂任务送专注积分,同属到点落账
  if (floatLedger && op === 'bumpSnow') {
    const tid = (params || {}).taskId
    const t = tid != null ? call('getById', String(tid)) : null
    floatLedger = !!t && !t.delete
  }
  if (floatLedger && (op === 'tomatoUpdateById' || op === 'tomatoAppendMany')) {
    // 本地时区当天(dateKey 按本地 dayjs 导出,UTC 串会在 0-8 点误判跨天)
    const todayKey = fixUtil.localDayKey(Date.now())
    if (op === 'tomatoUpdateById') {
      // dateKey 由 endTime 强制导出(db 层);查不到的行让 db 层自己返回 false
      const cur = call('tomatoGetById', String((params || {}).tomatoId))
      const patch = (params || {}).patch || {}
      const patchEnd = patch.endTime
      floatLedger = !!cur && cur.dateKey === todayKey &&
        (patchEnd == null || (Number(patchEnd) > 0 && fixUtil.localDayKey(Number(patchEnd)) === todayKey))
    } else {
      // tomatoAppendMany 收窄(2026-09-09 P2):所有行的 endTime 都必须落在本地当天
      const rows = Array.isArray(params) ? params : [params]
      floatLedger = rows.every(r => r && r.endTime && fixUtil.localDayKey(r.endTime) === todayKey)
    }
  }
  return floatLedger
}

module.exports = { evalFloatLedger }
