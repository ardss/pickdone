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
        // cli-15 fail-fast: a null or !ok codeAck used to be swallowed (`ownCode` just stayed
        // falsy) and the flow SILENTLY continued into the actual pair attempt — the operator saw
        // no local code and no hint that the first leg already failed. Fail loudly instead.
        if (!codeAck) throw new lib.CliError('sync pair failed: no ack for the pairing-code request (App is not running or did not consume the command; launch with: open)', 'APP_NOT_RUNNING')
        if (!codeAck.ok) throw new lib.CliError('sync pair failed: pairing-code request failed: ' + (codeAck.error || 'unknown'), 'SYNC_ERROR')
        const ownCode = codeAck.code && codeAck.code.code
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
      if (op === 'enable' || op === 'disable') {
        // 2026-10-09 real-device drill: headless node toggle over the command bus — the same
        // syncSetEnabled dispatch the settings switch uses, so mDNS advertise/listen lifecycle
        // is owned by the bootstrap exactly as in the UI path (the only previous toggle path
        // was the settings window; SSH/CLI hosts had nothing).
        const enabled = op === 'enable'
        const seq = lib.writeSyncCmd({ action: 'set-enabled', enabled })
        const ack = await lib.waitForSyncAck(seq)
        if (!ack) throw new lib.CliError(`sync ${op} failed: App is not running or did not consume the command`, 'APP_NOT_RUNNING')
        if (!ack.ok) throw new lib.CliError(`sync ${op} failed: ` + (ack.error || 'unknown'), 'SYNC_ERROR')
        if (opts.json) return emit({ enabled, status: ack.status })
        const st = ack.status || {}
        return console.log(`✓ LAN sync ${enabled ? 'enabled' : 'disabled'} — listening: ${st.listening ? 'yes' : 'no'}${st.port ? ' :' + st.port : ''}`)
      }
      if (op === 'v2') {
        // Sync v2 write-path flag (machine-local by design — sync.* keys are denied
        // on the settings surface, so this gets its own verb on the direct-DB path).
        // Immediate effect: db-revisions reads the flag per write, no app restart needed.
        const mode = opts._[1]
        if (mode === 'on' || mode === 'off') {
          const r = lib.open().call('revisionsFlag', { on: mode === 'on' })
          return console.log(`sync v2 revision recording: ${r.on ? 'ON' : 'OFF'}${mode === 'on' ? ' — writes now mint immutable revisions (v1 LAN sync unaffected)' : ''}`)
        }
        if (mode === 'state' || mode == null) {
          return console.log(`sync v2 revision recording: ${lib.open().call('revisionsFlagState').on ? 'ON' : 'OFF'}`)
        }
        throw new lib.CliError('usage: sync v2 <on|off|state>', 'USAGE')
      }
      if (op === 'relay') {
        // 2026-10-11 (journey-relay): OPTIONAL remote relay transport, headless — same
        // db-sync-ops surface the Device Center will use; main/CLI only by design
        // (not renderer-whitelisted yet). Non-loopback relays need TODO_RELAY_ALLOW_REMOTE=1.
        const sub = opts._[1]
        if (sub === 'status' || sub == null) {
          const seq = lib.writeSyncCmd({ action: 'relay-status' })
          const ack = await lib.waitForSyncAck(seq)
          if (!ack) throw new lib.CliError('sync relay status failed: App is not running or did not consume the command', 'APP_NOT_RUNNING')
          // NOTE: deliberately NOT `st` — the status-payload contract test scans every
          // `st.<field>` read in this file against the LAN-sync payload contract; the
          // relay status is a DIFFERENT payload (relayGetStatus) with its own fields.
          const rs = ack.status
          if (opts.json) return emit(rs)
          return console.log([
            `relay: ${rs.enabled ? 'enabled' : 'disabled'}  account: ${rs.account || '-'}  baseUrl: ${rs.baseUrl || '-'}`,
            `registered: ${rs.registered ? 'yes' : 'no'}  cursor: ${rs.cursor}  polling: ${rs.polling ? 'yes' : 'no'}`,
            `rounds: ${rs.rounds}  pushed: ${rs.pushedTotal}  pulled: ${rs.pulledTotal}  quarantined: ${rs.quarantinedTotal}  applied: ${rs.appliedTotal}`,
            rs.lastError ? `lastError: ${rs.lastError}` : 'lastError: none',
          ].join('\n'))
        }
        if (sub === 'enable') {
          const account = opts.account != null && opts.account !== true ? String(opts.account) : null
          const baseUrl = opts['base-url'] != null && opts['base-url'] !== true ? String(opts['base-url']) : null
          const rootKey = opts['root-key'] != null && opts['root-key'] !== true ? String(opts['root-key']) : null
          const enrollment = opts.enrollment != null && opts.enrollment !== true ? String(opts.enrollment) : null
          if (!account || !baseUrl) throw new lib.CliError('usage: sync relay enable --account <id> --base-url <origin> [--root-key <64hex>] [--enrollment <secret>]  (remote relay also needs TODO_RELAY_ALLOW_REMOTE=1)', 'USAGE')
          const seq = lib.writeSyncCmd({ action: 'relay-enable', account, baseUrl, rootKey, enrollment })
          const ack = await lib.waitForSyncAck(seq)
          if (!ack) throw new lib.CliError('sync relay enable failed: App is not running or did not consume the command', 'APP_NOT_RUNNING')
          if (!ack.ok) throw new lib.CliError('sync relay enable failed: ' + (ack.error || 'unknown'), 'SYNC_ERROR')
          if (opts.json) return emit(ack.result)
          return console.log(`✓ relay enabled for ${account} @ ${baseUrl}${ack.result && ack.result.firstRound ? ` (first round: ${JSON.stringify(ack.result.firstRound)})` : ''}`)
        }
        if (sub === 'sync') {
          const seq = lib.writeSyncCmd({ action: 'relay-sync' })
          const ack = await lib.waitForSyncAck(seq)
          if (!ack) throw new lib.CliError('sync relay sync failed: App is not running or did not consume the command', 'APP_NOT_RUNNING')
          if (opts.json) return emit(ack.result)
          const r = ack.result || {}
          if (!r.ok) return console.log(`✗ relay round failed: ${r.error || r.skipped || 'unknown'}`)
          return console.log(`✓ relay round ok — pushed ${r.pushed}  pulled ${r.pulled}  quarantined ${r.quarantined}  applied ${r.businessApplied}  cursor ${r.cursor}`)
        }
        if (sub === 'disable') {
          const seq = lib.writeSyncCmd({ action: 'relay-disable' })
          const ack = await lib.waitForSyncAck(seq)
          if (!ack) throw new lib.CliError('sync relay disable failed: App is not running or did not consume the command', 'APP_NOT_RUNNING')
          if (opts.json) return emit(ack.result)
          return console.log('✓ relay disabled (config + secrets retained)')
        }
        if (sub === 'forget') {
          const seq = lib.writeSyncCmd({ action: 'relay-forget' })
          const ack = await lib.waitForSyncAck(seq)
          if (!ack) throw new lib.CliError('sync relay forget failed: App is not running or did not consume the command', 'APP_NOT_RUNNING')
          if (opts.json) return emit(ack.result)
          return console.log('✓ relay identity forgotten (secrets + durable state cleared)')
        }
        throw new lib.CliError('usage: sync relay <status|enable|sync|disable|forget>  (enable needs --account + --base-url; remote relay also needs TODO_RELAY_ALLOW_REMOTE=1)', 'USAGE')
      }
      throw new lib.CliError('usage: sync <status|enable|disable|pair|pair-respond|unpair|v2|relay>  (pair needs --host; pair-respond accepts --code NNNNNN or answers a pending request; unpair needs --device; v2 flips revision recording; relay drives the remote transport)', 'USAGE')
}
