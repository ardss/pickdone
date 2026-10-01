/* Node event wiring, extracted from lan-sync-bootstrap.js (2026-09-27 structure size ratchet).
 * Same injected-deps pattern as lan-sync/paired-peers.js / lan-sync/peer-extras.js: the
 * bootstrap's swappable module-level `state` (via getState) still applies, so __test.setState
 * keeps working. The pair-request handler stays in the bootstrap (source-anchored by
 * tests/unit/components/device-center-sync-tab.test.mjs). */
module.exports = ({ getState, emitSyncEvent, notifyRenderers, kickSyncRound, scheduleSecurityPersist,
  persistPairedPeer, normalizeHost, loadPairedPeers, manualPeers, DEFAULT_PORT, log }) => {
  function wireNodeEvents () {
    const state = getState()
    state.node.on('round-error', info => {
      log.warn('[LanSync] round error:', info && info.error)
      emitSyncEvent('round-error', { deviceId: info && info.peer, detail: info && info.error && info.error.message })
      notifyRenderers('round-error')
    })
    // Server-role failures (round-3 review, loud EADDRINUSE): a fixed-port collision or another
    // listener-level error must be VISIBLE — log.error + Device Center syncEvent + status
    // lastError (the node already records err.message into its getStatus().lastError).
    state.node.on('server-error', err => {
      log.error('[LanSync] server error:', err && err.message)
      emitSyncEvent('server-error', { detail: err && err.message, code: err && err.code })
      notifyRenderers('round-error')
    })
    state.node.on('round-done', info => emitSyncEvent('round-done', { deviceId: info && info.peer, applied: info && info.applied }))
    // Snapshot-request protocol activity for the Device Center feed (sent = we served a peer's
    // snapshot-request; received = we recovered via a peer's full snapshot).
    state.node.on('snapshot-sync', info => emitSyncEvent('snapshot-sync', {
      deviceId: info && info.peer, direction: info && info.direction, rows: info && info.rows,
    }))
    state.node.on('peer-online', p => { emitSyncEvent('peer-online', { deviceId: p.deviceId, deviceName: p.name, host: p.host }); kickSyncRound('peer-online') })
    state.node.on('peer-offline', p => emitSyncEvent('peer-offline', { deviceId: p.deviceId, deviceName: p.name, host: p.host }))
    state.node.on('pair-throttled', info => emitSyncEvent('pair-throttled', { ip: info && info.ip }))
    // Security-ring persistence: pair-throttled / auth-rejected entries survive restarts via
    // settings_rows (bounded to the node's 20-entry ring, write-throttled).
    state.node.on('security-entry', () => scheduleSecurityPersist())
    state.node.on('pair-accepted', info => emitSyncEvent('pair-accepted', { host: info && info.host, port: info && info.port }))
    state.node.on('pair-rejected', info => emitSyncEvent('pair-rejected', { host: info && info.host, port: info && info.port, reason: info && info.reason }))
    // Inbound pairing completed (manual code or confirmed): tell the renderer it succeeded AND
    // (round-1 P0) immediately register + persist the peer from the ACTUAL TCP remote address —
    // the inbound side always knows the peer's reachable address from its own socket.
    state.node.on('paired-inbound', info => {
      emitSyncEvent('pair-accepted', { deviceId: info && info.deviceId, host: info && info.host })
      try {
        if (!info || !info.deviceId || info.deviceId === state.deviceId) return
        // Per-instance-port fix (2026-10-01 journey drill): the old `port: myPort` here recorded
        // OUR OWN listen port as the peer's dial address — only correct while every instance
        // bound the same fixed 58471. With per-instance TODO_SYNC_PORT overrides the acceptor
        // dialed ITSELF, hit the self-connection guard and the peer entry was removed ("peer
        // removed this pairing"). The peer's real port now arrives on the wire (pair-request
        // listenPort, transport onPaired); myPort stays the legacy fallback for old peers.
        const myPort = (state.node && state.node.getStatus().port) || DEFAULT_PORT
        const peerPort = (Number.isInteger(info.port) && info.port > 0 && info.port <= 65535) ? info.port : myPort
        // F1: the per-pair secret rides on paired-inbound (transport mints it at accept time)
        // and is persisted in the peer record + fed to the live node entry for dialing.
        persistPairedPeer({ deviceId: info.deviceId, name: info.deviceName, host: info.host, port: peerPort, secret: info.secret })
        if (state.node) state.node.addPeer({ deviceId: info.deviceId, name: info.deviceName, host: normalizeHost(info.host) || undefined, port: peerPort, secret: info.secret })
        kickSyncRound('paired-inbound')
      } catch (e) { log.warn('[LanSync] paired-inbound persist failed:', e.message) }
    })
    // Round-1 P0: an authenticated connection proves the peer's ACTUAL reachable address — refresh
    // the persisted record (and the live node entry) from socket remoteAddress, never from the
    // stale/cached discovery value. Change-gated inside persistPairedPeer (no write amplification).
    // Per-instance-port fix (2026-10-01 journey drill): the dial-back port is the peer's
    // hello-advertised listenPort. When it is ABSENT (legacy peer, or their server had not bound
    // yet when this round dialed) we must NOT substitute myPort — in the split-port world that
    // pointed our own dial address back at ourselves (self-connection guard -> forgetPeer ->
    // secret-less re-discovery -> stale-global dial -> "peer removed this pairing"). Passing null
    // keeps the previous record/entry port instead (persistPairedPeer / rememberPeer semantics).
    state.node.on('peer-connected', p => {
      try {
        if (!p || !p.deviceId || p.deviceId === state.deviceId) return
        const peerPort = (Number.isInteger(p.listenPort) && p.listenPort > 0 && p.listenPort <= 65535) ? p.listenPort : null
        if (persistPairedPeer({ deviceId: p.deviceId, host: p.host, port: peerPort }) && state.node) {
          const h = normalizeHost(p.host)
          if (h) state.node.addPeer({ deviceId: p.deviceId, host: h, port: peerPort })
        }
      } catch (e) { log.warn('[LanSync] peer-connected persist failed:', e.message) }
    })
    state.node.on('peer-unauthorized', info => {
      log.warn('[LanSync] unauthorized peer rejected (terminal until re-pair):', info && info.deviceId, 'from', info && info.host, info && info.error)
      // P1-3b: terminal state — the Device Center renders peers[].peerState === 'unpaired'
      // (status payload) as "已被对方解除配对,请重新配对". Emitted ONCE per rejection; the node
      // stops dialing that peer until user action.
      emitSyncEvent('peer-unauthorized', { deviceId: info && info.deviceId, host: info && info.host, terminal: true })
    })
  }

  // restore manually added peers (node peer table is memory-only; settings_rows is the authority)
  function restorePeers (deviceId) {
    const state = getState()
    for (const mp of manualPeers()) {
      try { state.node.addPeer({ deviceId: 'manual-' + mp.host + ':' + mp.port, host: mp.host, port: Number(mp.port) }) } catch (e) { log.warn('[LanSync] manual peer restore failed:', e.message) }
    }
    // Round-1 P0: restore PAIRED peers — without this the peer table was memory-only and
    // `sync status` reported peers:(none) after every restart even though pairing state survived.
    for (const p of Object.values(loadPairedPeers())) {
      try {
        if (!p || !p.deviceId || p.deviceId === deviceId || !p.host) continue
        state.node.addPeer({ deviceId: p.deviceId, name: p.name, host: p.host, port: Number(p.port) || DEFAULT_PORT, secret: p.secret })
      } catch (e) { log.warn('[LanSync] paired peer restore failed:', e.message) }
    }
  }

  return { wireNodeEvents, restorePeers }
}
