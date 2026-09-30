# Sync v2 Core Design — Steps 6/7/8: Snapshot & Checkpoint, Crypto/Keys, Transport Interface

Continues `docs/sync-v2-core-design.md` (steps 3-5). All three layers below are
design-complete and ready for implementation after the simulator (spec Step 9).

## Step 6 — Snapshot / Checkpoint

### 6.1 Snapshot object (spec §22, first-class)

```
snapshot = {
  snapshotId:        ULID,
  generation:        number,        // monotonically increasing per account/stream
  coversServerSeq:   number,        // server sequence this snapshot fully contains
  stateHash:         SHA-256(canonical serialized local state),
  ciphertextHash:    SHA-256(ciphertext),
  keyId:             string,        // which data-encryption-key generation encrypted it
  createdAt:         HLC,
  ciphertext:        bytes
}
```

- Canonical serialization: sorted-entity/sorted-id JSON of the materialized state
  (reuse the existing `allRows()` row model, but the hash input is the
  **serialized revision state**, not live rows — a snapshot is a point-in-time
  object, fixing P2-3).
- Client build: serialize → compress (zstd-deflate via node zlib) → encrypt
  (DEK, AEAD) → upload. Server stores opaque ciphertext only.
- Verification on receive: ciphertextHash first, then decrypt, then stateHash —
  mismatch ⇒ corrupt snapshot handling (spec §69): try previous generation,
  else full rebuild; never restore partial.

### 6.2 Checkpoints (spec §39, anti-rollback)

Signed checkpoint every N generations (N=10 initial) and on every credential/
lifecycle change:

```
checkpoint = sign(accountSigningKey,
  { snapshotId, generation, coversSeq, stateHash, prevCheckpointHash })
```

Clients keep the latest checkpoint hash locally; a relay offering a snapshot
whose chain doesn't verify against the local checkpoint head is flagged
`rollback-suspected` — sync halts, user is asked to confirm (freshness is an
explicit non-guarantee; this makes it a *detectable* one).

### 6.3 Retention mapping (spec §29)

- Sync retention: keep `latest snapshot + tail` — sized by GC floor (device
  lifecycle model from the evaluation brief §6, ACTIVE→STALE→DETACHED).
- History retention (paid tier): historical snapshots at daily/weekly cadence,
  NOT oplog preservation. `coverage` of a historical snapshot = its own
  coversServerSeq; restore = snapshot + tail replay to target seq.

### 6.4 Bootstrap (spec §23/§24, unchanged contracts from LAN engine)

latest valid snapshot → verify → decrypt → verify stateHash → restore → pull
tail after `coversServerSeq` → causal merge → normal sync. Existing
non-destructive merge-apply bootstrap behavior (lan-sync-bootstrap.js:183-192)
carries over unchanged; the only delta is snapshot provenance fields above.

## Step 7 — Crypto / Key model (spec §33-38)

### 7.1 Hierarchy

```
Password ──Argon2id──► Authentication Material   (server-verifiable, never decrypts)
Random 256-bit Account Root Key            (generated client-side, never leaves client plaintext)
  ├── Data Encryption Key (DEK)            encrypts revisions, snapshots, blob chunks
  ├── Account Signing Key (Ed25519)        signs checkpoints
  └── Key-Wrapping Material                wraps per-device keys
Per-device: Ed25519 signing + X25519 encryption keypair (private keys local-only)
Recovery Key: random 256-bit, wraps Account Root Key, shown as 24 words,
  verified at enrollment, downloadable, regenerable (old one voided)
```

- Password reset restores *login* only; data access requires a trusted device or
  the Recovery Key (spec §38 UX wording is binding).
- Enrollment (§36): login → create device keypair → enrollment request →
  approval by an existing trusted device OR recovery key → wrapped root key
  delivered → device decrypts. Password auth alone never grants decryption.
- Library policy: Node `crypto` (OpenSSL) for AES-256-GCM/HKDF; `@noble/curves`
  for Ed25519/X25519; Argon2id via `hash-wasm` (pure-WASM, no native build
  across win32/linux-arm64). No hand-rolled primitives (spec §33 ban list).

### 7.2 LAN reuse

Per-pair secrets remain for LAN transport (they are transport credentials, not
data keys). Revisions/snapshots are additionally DEK-encrypted so the relay and
any future cloud path use the same ciphertext objects — the LAN engine's
session-key HKDF (cipher.js) stays as the wire layer only.

## Step 8 — Transport interface (spec §8/§55/§56/§57)

### 8.1 Interface (`shared/sync-transport/interface/`)

```
TransportAdapter {
  dial(peerRef) -> Connection
  listen(opts) -> Listener            // no-op for pure cloud clients
  wakeups: EventEmitter               // 'data-available' hints; never correctness-bearing (§20)
}
Connection {
  send(frame) / on('frame')
  close(reason)
  state: 'connecting'|'open'|'closed'
}
```

Frame = encrypted revision envelope batch | ack | snapshot chunk | checkpoint —
identical codec for all transports (`sync-core/segment.mjs` extended with
revision envelopes). Adapters: `lan/` (existing TCP JSON-line + per-pair
secret), `https/` (push/pull REST per spec §16/§17 + WS wakeup), later
`selfhost/` (same https adapter, user-provided endpoint).

### 8.2 Extraction plan (fixes P2-1)

From `client-round.js`/`server-role.js`/`lan-sync-bootstrap.js`, lift into the
adapter: dial/address-refix, hello/auth, framing, rate limits. What stays in
Sync Core (transport-blind): round scheduling decisions, watermark/cursor
advance rules, merge invocation, snapshot triggers, quarantine. The module-level
`state` singleton becomes an injected context object (constructor param), which
is also what makes the spec Step 9 simulator possible.

### 8.3 Versioning (spec §57)

Every frame and REST payload carries `protocolVersion` + `clientVersion`; relay
serves `minProtocolVersion`; on mismatch the client halts sync (never
best-effort parses) and prompts update.

## Implementation order after this doc (spec steps 9-11 next)

1. `shared/sync-core/clock/hlc.mjs` + unit tests (rollback, receive-advance,
   tie-break, persistence crash rule).
2. `shared/sync-core/revision/` envelope codec + `sync_revisions` schema +
   write-path integration behind a flag (`sync.revisions.v2` settings key).
3. Causality classifier + merge rewrite, property-based convergence tests on the
   local simulator (spec §50) before any transport work.
4. LAN transport adapter extraction; cloud HTTPS adapter only after simulator
   convergence is green.
