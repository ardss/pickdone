# Sync v2 Step 2 — Old Architecture Problem List

Input: audit of the current sync implementation (2026-09-29) against the Sync v2
spec (local-first + HLC + immutable revision DAG + opaque cloud relay). Every item
cites file:line evidence. Verdicts: **P1 = protocol-correctness defect**, **P2 =
structural debt**, **P3 = acceptable short-term, migrate later**.

## P1 — Protocol correctness defects

### P1-1. Wall-clock `updatedAt` is the sync version number
`shared/sync-core/merge.mjs:36-56`: LWW order is `updatedAt` → `seq` → `deviceId`;
tombstones are plain LWW with `deletedAt` in the same wall-clock space
(merge.mjs:31-38). Consequences: clock rollback on any device can resurrect old
state; `seq` tiebreak is a *local* oplog pointer that only exists at egress and is
meaningless across devices; no causal information exists, so "newer" is defined
purely by wall time. Spec §5/§6 violated.

### P1-2. Oplog is a dirty queue, not immutable history — egress ships future state under old pointers
`sync_oplog (seq, entity, entityId, ts)` is pointer-only (db.js:234-239);
`hydrateRow()` reads the **current** live row at egress (sync-apply-hydrate.js:107-177).
If an entity is edited between enqueue and egress, the revision a peer receives is
the *later* content with only one wall-clock stamp — there is no way to know which
intermediate states existed or what they causally depended on. Also: oplog appends
run in a **separate transaction** from the business write (db-oplog.js:17-18) — a
crash between the two commits silently loses the delta. Spec §13 violated.

### P1-3. Ring buffer silently drops un-pushed history
`SYNC_OPLOG_KEEP = 10000` trimmed every 200 appends (db-oplog.js:30, 179-183).
Any peer offline long enough for 10k writes to accrue loses those changes
permanently with no tombstone, no warning, no recovery path. Correctness depends
on an undocumented "peers catch up within 10k writes" assumption.

### P1-4. Conflict detection is a heuristic (`syncAuthor`), not causal
`sameLineage` = both authors known and equal (merge.mjs:141); unknown/empty author
on either side forces conservative conflict copy (merge.mjs:137-141). `syncAuthor`
exists **only on todos** (db.js:161) — settings_rows, categories, plan_chips,
filters, tomato_records have no provenance, so cross-device edit echo on those
entities is indistinguishable from true concurrency by construction. Spec §12:
provenance must come from revision DAG parents, not a per-row stamp.

### P1-5. No duplicate/ancestor/descendant/concurrent classification exists
Merge compares exactly two rows (current vs incoming); there is no revision id, no
seen-set, no ancestry check (merge.mjs:127-144). A stale echo that *loses* on wall
clock is silently dropped; one that *wins* mints a conflict copy — the same
causality situation produces different outcomes depending on clock order. Spec
§10's four cases are unimplementable on the current data model.

## P2 — Structural debt

### P2-1. Merge semantics and transport are separable on paper, but the hydrate/apply layer is welded to the app
`sync-core` (merge/segment/engine, ~500 lines) is pure and transport-agnostic, but
the apply pipeline (sync-apply.js 783 + sync-apply-hydrate.js 191 +
lan-sync-bootstrap.js 804) is coupled to `db.call()` ops, the command-manifest
bus, and a module-level `state` singleton with `__test.setState`
(lan-sync-bootstrap.js:772-804). No second transport can consume this without
Electron. Spec §64/§56 violated.

### P2-2. No durable server sequence / account-scoped stream
Per-peer push watermarks live in `sync.peerWatermarks.v2` (lan-sync-bootstrap.js:60),
pull watermarks are **memory-only, not persisted** (client-round.js:387-413) — a
process restart re-pulls from snapshot or relies on the peer's oldestSeq. The
spec's server-owned monotone `serverSeq` + durable per-device cursor (§14/§15)
does not exist; every device is simultaneously a server, so there is no single
receiving order.

### P2-3. Snapshot is a full-table current-state dump
`allRows()` re-reads live state (lan-sync-bootstrap.js:149-182); snapshot cursor =
sender's max oplog seq at build time (server-role.js:147). Fine for LAN bootstrap;
cannot serve as a versioned, hash-verified, signed protocol object (spec §22/§39:
`stateHash`, `ciphertextHash`, `generation`, signed checkpoints all absent).

### P2-4. Crypto has no key hierarchy
Session key = HKDF(per-pair secret, salt) per connection (cipher.js:50-79); no
account root key, no device signing keys, no key wrapping, no rotation, no
recovery-key concept. Pairing handshake MITM is documented as an accepted
limitation (cipher.js:39-41). Spec §33-38 require: password → auth material only,
random account root key, per-device Ed25519/X25519 keys, enrollment approval,
recovery key. Nothing exists server-account-shaped at all (audit point 10: no
relay/hub code outside the embedded server).

### P2-5. Anti-rollback / freshness is entirely absent
Nothing detects a malicious or buggy peer replaying an old snapshot or truncated
history (spec §4/§39-40: Confidentiality/Integrity handled; Availability/Freshness
unaddressed even as explicit non-goals — currently they are *unlisted* non-goals).

## P3 — Acceptable, migrate with the protocol

- **Quarantine paths are good** (spec §68 already satisfied): flush poison rows
  parked in `sync.flushQuarantine.<op>` (sync-apply.js:646-684), decrypt-fail
  severs socket (transport.js:176-202), ghost/`*gc*` rows skipped, stamp clamps
  normalize payload (sync-apply.js:126-167). Keep as-is; add revision-level
  quarantine on top.
- **Cursor-commit discipline is correct** (spec §18 satisfied): pull watermark
  advances only after ingest+flush commit (sync-apply.js:634-643,
  lan-sync-bootstrap.js:576-598); push watermark only on ack; flush-failed acks
  cap both (client-round.js:545-553).
- **Scheduler is reusable** (spec §65 satisfied): triggers, backoff, hibernate,
  round budgets all match the spec's shape; only needs a transport-agnostic home.
- **Bootstrap is non-destructive merge-apply** (spec §24 satisfied):
  replaceAll is merge, not overwrite (lan-sync-bootstrap.js:183-192); mutual-busy
  gating and force-arm logic carry over.
- **`syncAuthor` column (protocol v3, just shipped)**: becomes the conservative
  fallback for legacy rows lacking revision parents; do NOT delete the column —
  migrate its meaning (authorDeviceId) into the revision DAG and keep the column
  as deprecated provenance for rows that predate v2.

## Migration surface summary (from audit point 9)

Files touched by the current provenance heuristic (all become revision-DAG
consumers): db.js, db-migrations.js (v7), db-rows.js, sync-apply.js,
sync-apply-hydrate.js, merge.mjs, lan-sync-bootstrap.js, 2 test files.
Estimated new-code surface for Steps 3-8: `shared/sync-core/{revision,clock,
causality}` (~3 new modules), one `sync_revisions` table + payload store, and a
transport-interface extraction from client-round.js/server-role.js.
