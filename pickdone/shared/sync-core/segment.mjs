/**
 * PickDone sync-core: oplog segment codec (design doc §4.1).
 *
 * A segment is the unit of sync transport: rows generated since `fromSeq` are
 * packed with their seq range + deviceId + schemaVersion into one plain
 * object, hard-capped at 256KB serialized. The server (P3b) only ever sees
 * ciphertext + this plaintext header for routing; merging is done on-device
 * via ./merge.mjs.
 *
 * TRANSPORT-ADAPTER BOUNDARY: P3a LAN adapter and P3b cloud adapter both call
 * pack()/unpack() and nothing else. See merge.mjs header for the full contract.
 *
 * E2EE hook boundary (§4.4 lands with transport in P3a, NOT here):
 *   codecHooks.encrypt / codecHooks.decrypt are explicit null-impl
 *   placeholders. pack() calls encrypt() on the serialized body if installed;
 *   unpack() calls decrypt() first. Until a transport installs them these are
 *   identity-null and segments travel as plaintext structures. Keep the hook
 *   signatures (bytes <-> bytes) so P3a wires AES-256-GCM without touching
 *   this file's callers.
 *
 * Pure ESM, zero Node/Electron imports.
 */

import { SYNC_SCHEMA_VERSION } from './merge.mjs'

export const MAX_SEGMENT_BYTES = 256 * 1024

export class SegmentTooLarge extends Error {
  constructor(bytes) {
    super(`segment serialized size ${bytes} exceeds ${MAX_SEGMENT_BYTES} byte cap`)
    this.name = 'SegmentTooLarge'
  }
}
export class SegmentSchemaError extends Error {
  constructor(expected, actual) {
    super(`segment schemaVersion mismatch: expected ${expected}, got ${actual}`)
    this.name = 'SegmentSchemaError'
  }
}

export class SegmentRangeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SegmentRangeError'
  }
}

/** Null-impl E2EE hooks — P3a transport replaces these (see header comment). */
export const codecHooks = {
  encrypt: null, // (bytes: Uint8Array) => Uint8Array | null-impl passthrough
  decrypt: null, // (bytes: Uint8Array) => Uint8Array | null-impl passthrough
}

/**
 * Pack rows into a segment envelope.
 * @param {Array<object>} rows - row objects, each carrying `seq`.
 * @param {{fromSeq:number, toSeq:number, deviceId:string, schemaVersion?:number}} meta
 */
export function pack(rows, { fromSeq, toSeq, deviceId, schemaVersion = SYNC_SCHEMA_VERSION }) {
  if (!Number.isInteger(fromSeq) || !Number.isInteger(toSeq) || fromSeq > toSeq) {
    throw new SegmentRangeError(`invalid seq range [${fromSeq}..${toSeq}]`)
  }
  const envelope = {
    v: schemaVersion,
    deviceId,
    fromSeq,
    toSeq,
    // rows are serialized as-is; content-blind peers never open this array
    rows,
  }
  let body = JSON.stringify(envelope)
  if (codecHooks.encrypt) body = codecHooks.encrypt(body)
  const bytes = typeof body === 'string' ? body.length : body.byteLength
  if (bytes > MAX_SEGMENT_BYTES) throw new SegmentTooLarge(bytes)
  return body
}

/**
 * Unpack and validate a segment. Rejects wrong schemaVersion and non-monotonic
 * seq ranges (every row seq must be within [fromSeq..toSeq] and strictly
 * increasing — the server-side monotonicity contract, mirrored client-side).
 */
export function unpack(body, { schemaVersion = SYNC_SCHEMA_VERSION } = {}) {
  const raw = codecHooks.decrypt ? codecHooks.decrypt(body) : body
  let envelope
  try {
    envelope = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(new TextDecoder().decode(raw))
  } catch {
    throw new SegmentRangeError('segment body is not decodable JSON')
  }
  if (envelope.v !== schemaVersion) throw new SegmentSchemaError(schemaVersion, envelope.v)
  const { fromSeq, toSeq, deviceId, rows } = envelope
  if (!Number.isInteger(fromSeq) || !Number.isInteger(toSeq) || fromSeq > toSeq) {
    throw new SegmentRangeError(`invalid seq range [${fromSeq}..${toSeq}]`)
  }
  if (!Array.isArray(rows)) throw new SegmentRangeError('segment rows must be an array')
  if (!deviceId) throw new SegmentRangeError('segment missing deviceId')
  let prev = fromSeq - 1
  for (const row of rows) {
    const s = row?.seq
    if (!Number.isInteger(s) || s < fromSeq || s > toSeq) {
      throw new SegmentRangeError(`row seq ${s} outside declared range [${fromSeq}..${toSeq}]`)
    }
    if (s <= prev) throw new SegmentRangeError(`row seq ${s} not strictly increasing (prev ${prev})`)
    prev = s
  }
  return envelope
}
