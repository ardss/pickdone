/**
 * Tomato focus-ledger ops extracted verbatim from db.js (structure-size ratchet). Pure relocation:
 * db.js keeps thin delegates in OPS (including the `_REC_COLS` / `_recToRow` / `_rowToRec`
 * internal surfaces) so db.call behavior, row shaping and the sync-apply contract are unchanged.
 */
const LIMITS = require('../../shared/limits.mjs') // focus-duration clamp constants (single source, audit item 4); require(esm) — Node >= 22.12
const dayjs = require('dayjs')
// electron-log only exists inside the packaged App; the standalone CLI (extraResources bundle) has no
// node_modules/electron-log, so fall back to a no-op logger instead of crashing at require time
let log
try { log = require('electron-log') } catch { log = { info () {}, warn () {}, error () {} } }

// ===== Tomato focus ledger: formal row storage (2026-09-04 root fix, plan_chips same pattern) =====
// Single source of truth for the ledger; LS keeps only timer transient state. All writers (main window / float window / CLI) go through these atomic ops,
// structurally eliminating the entire class of "multi-writer full-blob overwrite → deletion resurrected / new records erased" incidents.
const REC_COLS = ['endTime', 'dateKey', 'focus', 'focusTaskId', 'focusDuration', 'rest', 'restDuration', 'succeed', 'manual', 'status', 'abandonReason']

exports._REC_COLS = REC_COLS

exports._recToRow = r => {
  const o = { tomatoId: String(r.tomatoId) }
  for (const k of REC_COLS) {
    let v = r[k]
    if (k === 'endTime' || k === 'rest') v = Math.max(0, Math.round(Number(v) || 0))
    else if (k === 'focusDuration') v = Math.min(LIMITS.FOCUS_MAX_MINUTES, Math.max(0, Math.round(Number(v) || 0))) // clamp at the DB layer; P3 2026-09-17: lower bound is 0, not 1 — a bad value (0/NaN/garbage) must not be inflated into a phantom focus minute that LAN merge "max" then amplifies
    else if (k === 'restDuration') v = Math.min(LIMITS.REST_MAX_MINUTES, Math.max(0, Math.round(Number(v) || 0)))
    else if (k === 'succeed') v = v === false ? 0 : 1
    else if (k === 'manual') v = v ? 1 : 0
    o[k] = v == null ? null : v
  }
  // Preserve unknown/future fields as a JSON blob (won't be lost when writing back after forward-compatible reads)
  const known = new Set(['tomatoId', ...REC_COLS])
  const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
  const extra = {}
  for (const k of Object.keys(r || {})) if (!known.has(k) && !UNSAFE_KEYS.has(k)) extra[k] = r[k]
  o.extra = Object.keys(extra).length ? JSON.stringify(extra) : null
  // (2026-09-19) Deleted the old dead re-default here: the loop above already coerces succeed to 0/1
  return o
}

exports._rowToRec = r => {
  const rec = {
    tomatoId: r.tomatoId, endTime: r.endTime, dateKey: r.dateKey,
    focus: r.focus || '', focusTaskId: r.focusTaskId || null,
    focusDuration: r.focusDuration || 0, rest: r.rest || 0, restDuration: r.restDuration || 0,
    succeed: !!r.succeed, manual: !!r.manual, status: r.status || 'local', abandonReason: r.abandonReason || ''
  }
  if (r.extra) {
    try {
      // Key-filtered copy instead of Object.assign: JSON.parse materializes a "__proto__" own key
      // and assign's [[Set]] would turn it into a prototype swap on rec (security review 2026-09-11)
      const extra = JSON.parse(r.extra)
      for (const k of Object.keys(extra)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
        rec[k] = extra[k]
      }
    } catch (e) { /* corrupted extra fields do not block the main fields */ }
  }
  return rec
}

exports.tomatoAll = db => db.prepare('SELECT * FROM tomato_records WHERE deleted = 0 ORDER BY endTime DESC').all().map(exports._rowToRec)

// D6 P2 (2026-09-22): indexed by-id read for the ledger lock gate (handlers/todo.js used to run
// tomatoAll — a full-table scan ORDER BY endTime DESC — once per float tick under lock).
// deleted = 0 matches every reader (tomatoAll/tomatoByDay), so a tombstoned id reads as null.
exports.tomatoGetById = (db, tomatoId) => {
  const r = db.prepare('SELECT * FROM tomato_records WHERE tomatoId = ? AND deleted = 0').get(String(tomatoId))
  return r ? exports._rowToRec(r) : null
}

exports.tomatoTombstones = db => db.prepare('SELECT tomatoId, updatedAt, deletedAt FROM tomato_records WHERE deleted = 1').all()

