'use strict'
/**
 * Cross-platform bridge IPC channels (Lane A settings wiring, 2026-11-07).
 *
 * All channels are main-window-gated (same sender-identity discipline as the settings
 * domain — a compromised auxiliary window cannot enable LAN exposure, mint pairing
 * codes or revoke devices). Responses carry NO secrets: the pairing code is shown only
 * at issue time, tokens never leave the pairing response, status snapshots are sanitized.
 *
 * Channels (renderer contract, see docs/lane-a-crossplatform-sync-20261107.md):
 *   crossplatform:status       -> {running, enabled, lanEnabled, port, bindAddress, devices[], lastError}
 *   crossplatform:set-enabled  {enabled}   -> status   (stops the listener when disabling)
 *   crossplatform:set-lan      {enabled}   -> status   (requires bridge enabled; default OFF)
 *   crossplatform:pair-issue   {deviceId, scope?} -> {challengeId, code, expiresAt, scope}
 *   crossplatform:revoke       {deviceId}  -> status
 *   crossplatform:port         -> current port or null (for the client lanes to display)
 */

const { makeSenderIsMain } = require('../handlers/shared')

function bridgeIpcHandlers (ctx) {
  const { getDbCall, getMainWindow, log } = ctx
  if (typeof getDbCall !== 'function') throw new TypeError('bridgeIpcHandlers: getDbCall() required')
  const bootstrap = require('./bridge-bootstrap')
  const senderIsMain = makeSenderIsMain(getMainWindow)

  // QA R5 fix (2026-11-07): makeSenderIsMain returns a BOOLEAN — every channel MUST
  // branch on it and throw BEFORE touching pairing/key/enable/revoke services.
  // Fail-closed: missing event, missing sender, non-main sender, and any guard error
  // all reject. (The bare-call form silently let aux windows through.)
  const assertMainSender = e => {
    if (!e || !e.sender) throw new Error('forbidden: main window only')
    let ok = false
    try { ok = senderIsMain(e) === true } catch { ok = false } // guard errors reject too
    if (!ok) throw new Error('forbidden: main window only')
  }

  const statusNow = () => bootstrap.getStatus(getDbCall())

  return {
    'crossplatform:status': e => {
      assertMainSender(e)
      return statusNow()
    },

    'crossplatform:set-enabled': async (e, { enabled } = {}) => {
      assertMainSender(e)
      const dbCall = getDbCall()
      const on = !!enabled
      bootstrap.setBridgeEnabled(dbCall, on)
      if (!on) {
        await bootstrap.stopCrossPlatformBridge()
        log && log.info('[crossplatform] bridge disabled from settings')
        return statusNow()
      }
      // enable: boot the listener (bind decided by the LAN flag; loopback by default)
      const r = await bootstrap.startCrossPlatformBridge(() => dbCall)
      if (!r.started) throw new Error(r.reason || 'bridge failed to start')
      return statusNow()
    },

    'crossplatform:set-lan': async (e, { enabled } = {}) => {
      assertMainSender(e)
      const dbCall = getDbCall()
      bootstrap.setLanEnabled(dbCall, !!enabled) // throws if the bridge itself is not enabled
      // bind address changes require a rebind: stop, then start with the new flag
      await bootstrap.stopCrossPlatformBridge()
      const r = await bootstrap.startCrossPlatformBridge(() => dbCall)
      if (!r.started) throw new Error(r.reason || 'bridge failed to start')
      return statusNow()
    },

    'crossplatform:pair-issue': (e, { deviceId, scope } = {}) => {
      assertMainSender(e)
      if (!deviceId || typeof deviceId !== 'string' || deviceId.length > 64) {
        throw new Error('deviceId (string, <=64 chars) required')
      }
      const ch = bootstrap.issuePairing(deviceId, scope ? { scope } : undefined)
      return { challengeId: ch.challengeId, code: ch.code, expiresAt: ch.expiresAt, scope: ch.scope }
    },

    'crossplatform:revoke': (e, { deviceId } = {}) => {
      assertMainSender(e)
      if (!deviceId || typeof deviceId !== 'string') throw new Error('deviceId required')
      bootstrap.revokeDevice(deviceId)
      return statusNow()
    },

    'crossplatform:port': e => {
      assertMainSender(e)
      const st = statusNow()
      return st.running ? st.port : null
    }
  }
}

module.exports = { bridgeIpcHandlers }
