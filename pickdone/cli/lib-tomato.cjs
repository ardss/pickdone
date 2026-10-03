#!/usr/bin/env node
/**
 * Tomato command group (list/record/status/start/stop/attach/backfill) for cli/pickdone.js —
 * extracted unchanged from the switch case (size ratchet: pure move).
 */
const dayjs = require('dayjs')
const fixUtil = require('../src/main/fix-util.js') // P3-8: localDayKey single source

module.exports = async function runTomato ({ opts, lib, emit, emitNext }) {
      const [op, ...rest] = opts._
      /* The App REJECTS a stale command (>60s TTL, crash-replay protection) by writing an expired
       * receipt {status:'expired', error} — which still satisfies waitForTomatoAck's seq match.
       * Treating that truthy ack as success printed "✓ focus started" for a command the App never
       * executed: the exact fake-success the waitForTomatoAck gate exists to prevent. Surface it
       * as a real error, same shape as the null-ack APP_NOT_RUNNING path. */
      function assertLiveAck (ack, what) {
        if (ack && ack.status === 'expired') {
          throw new lib.CliError('tomato ' + what + ' failed: command expired before the App consumed it (' + ((ack && ack.error) || 'stale command') + ')', 'CMD_EXPIRED')
        }
        return ack
      }
      /* ---- tomato list: read-only query of the focus ledger (SQLite tomato_records row table; same source as the statistics page, works without the App) ---- */
      if (op === 'list') {
        let recs = lib.tomatoRecords().sort((a, b) => (b.endTime || 0) - (a.endTime || 0))
        const date = opts.date ? String(opts.date) : null
        if (date && date !== 'today' && date !== 'yesterday') {
          const d = lib.parseDate(date)
          recs = recs.filter(r => r.dateKey === dayjs(d).format('YYYY-MM-DD'))
        } else if (date === 'today') recs = recs.filter(r => r.dateKey === dayjs().format('YYYY-MM-DD'))
        else if (date === 'yesterday') recs = recs.filter(r => r.dateKey === dayjs().subtract(1, 'day').format('YYYY-MM-DD'))
        const taskRef = opts.task != null && opts.task !== true ? opts.task : rest[0]
        if (taskRef) {
          const t = lib.resolveTask(taskRef, lib.liveTasks())
          recs = recs.filter(r => r.focusTaskId === t.taskId || (r.focus || '').includes(t.taskContent))
        }
        const limit = Math.max(1, Math.min(200, parseInt(opts.n || opts.limit, 10) || 30))
        recs = recs.slice(0, limit)
        // The focus text may be a stale task name after re-attachment (same semantics as the UI: consumers resolve by focusTaskId) — resolve the task name live at display time
        const live = lib.liveTasks()
        const nameOf = r => {
          if (r.focusTaskId) { const t = live.find(x => x.taskId === r.focusTaskId); if (t) return t.taskContent }
          return r.focus || ''
        }
        if (opts.json) {
          return emit(recs.map(r => ({ ...r, focus: nameOf(r) })))
        }
        if (!recs.length) return console.log('(no focus records match)')
        for (const r of recs) {
          const start = r.endTime ? dayjs(r.endTime - (r.focusDuration || 0) * 60000).format('MM-DD HH:mm') : '—'
          const end = r.endTime ? dayjs(r.endTime).format('HH:mm') : ''
          console.log(`${r.dateKey}  ${start}~${end}  ${r.focusDuration || 0}min${r.restDuration ? '+' + r.restDuration + 'min rest' : ''}  ${r.succeed === false ? '✗abandoned' : '✓'}${r.manual ? ' (backfilled)' : ''}  ${nameOf(r) || '(free focus)'}`)
        }
        console.log(`-- ${recs.length} record(s)`)
        return
      }
      if (op === 'record') {
        // ---- Fix/delete ledgered focus records (correcting wrong durations / mistaken backfills; direct ledger row writes, works without the App) ----
        const [rop, ref] = rest
        if (rop === 'rm' || rop === 'remove' || rop === 'delete') {
          if (!ref) throw new lib.CliError('usage: tomato record rm <tomatoId|prefix>  (tomato list to browse ids)', 'USAGE')
          const { rec } = lib.recordRemove(ref) // 账本行直删,无需 App 运行
          if (opts.json) return emit({ removed: rec.tomatoId, dateKey: rec.dateKey, minutes: rec.focusDuration })
          return console.log(`✓ record removed: ${rec.dateKey} ${rec.focusDuration}min ${rec.focus || '(free focus)'}`)
        }
        if (rop === 'fix') {
          if (!ref) throw new lib.CliError('usage: tomato record fix <tomatoId|prefix> [--minutes N] [--date D --at HH:mm] [--rest N] [--succeed yes|no] [--task <kw|--free>]', 'USAGE')
          const { rec } = lib.recordFix(ref, {
            minutes: opts.minutes, date: opts.date, at: opts.at, rest: opts.rest,
            succeed: opts.succeed,
            task: opts.task != null && opts.task !== true ? opts.task : undefined,
            free: opts.free === true
          })
          const after = lib.resolveRecord(rec.tomatoId)
          const live = lib.liveTasks()
          const nt = after.focusTaskId ? live.find(x => x.taskId === after.focusTaskId) : null
          const shown = nt ? nt.taskContent : (after.focus || '(free focus)')
          if (opts.json) return emit({ fixed: after.tomatoId, dateKey: after.dateKey, focusDuration: after.focusDuration, restDuration: after.restDuration, succeed: after.succeed, focus: shown })
          return console.log(`✓ record fixed: ${after.dateKey} ${after.focusDuration}min${after.restDuration ? '+' + after.restDuration + 'min rest' : ''} ${after.succeed === false ? '✗abandoned' : '✓'} ${shown}`)
        }
        throw new lib.CliError('unknown sub-operation "' + rop + '" (valid: fix/rm)', 'UNKNOWN_ARG')
      }
      if (op === 'status') {
        const st = lib.readTomatoState()
        if (!st) {
          const unknown = { status: 'unknown', remainSec: null, tomatoTime: null, attach: null, todayTomatoCount: null, note: 'App has not written state yet (not running or too old)' }
          if (opts.json) return emit(unknown)
          return console.log(unknown.note)
        }
        const running0 = st.status === 'startTomatoTime' || st.status === 'startRestTime'
        // In idle the App no longer writes back, so state inevitably ages — only judge stale while running
        const stale = running0 && (!st.at || Date.now() - st.at > 5000)
        const remain = lib.tomatoLiveRemainSec(st)
        const tag = { startTomatoTime: 'focusing', startRestTime: 'resting', default: 'idle' }[st.status] || st.status
        if (opts.json) return emit({ ...st, remainSec: remain, stale, status: tag })
        console.log(`${tag}${stale ? ' (stale)' : ''}` +
          (running0 ? `  ${Math.max(0, Math.round(remain / 60))} min left` : '') +
          `  ${st.todayTomatoCount} today` + (st.attach ? `  attached: ${st.attach.content}` : ''))
        return
      }
      if (op === 'start') {
        let taskId = null
        const taskRef = opts.task
        if (taskRef) {
          const t = lib.resolveTask(taskRef, lib.liveTasks()) // live pool only (recycle bin cannot attach)
          taskId = t.taskId
        }
        const minutes = parseInt(opts.minutes, 10)
        const seq = lib.writeTomatoCmd({ action: 'start', taskId, minutes: minutes > 0 ? minutes : null })
        // HELP contract: error out when the App is not running instead of faking success. Wait for the receipt to catch up; timeout = command not consumed
        const ack = assertLiveAck(await lib.waitForTomatoAck(seq), 'start')
        if (!ack) throw new lib.CliError('tomato start failed: App is not running or did not consume the command (launch with: open)', 'APP_NOT_RUNNING')
        if (opts.json) return emitNext({ seq, taskId, minutes: minutes > 0 ? minutes : null, acknowledged: true }, ['tomato status --json for countdown', 'tomato stop to stop'])
        console.log('✓ focus started' + (taskId ? ' (attached task ' + taskId + ')' : '') + (minutes > 0 ? ' for ' + minutes + ' min' : ''))
        return
      }
      if (op === 'stop') {
        const seq = lib.writeTomatoCmd({ action: 'stop', reason: opts.reason || '', record: !opts['no-record'] })
        const ack = assertLiveAck(await lib.waitForTomatoAck(seq), 'stop')
        if (!ack) throw new lib.CliError('tomato stop failed: App is not running or did not consume the command', 'APP_NOT_RUNNING')
        if (opts.json) return emitNext({ seq, record: !opts['no-record'], acknowledged: true }, ['tomato status --json to confirm idle', 'stats --json to see focus records'])
        console.log('✓ stopped' + (opts['no-record'] ? ' (no record)' : ' (records by focused minutes)'))
        return
      }
      if (op === 'attach') {
        const ref = rest[0]
        let taskId = null
        if (ref && ref !== '--none' && ref !== 'none') {
          taskId = lib.resolveTask(ref, lib.liveTasks()).taskId
        }
        const seq = lib.writeTomatoCmd({ action: 'attach', taskId })
        // 与 start/stop 同契约等回执:App 未运行时不再谎报成功(2026-09-04 深审 P0,同命令族三种契约曾让 JSON 消费者无统一判断路径)
        const ack = assertLiveAck(await lib.waitForTomatoAck(seq), 'attach')
        if (!ack) throw new lib.CliError('tomato attach failed: App is not running or did not consume the command', 'APP_NOT_RUNNING')
        if (opts.json) return emit({ seq, taskId, acknowledged: true })
        console.log(taskId ? '✓ tomato task attached ' + taskId : '✓ tomato task detached')
        return
      }
      if (op === 'backfill') {
        /* Backfill: user says "I did X during this slot, log it for me" — record a focus block into the ledger at a given date/time
           (manual:true is a real record, increments the actual pomodoro count, reconcilable on the 24h timeline; same semantics as the UI's right-click one-click backfill).
           CLI 直写 tomato_records 行表,App 关闭也可用;App 运行中经 tomato-records-changed 广播即时回灌。 */
        const ref = opts.task || rest[0] || (opts.free ? '--free' : undefined)
        if (!ref) throw new lib.CliError('usage: tomato backfill <taskId|keyword|--free> [--date today|YYYY-MM-DD] [--minutes 25] [--at HH:mm]  (--free = free focus, not attached to a task)', 'USAGE')
        let taskId = null
        let content = ''
        if (ref !== '--free' && ref !== 'free') {
          const t = lib.resolveTask(ref, lib.liveTasks())
          taskId = t.taskId
          content = t.taskContent
        }
        // Local-timezone YYYY-MM-DD (do not use toISOString: UTC shifts the whole block by a day for evening use)
        const localYmd = fixUtil.localDayKey // P3-8: single source localDayKey (src/main/fix-util.js)
        const dateStr = (raw => {
          if (raw === undefined || raw === true || raw === 'today' || raw === '') return localYmd(new Date())
          if (raw === 'tomorrow') { const d = new Date(); d.setDate(d.getDate() + 1); return localYmd(d) }
          if (raw === 'yesterday') { const d = new Date(); d.setDate(d.getDate() - 1); return localYmd(d) }
          const rel = /^\+(\d+)d$/.exec(raw)
          if (rel) { const d = new Date(); d.setDate(d.getDate() + parseInt(rel[1], 10)); return localYmd(d) }
          return raw
        })(opts.date)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
          throw new lib.CliError('bad --date "' + opts.date + '" (use today/tomorrow/+Nd/YYYY-MM-DD)', 'USAGE')
        }
        const at = (opts.at && opts.at !== true) ? String(opts.at) : '20:00'
        if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(at)) throw new lib.CliError('bad --at "' + opts.at + '" (use HH:mm, 24h)', 'USAGE')
        const minutes = parseInt(opts.minutes, 10) > 0 ? parseInt(opts.minutes, 10) : 25
        const rec = lib.backfillRecord({ taskId, content, date: dateStr, at, minutes })
        if (opts.json) return emitNext({ tomatoId: rec.tomatoId, dateKey: rec.dateKey, minutes: rec.focusDuration, acknowledged: true }, ['stats --json to see focus minutes', 'list --json to read back'])
        console.log(`✓ backfilled ${rec.focusDuration} min on ${rec.dateKey} ${at}` + (taskId ? ' → ' + (content || taskId) : ' (free focus, no task)'))
        return
      }
      throw new lib.CliError('usage: tomato <status|start|stop|attach|backfill> (start accepts --task/--minutes; backfill accepts --task/--free/--date/--minutes/--at)', 'USAGE')
}