exports.tomatoAppendMany = (db, rows) => {
  const list = Array.isArray(rows) ? rows : [rows]
  const now = Date.now()
  const ins = db.prepare(`INSERT INTO tomato_records (tomatoId, endTime, dateKey, focus, focusTaskId, focusDuration, rest, restDuration, succeed, manual, status, abandonReason, extra, deleted, deletedAt, updatedAt)
    VALUES (@tomatoId, @endTime, @dateKey, @focus, @focusTaskId, @focusDuration, @rest, @restDuration, @succeed, @manual, @status, @abandonReason, @extra, 0, 0, @updatedAt)
    ON CONFLICT(tomatoId) DO UPDATE SET endTime=excluded.endTime, dateKey=excluded.dateKey, focus=excluded.focus, focusTaskId=excluded.focusTaskId,
      focusDuration=excluded.focusDuration, rest=excluded.rest, restDuration=excluded.restDuration, succeed=excluded.succeed, manual=excluded.manual,
      status=excluded.status, abandonReason=excluded.abandonReason, extra=excluded.extra, deleted=0, deletedAt=0, updatedAt=excluded.updatedAt`)
  // F2 2026-09-15 行级容错(架构根因:批量接口的失败粒度应是"行级"而非"批级"):
  // 此前任一行缺 tomatoId/endTime 抛错回滚整批 → 渲染端 pending 队列被一条坏行劫持无限重试,
  // 同批合法账本行永不落库。现改为事务内跳过无效行并记入返回值 rejected,合法行照常落库;
  // renderer acknowledges the batch on fulfilment and logs rejected rows, then drops them from its
  // pending queue (报错以 console.error 上报,行按 rejected 索引剔除)。
  const rejected = []
  let accepted = 0
  const tr = db.transaction(() => list.forEach((raw, index) => {
    const reject = reason => rejected.push({
      index,
      tomatoId: raw && raw.tomatoId != null ? String(raw.tomatoId) : null,
      reason
    })
    if (!raw || !raw.tomatoId) { reject('tomatoId required'); return }
    if (!raw.endTime) { reject('endTime required'); return }
    // Strip the explicit updatedAt BEFORE _recToRow snapshots unknown keys into the extra blob
    // (main-ipc-9, see below); the stamp itself is re-read from raw at the ins.run site.
    const clean = Object.assign({}, raw); delete clean.updatedAt
    const r = exports._recToRow(Object.assign({ dateKey: '', succeed: true, manual: false }, clean))
    // main-ipc-9 (2026-09-22): the sync-apply path carries an explicit updatedAt (see stamp below);
    // without the strip above it leaked into the extra JSON blob via _recToRow's unknown-key
    // preservation (updatedAt is not a _REC_COLS column) — redundant storage read back on every
    // _rowToRec. Same `delete rec.updatedAt` contract as tomatoUpdateById.
    // dateKey 无条件由 endTime 重导(2026-09-04 深审 P0:三补录入口曾各按 startTs 落 dateKey,跨午夜记录与统计/时间轴 endTime 口径分裂)
    // dateKey 从调用方传入值起不再被信任,格式校验降级为派生后的防御断言
    r.dateKey = dayjs(r.endTime).format('YYYY-MM-DD')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.dateKey))) { reject('dateKey derive failed'); return }
    // M2 class, third instance (2026-09-21 D6, after settings/plan): an explicit positive updatedAt
    // (the sync-apply path carries the peer winner's LWW age, sync-apply.js pendingWrites.tomatoes)
    // must survive the bulk write — hard-restamping now() here made every applied ledger row read
    // newest-here and minted a fresh oplog delta per applied row (apply/push ping-pong, and the
    // older peer row then silently lost LWW on the origin). Parity with planAddMany: renderer/CLI
    // callers omit the stamp and get now().
    const stamp = Number(raw.updatedAt) > 0 ? Number(raw.updatedAt) : now
    ins.run({ ...r, updatedAt: stamp })
    accepted++
  }))
  tr()
  return { accepted, rejected }
}

exports.tomatoUpdateById = (db, { tomatoId, patch }) => {
  const cur = db.prepare('SELECT * FROM tomato_records WHERE tomatoId = ?').get(String(tomatoId))
  if (!cur) return false
  const rec = Object.assign(exports._rowToRec(cur), patch || {})
  // dateKey 双向强制 = dayjs(endTime):改 endTime 重导(改时间忘改日),只传 dateKey 也拒绝(脱离 endTime 的 dateKey patch = 幽灵行后门,2026-09-04 深审 P0)
  rec.dateKey = dayjs(rec.endTime).format('YYYY-MM-DD')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(rec.dateKey))) throw new Error('tomatoUpdateById: bad endTime produces invalid dateKey')
  delete rec.updatedAt // handled explicitly below; never leak the stamp into the extra JSON blob
  const r = exports._recToRow(rec)
  // `AND deleted = 0`: a tombstoned (removed) record is invisible to every reader — reporting success
  // on it would tell the caller a patch landed that nobody can ever see (review V1-F2)
  const res = db.prepare(`UPDATE tomato_records SET endTime=@endTime, dateKey=@dateKey, focus=@focus, focusTaskId=@focusTaskId,
    focusDuration=@focusDuration, rest=@rest, restDuration=@restDuration, succeed=@succeed, manual=@manual,
    status=@status, abandonReason=@abandonReason, extra=@extra, updatedAt=@updatedAt WHERE tomatoId=@tomatoId AND deleted = 0`)
    // M2 class parity (2026-09-21 D6): a patch may carry the sync winner's explicit updatedAt —
    // preserve it like tomatoAppendMany/planAddMany do; callers without a stamp keep local now.
    .run(Object.assign({ tomatoId: String(tomatoId), updatedAt: Number(patch && patch.updatedAt) > 0 ? Number(patch.updatedAt) : Date.now() }, r))
  return res.changes > 0
}

