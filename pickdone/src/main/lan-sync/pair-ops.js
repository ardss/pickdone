/* Pairing / unpair IPC op bodies, extracted from lan-sync-bootstrap.js (2026-09-27 structure
 * size ratchet). Same injected-deps pattern as lan-sync/paired-peers.js: the bootstrap's
 * swappable module-level `state` (via getState) still applies, so __test.setState keeps working.
 * Registration stays in the bootstrap's registerOps (cli/check-command-bus.cjs anchors the
 * sync-conflict-backups spread there); only the handler bodies moved. */
const { timingSafeEqual } = require('node:crypto')
const { generatePairingSecret, derivePairingCode } = require('../../../shared/sync-core/pairing.mjs')

module.exports = ({ getState, settingGet, settingPut, busWrite, getSettingsPayload, ensureIdentity,
  stopSync, startSync, runRound, persistPeerWatermarks, persistPairedPeer, removePairedPeer,
  manualPeers, loadPeerWatermarks, notifyRenderers, emitSyncEvent,
  K_PAIRING_SECRET, K_DEVICE_NAME, K_MANUAL_PEERS, K_PEER_WATERMARKS, K_ENABLED,
  K_PEER_ALIAS_PREFIX, PAIRING_CODE_TTL_MS, DEFAULT_PORT, log }) => {
  /* ---------- P1-3 (2026-09-19 UX review): unpair a device ---------- */
  /**
   * Remove a paired device: drop its manual peer record + push watermark and REVOKE the shared
   * pairing secret. Documented consequence (surfaced in the confirm dialog): pairing uses a single
   * shared secret, so rotating it disconnects EVERY previously paired device — the unpaired peer's
   * authenticated hello now fails (peer-unauthorized = syncing with it is paused) and both sides
   * must re-pair to resume.
   */
  async function syncUnpairPeerOp (p) {
    const state = getState()
    const deviceId = String((p && p.deviceId) || '').trim()
    if (!deviceId) throw new Error('syncUnpairPeer: deviceId is required')
    if (!state.node) throw new Error('syncUnpairPeer: sync is not enabled')
    // Resolve host/port from the live status so the manual-peer record (keyed by host:port) can go.
    let host = null
    let port = null
    try {
      const peer = (state.node.getStatus().peers || []).find(x => x && x.deviceId === deviceId)
      if (peer) { host = peer.host; port = peer.port }
    } catch { /* status read is best-effort; the rest still applies */ }
    if (host) {
      const rest = manualPeers().filter(x => !(x.host === host && Number(x.port) === Number(port)))
      settingPut(K_MANUAL_PEERS, JSON.stringify(rest))
      try { state.node.removePeer(String('manual-' + host + ':' + port)) } catch { /* older nodes: entry dies with the next restart */ }
    }
    // Round-1 P0: drop the persisted paired-peer record too (it keyed the stale address the manual
    // record mirrored); re-pairing then starts from a clean table instead of merging into it.
    removePairedPeer(deviceId)
    // Drop the per-peer push watermark (a stale watermark must not survive a revoked pairing).
    try {
      const wm = loadPeerWatermarks()
      if (wm[deviceId] != null) {
        delete wm[deviceId]
        settingPut(K_PEER_WATERMARKS, JSON.stringify(wm))
        if (state.peerWatermarks && typeof state.peerWatermarks.delete === 'function') state.peerWatermarks.delete(deviceId)
      }
    } catch (e) { log.warn('[LanSync] watermark drop failed:', e.message) }
    // Revoke the shared secret: the removed peer (and any other existing peer) can no longer
    // authenticate until re-paired. Restart so the node advertises/authenticates with the new one.
    settingPut(K_PAIRING_SECRET, generatePairingSecret())
    state.pairingCode = null
    // P1-4 (2026-09-19 data-safety round): best-effort tell the unpaired peer while a connection
    // may still be live — it can then forget OUR peer record and enter its terminal unpaired
    // state instead of auth-retrying forever. Never blocks the unpair flow. Round-1 P0: guard the
    // method existence (a stale/older node reference threw `notifyUnpaired is not a function`).
    if (state.node && typeof state.node.notifyUnpaired === 'function') {
      try { const notified = state.node.notifyUnpaired(deviceId); log.info('[LanSync] unpaired notify to', deviceId, notified ? 'delivered' : 'no live connection (peer will discover via auth rejection)') } catch (e) { log.warn('[LanSync] unpaired notify failed:', e.message) }
    }
    await stopSync()
    if (settingGet(K_ENABLED) === true) startSync()
    notifyRenderers('peer-unpaired')
    emitSyncEvent('peer-unpaired', { deviceId, host })
    log.info('[LanSync] unpaired', deviceId, '- shared secret revoked (all peers must re-pair)')
    return { ...getSettingsPayload(), unpaired: deviceId }
  }

  const syncPairWithCode = async p => {
    const state = getState()
    const code = String((p && p.code) || '').trim()
    if (!/^\d{6}$/.test(code)) throw new Error('syncPairWithCode: 6-digit code required')
    if (!state.node) throw new Error('syncPairWithCode: sync is not enabled')
    const r = await state.node.pairWith(p && p.deviceId || undefined, code)
    settingPut(K_PAIRING_SECRET, String(r.secret))
    // Round-1 P0: persist the paired peer from the address the pair ACTUALLY succeeded on (the
    // dialed host:port), so the record survives restart and re-pairing overwrites any stale one.
    if (r.peer && r.peer.deviceId) {
      persistPairedPeer({ deviceId: r.peer.deviceId, name: r.peer.name, host: r.peer.host, port: r.peer.port })
    }
    log.info('[LanSync] paired with peer', r.peer && r.peer.deviceId, '- shared secret adopted, restarting node')
    state.pairingCode = null // consumed; issue a fresh code on next click
    await stopSync()
    startSync()
    runRound().then(persistPeerWatermarks)
    return { ...getSettingsPayload(), peer: r.peer }
  }

  // Two-way confirmed pairing: respond to the pending inbound pair-request (from syncEvent
  // 'pair-request'). The transport's 60s timer already auto-rejects on silence.
  const syncPairRespond = p => {
    const state = getState()
    const accept = !!(p && p.accept)
    const info = state.pendingPair
    state.pendingPair = null
    if (!info || typeof info.respond !== 'function') return { ok: false, error: 'no pending pair request' }
    try { info.respond(accept) } catch (e) { log.warn('[LanSync] pair respond failed:', e.message); return { ok: false, error: e.message } }
    log.info('[LanSync] inbound pair request', accept ? 'accepted' : 'rejected', 'from', info.host)
    return { ok: true, accept }
  }

  // Two-way confirmed pairing: dial the peer and ask. Resolves once the peer's human accepts
  // (secret adopted like syncPairWithCode, node restarted, first round kicked off); rejects on
  // pair-reject / timeout, with the syncEvent 'pair-rejected' already emitted by the node.
  const syncPairRequest = async p => {
    const state = getState()
    const host = String((p && p.host) || '').trim()
    const port = Number.isInteger(p && p.port) ? p.port : DEFAULT_PORT
    if (!host || !/^[.:\w-]+$/.test(host)) throw new Error('syncPairRequest: host is required')
    if (!state.node) throw new Error('syncPairRequest: sync is not enabled')
    const r = await state.node.requestPair(host, port)
    settingPut(K_PAIRING_SECRET, String(r.secret))
    log.info('[LanSync] two-way pairing accepted by', host, '- shared secret adopted, restarting node')
    await stopSync()
    startSync()
    runRound().then(persistPeerWatermarks)
    return { ...getSettingsPayload(), host: r.host, port: r.port }
  }

  // Round-2 P1: machine-local per-peer display alias for Device Center (sync.peerAlias.<id>).
  const syncSetPeerAlias = p => {
    const deviceId = String((p && p.deviceId) || '').trim()
    if (!deviceId) throw new Error('syncSetPeerAlias: deviceId is required')
    const alias = String((p && p.alias) || '').trim().slice(0, 40)
    const key = K_PEER_ALIAS_PREFIX + deviceId
    if (alias) settingPut(key, alias)
    else busWrite('settingsRowDelete', { key }) // empty string clears the alias
    return { deviceId, alias: alias || null }
  }

  const syncGetPairingCode = () => {
    const state = getState()
    const secret = settingGet(K_PAIRING_SECRET)
    if (!secret) return { code: null, expiresAt: 0 }
    if (state.pairingCode && state.pairingCode.expiresAt > Date.now()) return state.pairingCode
    const { deviceId } = ensureIdentity()
    const expiresAt = Date.now() + PAIRING_CODE_TTL_MS
    state.pairingCode = { code: derivePairingCode(secret, deviceId + ':' + expiresAt), expiresAt }
    return state.pairingCode
  }

  const syncSetName = p => {
    const name = String((p && p.name) || '').trim().slice(0, 40)
    if (!name) throw new Error('syncSetName: name is required')
    settingPut(K_DEVICE_NAME, name)
    if (getState().node) { // advertising payload carries the name: restart to re-broadcast
      stopSync().then(() => { if (settingGet(K_ENABLED) === true) startSync() }).catch(() => {})
    }
    return getSettingsPayload()
  }

  return { syncUnpairPeerOp, syncPairWithCode, syncPairRespond, syncPairRequest, syncSetPeerAlias, syncGetPairingCode, syncSetName }
}
