/**
 * LAN sync (P3a) renderer adapter — thin dbCall wrapper over the sync.* IPC ops.
 * settings_rows is the single authority (sync.enabled / sync.deviceName / sync.pairingSecret live
 * in the main process DB): this module deliberately performs ZERO localStorage writes so the
 * dual-write ledger stays untouched.
 */

const call = (op, params) => window.todoAPI.dbCall(op, params)

/** { enabled, deviceId, deviceName, hasPairingSecret } */
export function getSyncSettings () { return call('syncGetSettings') }

/** Toggle the LAN sync node (true starts discovery+server, false stops; never auto-called). */
export function setSyncEnabled (enabled) { return call('syncSetEnabled', { enabled: !!enabled }) }

/** { enabled, deviceId, deviceName, listening, port, peers[], lastRoundAt, lastError } */
export function getSyncStatus () { return call('syncGetStatus') }

/** Time-boxed 6-digit pairing code: { code, expiresAt } (code null when no secret yet). */
export function getPairingCode () { return call('syncGetPairingCode') }

/** Rename this device (re-advertises via mDNS when the node is running). */
export function setSyncDeviceName (name) { return call('syncSetName', { name }) }

/** Manual pairing: exchange the peer's 6-digit code for the shared pairing secret, then resync. */
export function pairWithCode (code, deviceId) { return call('syncPairWithCode', { code, deviceId }) }

/* (2026-09-23) addSyncPeer retired: zero renderer callers ever existed (Device Center pairs via
   pairWithCode/syncPairRequest); the whole syncAddPeer IPC chain was removed with it. */
