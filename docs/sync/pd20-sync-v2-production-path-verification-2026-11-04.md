# pd20 Sync v2 生产路径核查 (2026-11-04, integrate/pd20)

Question: does the SHIPPING sync path still degrade to v1 LWW, or is Sync v2 live?
Audited at integrate/pd20 HEAD c29270fe against docs/sync-v2-old-architecture-problems.md.

## Verdict

**Production sync is still v1 (wall-clock LWW over a dirty pointer oplog).** The v2
substrate (HLC `shared/sync-core/clock/hlc.mjs`, revision DAG tables
`src/main/db-migrations.js:80-103`, DVV/causality merge `shared/sync-core/causality/`,
relay transport) exists and is real, but the whole stack is **opt-in and default OFF**
(`src/main/db-revisions.cjs:3`, `db-revisions-ops.js:11-13`, `relay-sync-adapter.js:7-9`).
The default LAN transport never touches the DAG; even the relay path materializes business
state through the v1 LWW pipeline (`relay-sync-apply.js:17-24`).

## Problem ledger reconciliation (docs/sync-v2-old-architecture-problems.md)

| # | Verdict | Evidence (pickdone/) |
|---|---------|----------------------|
| P1-1 wall-clock LWW | STILL-PRESENT (LAN); PARTIAL (relay todos only) | `shared/sync-core/merge.mjs:36-56,127-144`; applied at `src/main/sync-apply.js:345-350`; relay pull stamps `causalCurrent` and overrides LWW for tracked todos only (`sync-apply.js:334-344`) |
| P1-2 dirty pointer oplog / hydrate-at-egress / split commit | STILL-PRESENT | `db-oplog.js:46-50` (append warn-only), `db.js:752-764`; `sync-apply-hydrate.js:114-185` reads live rows at egress; v2 recorder (`db-revisions.cjs:187-193`) is flag-gated |
| P1-3 ring-buffer trim (10k) | STILL-PRESENT | `db-oplog.js:30,224`; gap policy leans on snapshots that are live-state dumps (P2-3) |
| P1-4 syncAuthor heuristic | STILL-PRESENT | `merge.mjs:134-142`; `syncAuthor` on todos only (`db-schema.js:43`) |
| P1-5 no conflict classification | PARTIAL | classification lives in the v2 layer (`causality/merge.mjs`, `dvv.mjs`) but business apply still two-row compares (`merge.mjs:127-144`); delete-vs-edit adjudication is double-opt-in default-OFF (`sync-adjudicate.js:11,37`) |
| P2-1 apply welded to app | PARTIAL | relay adapter is DI-pure (`relay-sync-adapter.js:34-36`); LAN apply still coupled to `db.call` module state; relay funnels business writes through v1 pipeline by design (`relay-sync-apply.js:17-24`) |
| P2-2 durable server sequence | PARTIAL | durable ACK cursor + per-device bearer auth (`relay-sync-adapter.js:20-23,53`) but relay store is a full re-export per round (`relay-sync-bootstrap.js:73-80`); no server-owned monotone serverSeq; LAN watermarks snapshot-based (`lan-sync/snapshot.js:14-19`) |
| P2-3 full-table live snapshot | STILL-PRESENT (LAN) | `lan-sync/snapshot.js:14-19`; no stateHash/signed checkpoints anywhere in src/ |
| P2-4 crypto key hierarchy | PARTIAL | relay account root key → HKDF AEAD data key, mandatory E2E (`relay-sync-adapter.js:10-19`); but loopback-only unless `TODO_RELAY_ALLOW_REMOTE=1`, no TLS/enrollment/signing/recovery key (`:27-32`) |
| P2-5 anti-rollback/freshness | STILL-PRESENT | zero `stateHash`/freshness enforcement in src/; relay dedupes replays by revisionId but no old-snapshot detection |

## (a)–(d)

- **(a) entities**: only `todo` rows get v2 influence, only on the relay pull path
  (`sync-apply.js:334-344`); LAN never engages. All other entities merge by plain LWW
  (`sync-apply.js:345-350`). Non-todo relay envelopes stay DAG-only
  (`relay-sync-apply.js:22-24,61`).
- **(b) relay transport**: real HTTPS relay client + envelope push/pull with mandatory E2E —
  but ships dormant: default OFF, loopback-gated, and remote relays need env unlock plus
  infrastructure (TLS, enrollment, key-pairing) that "do NOT exist yet"
  (`relay-sync-adapter.js:27-32`). The live default transport is LAN v1.
- **(c) attachments**: file transfer is LAN-only (`src/main/lan-sync/att-transfer.js`:
  sha256 1MB chunks, caps, whitelist); relay carries todo JSON only (`relay-sync-apply.js:60-82`);
  `local://` blobs do not follow a relay sync. No v2 attachment story.
- **(d) conflict backup / restore**: LWW-loser restore is v1-aware and repaired
  (`src/main/sync-conflict-backups.js:10-60` — native-table restore, read-back probes,
  re-backup of the current winner incl. tombstones; the old `[object Object]`/
  silent-erase paths are fixed). Not revision-aware: no DAG/DVV consultation. Full-DB
  backups (`src/main/handlers/backup.js`) remain current-state snapshots (durable-write
  hardened at `:27-40`), no v2 lineage.

## Delivery consequence

The mandate item "核查 Sync v2 在生产路径是否仍退化 v1 LWW" is answered: **yes, it still
is v1 everywhere a user can actually run today**; v2 exists behind `relaySetEnabled` and
is not production-ready for non-todo convergence, attachments, or anti-rollback. Turning
v2 on is a separate, explicitly-scoped enablement project (flag flip + backfill + relay
infra), not something to silently flip inside a delivery PR.
