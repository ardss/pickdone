#!/usr/bin/env node
/**
 * LAN sync command group (status/pair/pair-respond/unpair) for cli/pickdone.js —
 * extracted unchanged from the switch case, comment block included (size ratchet: pure move).
 */
const dayjs = require('dayjs')

module.exports = async function runSync ({ opts, lib, emit }) {
      const [op] = opts._
      const fmtRound = v => (v ? dayjs(v).format('MM-DD HH:mm') : 'never')
      if (op === 'status' || op == null) {
        const seq = lib.writeSyncCmd({ action: 'status' })
        const ack = await lib.waitForSyncAck(seq)
        if (!ack) throw new lib.CliError('sync status failed: App is not running or did not consume the command (launch with: open)', 'APP_NOT_RUNNING')
        if (!ack.ok) throw new lib.CliError('sync status failed: ' + (ack.error || 'unknown'), 'SYNC_ERROR')
        const st = ack.status
        if (opts.json) return emit(st)
        const lines = []
        lines.push(`device: ${st.deviceName || '(unnamed)'} (${st.deviceId})`)
        lines.push(`sync: ${st.enabled ? 'enabled' : 'disabled'}  listening: ${st.listening ? 'yes' : 'no'}${st.port ? ' :' + st.port : ''}`)
        if (st.pendingPair) lines.push(`pending pair request from ${st.pendingPair.deviceName || st.pendingPair.host} (${st.pendingPair.deviceId || '?'}) — answer with: sync pair-respond`)
        for (const p of st.peers || []) {
          lines.push(`peer: ${p.name || '(unnamed)'}  ${p.deviceId}  ${p.host}:${p.port}  ${p.online ? 'online' : 'offline'}  state=${p.peerState || '-'}  pending=${p.pendingCount == null ? '-' : p.pendingCount}  lastRound=${fmtRound(p.lastRoundAt)}`)
        }
        if (!(st.peers || []).length) lines.push('peers: (none)')
        if (st.lastRoundAt) lines.push(`lastRound: ${fmtRound(st.lastRoundAt)}`)
        if (st.lastError) lines.push(`lastError: ${typeof st.lastError === 'string' ? st.lastError : JSON.stringify(st.lastError)}`)
        return console.log(lines.join('\n'))
      }
      if (op === 'pair') {
        const host = opts.host != null && opts.host !== true ? String(opts.host) : null
        if (!host) throw new lib.CliError('usage: sync pair --host <ip|host> [--port N] [--timeout S]  (--timeout default 90s; the responder confirm window is 60s)', 'USAGE')
        const port = parseInt(opts.port, 10) > 0 ? parseInt(opts.port, 10) : undefined
        // Also print our own pairing code: the peer can alternatively pair with the manual-code
        // flow (`sync pair-respond --code <code>`), useful when nobody can touch the responder.
        const codeSeq = lib.writeSyncCmd({ action: 'pairing-code' })
        const codeAck = await lib.waitForSyncAck(codeSeq)
        const ownCode = codeAck && codeAck.ok && codeAck.code && codeAck.code.code
        if (ownCode) console.log(`pairing code ${ownCode} (valid 10 min) — peer may alternatively run: sync pair-respond --code ${ownCode}`)
        const seq = lib.writeSyncCmd({ action: 'pair', host, port })
        const timeoutMs = Math.max(15, parseInt(opts.timeout, 10) || 90) * 1000
        const ack = await lib.waitForSyncAck(seq, timeoutMs)
        if (!ack) throw new lib.CliError('sync pair failed: App is not running, or the peer did not confirm within ' + Math.round(timeoutMs / 1000) + 's (its confirm window is 60s; re-run to retry)', 'APP_NOT_RUNNING')
        if (!ack.ok) throw new lib.CliError('sync pair failed: ' + (ack.error || 'unknown'), 'SYNC_ERROR')
        const st = ack.status
        if (opts.json) return emit({ paired: true, host, port: port || null, status: st })
        console.log(`✓ paired with ${host}:${port || 58471} — shared secret adopted, node restarted`)
        for (const p of st.peers || []) console.log(`  peer: ${p.name || p.deviceId} (${p.deviceId}) ${p.host}:${p.port} ${p.online ? 'online' : 'offline'}`)
        return
      }
      if (op === 'pair-respond') {
        const code = opts.code != null && opts.code !== true ? String(opts.code) : null
        if (code && !/^\d{6}$/.test(code)) throw new lib.CliError('--code must be exactly 6 digits', 'USAGE')
        const seq = lib.writeSyncCmd({ action: 'pair-respond', code, accept: opts.reject !== true })
        const timeoutMs = Math.max(15, parseInt(opts.timeout, 10) || 60) * 1000
        const ack = await lib.waitForSyncAck(seq, timeoutMs)
        if (!ack) throw new lib.CliError('sync pair-respond failed: App is not running or did not consume the command', 'APP_NOT_RUNNING')
        if (!ack.ok) throw new lib.CliError('sync pair-respond failed: ' + (ack.error || 'unknown'), 'SYNC_ERROR')
        if (opts.json) return emit({ responded: true, accept: opts.reject !== true, result: ack.result || null })
        console.log(`✓ pair request ${opts.reject === true ? 'rejected' : 'accepted'}${code ? ' (code flow, secret adopted)' : ''}`)
        // syncPairWithCode's result carries the fresh status payload (peers included); the plain
        // respond path returns {ok,accept} only.
        for (const p of (ack.result && ack.result.peers) || []) console.log(`  peer: ${p.name || p.deviceId} (${p.deviceId}) ${p.host}:${p.port} ${p.online ? 'online' : 'offline'}`)
        return
      }
      if (op === 'unpair') {
        const device = opts.device != null && opts.device !== true ? String(opts.device) : null
        if (!device) throw new lib.CliError('usage: sync unpair --device <deviceId>  (sync status to list ids; rotates the shared secret — every peer must re-pair)', 'USAGE')
        const seq = lib.writeSyncCmd({ action: 'unpair', deviceId: device })
        const ack = await lib.waitForSyncAck(seq)
        if (!ack) throw new lib.CliError('sync unpair failed: App is not running or did not consume the command', 'APP_NOT_RUNNING')
        if (!ack.ok) throw new lib.CliError('sync unpair failed: ' + (ack.error || 'unknown'), 'SYNC_ERROR')
        if (opts.json) return emit({ unpaired: device, result: ack.result || null })
        return console.log(`✓ unpaired ${device} — shared secret rotated, remaining peers must re-pair`)
      }
      throw new lib.CliError('usage: sync <status|pair|pair-respond|unpair>  (pair needs --host; pair-respond accepts --code NNNNNN or answers a pending request; unpair needs --device)', 'USAGE')
}
