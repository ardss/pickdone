# sync-core

Transport-agnostic sync engine (design doc `docs/sync/同步整体方案-2026-09-15.md` §4.1–§4.2). Pure ESM, deterministic, no I/O.

## Module map

- `merge.mjs` — conflict rules: row-level LWW with delete-wins tombstones (todos, plan_chips), append-only larger-focusDuration-wins (tomato ledger). Loser content becomes a conflict copy, never silently dropped.
- `segment.mjs` — oplog segment codec: `pack()`/`unpack()` with seq-range validation, 256KB hard cap, null-impl E2EE codec hooks (P3a wires AES-256-GCM there).
- `engine.mjs` — `createEngine({ localStore, deviceId, clock })`: `buildSegments()` + `markPushed(toSeq)` (push), `ingestSegment(body)` (pull), `buildSnapshot()` / `applySnapshot(body)` (fresh-device bootstrap). `canonicalStringify` gives byte-deterministic snapshots.
- `pairing.mjs` — 6-digit pairing codes: HMAC-SHA256(secret, deviceId) → 6 digits, constant-time verify. The one deliberate `node:crypto` import (platform boundary); swap for WebCrypto when extracted.

## Local store adapter contract (implemented by transports P3a LAN / P3b cloud)

- `getRowsSince(seq)` → own-origin oplog rows (oplog holds own ops only)
- `applyRow(row)` → merge rules, returns `true` when state changed
- `getCursor()` / `setCursor(seq)` → persisted push cursor
- `allRows()` → live state incl. tombstones; `replaceAll(rows)` → snapshot reset

## Crash semantics

The push cursor advances ONLY on `markPushed()` after confirmed delivery. A crash mid-push leaves the cursor untouched; the next `buildSegments()` re-packs from the same seq. Whole-segment re-push only — re-delivered rows are idempotent under the merge rules.

## Deliberately NOT here

No crypto (E2EE hooks live in `segment.mjs`, implemented in P3a), no networking, no persistence, no wall-clock time (clock is injected; default is a monotonic counter for tests).