// Tombstone delete (P1 sync groundwork): ledger removals must propagate to other devices; every
// reader (tomatoAll/tomatoByDay) filters deleted=0, so behaviour matches the old physical delete.
// D11 finding 2 (parity with planRemoveIds R7 P1-2 / filterDelete): items may be plain ids
// (renderer/CLI) or {tomatoId, deletedAt, updatedAt} tombstone stamps (sync apply path) — the
// sync layer carries the winner's LWW age; local writers without a stamp keep local now.
exports.tomatoRemoveByIds = (db, ids, opts = {}) => {
  const list = Array.isArray(ids) ? ids : [ids]
  const del = db.prepare('UPDATE tomato_records SET deleted=1, deletedAt=?, updatedAt=? WHERE tomatoId = ?')
  const now = Date.now()
  const dAt = (opts && opts.deletedAt) || now
  const stamp = (opts && opts.updatedAt) || dAt
  const tr = db.transaction(() => list.forEach(i => {
    const o = (i && typeof i === 'object') ? i : null
    const id = o ? (o.tomatoId != null ? o.tomatoId : o.id) : i
    del.run((o && Number(o.deletedAt) > 0) ? Number(o.deletedAt) : dAt, (o && Number(o.updatedAt) > 0) ? Number(o.updatedAt) : stamp, String(id))
  }))
  tr()
  return true
}

// One-time migration: bulk-insert the full ledger from the old meta blob.
// 守卫不能只靠"表空"——用户删光账本后表空是合法状态,不删 meta blob 会整批复活已删记录(P0,并行审查实锤)。
// 所以:无论走哪条分支,迁移完成即删 meta blob;"blob 不存在"才是真正的已迁移哨兵。
exports.tomatoMigrateFromMeta = (db, stmts) => {
  const delBlob = () => { try { db.prepare('DELETE FROM meta WHERE key = ?').run('db.tomatoState') } catch { /* 清理失败不阻断 */ } }
  const n = db.prepare('SELECT COUNT(*) c FROM tomato_records').get().c
  if (n > 0) { delBlob(); return 0 }
  // 损坏 blob 不删(2026-09-10 P2):此前 JSON.parse 失败 catch 成 {} → list 空 → delBlob 直接把
  // 旧账本 blob 抹掉,记录永久丢失(可能只是磁盘位翻转/半截写入)。parse 失败 = warn + 返回 0
  // 保留 blob,下次(比如从备份恢复后)还有迁移机会;只有成功解析才走迁移/清理。
  // 纯解析逻辑抽到 fix-util.parseTomatoMetaBlob 便于 node --test 覆盖。
  const parsed = require('./fix-util').parseTomatoMetaBlob(stmts.getMeta.get('db.tomatoState')?.value)
  if (!parsed.ok) { log.warn('[TodoDB] tomatoMigrateFromMeta: 旧 meta blob 损坏(JSON 解析失败),保留 blob 不迁移不删除'); return 0 }
  const list = parsed.list
  if (!list.length) { delBlob(); return 0 }
  // D11 finding 10: tomatoAppendMany's failure granularity is per-ROW (a row missing
  // tomatoId/endTime or failing the dateKey derive is rejected, the batch still commits). Deleting
  // the blob unconditionally after a partial migration PERMANENTLY LOST every rejected record —
  // the blob was the only copy. A rejected row keeps the blob (the upserts are idempotent by
  // tomatoId, so the next boot re-migrates just the remainder); only a fully accepted batch
  // (or an empty-after-parse blob) deletes it.
  const res = exports.tomatoAppendMany(db, list)
  if (res.rejected.length) {
    log.warn(`[TodoDB] tomatoMigrateFromMeta: ${res.rejected.length} of ${list.length} blob rows rejected — blob KEPT for a retry next boot (unconditional delBlob would lose them)`)
    return res.accepted
  }
  delBlob()
  return res.accepted
}
