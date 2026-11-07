# Lane A — real cross-machine LAN sync E2E (2026-11-07)

Baseline `2c1bde83` (includes QA R5 fixes `462f0692`). No push/merge/release. Production DBs, production installs, and system firewall/proxy untouched.

## Topology

- **Server = Windows A** `<A-HOST>`, LAN `<A-LAN-IP>`, node v22.22.0 — runs ONLY the isolated staging copy of the bridge (`%HOME%\pd-lanea-e2e\`, wiped after the drill) over a TEMP SQLite (`%TEMP%\pd-lanea-e2e.sqlite`, canonical `SCHEMA` DDL, deleted after the drill). Nothing touched the real PickDone DB.
- **Client = Windows B** (this host) `<B-LAN-IP>`, node v24.14 — runs `pickdone/scripts/cross-platform/e2e-client.mjs` against `http://<A-LAN-IP>:58721` over the real network.

Two-level explicit opt-in honored: the runner REFUSES to listen without `--enable-bridge` (level 1) and requires explicit `--enable-lan --port 58721` (level 2, pinned test port); `{"event":"refused"}` was actually observed when the flags were omitted. Default posture elsewhere remains loopback-only/ephemeral. Firewall untouched (audit showed all A firewall profiles disabled, so it was not the blocker).

## Layers verified on the way (failure was diagnosed, not assumed)

| Layer | Probe | Result |
| --- | --- | --- |
| routing/ARP | `ping <candidate-host>` (wrong host, flaky reply) | misleading → resolved real A IP |
| identity | `ssh <A-HOST> hostname` → `<A-HOST>`, `ipconfig` → `<A-LAN-IP>` | OK |
| TCP/HTTP | `fetch http://<A-LAN-IP>:58721/crossplatform/hello` from B | `200 {"service":"pickdone-crossplatform","proto":1,"pairingRequired":true}` |
| firewall | `Get-NetFirewallProfile` on A (read-only) | Domain/Private/Public all Enabled=False (not the blocker) |
| bind | `Get-NetTCPConnection -OwningProcess <pid>` on A | `0.0.0.0:58721 LISTEN` |

## Cross-machine phases (all executed over the real network, B → A)

| Phase | Evidence |
| --- | --- |
| hello | 200, correct service payload |
| one-shot pair | 200, WRITE token minted (challenge consumed once; unit-tested replay burn) |
| B creates task | push `e2e-b-1` "created on B" → verdict `applied`, landed in A's temp SQLite |
| B edits task | push title "edited on B" @2000 → `applied` |
| B deletes (tombstone) | push deleted@3000 → verdict `conflict_tombstone_wins` (newer tombstone over live local row; conflict surfaced, never silent) |
| A state verified | A-side dump after: `[{"id":"e2e-a-1","content":"written on A","deleted":0},{"id":"e2e-b-1","content":null,"deleted":1,"deletedAt":3000}]` |
| A writes, B pulls | locally-seeded `e2e-a-1` "written on A" visible on B's pull |
| disconnect retry | re-sent `e2e-create-1` with same messageId → `replay:true`, cached verdict, no double apply |
| second device (READ) | paired `win-b-second` READ: pull OK, push → `401 token_bad_scope` |
| revoke mid-session | machine-side revoke (marker-file door) → B's pull immediately `401 token_revoked` |
| restart recovery | server stopped (`listenerVerifiedClosed:true`, exit 0) → restarted on SAME temp DB → fresh pair OK, pull still returns both rows (tombstone intact), `win-b-second` STILL `401 token_revoked` (trust root + revocations persisted in meta) |

## Cleanup evidence

- stop-file lifecycle → `{"event":"stopped","port":58721,"listenerVerifiedClosed":true}`
- post-stop: `netstat :58721` empty; node processes matching `e2e-server|pd-lanea` on A: **0** (verified via CIM count)
- staging wiped: `rmdir /s /q pd-lanea-e2e` + `del %TEMP%\pd-lanea-e2e.sqlite*` → CLEANUP_DONE
- B-side: no listeners opened (client only)

## Honest gaps

- **Real Chromium PWA handshake: NOT performed** in this round (optional attempt deferred; nothing faked). The endpoint contract it would integrate against is documented in `lane-a-crossplatform-sync-20261107.md`.
- The desktop "pull/write" side here is the bridge's repo door over a temp DB — NOT the production Electron app with its full IPC/UI. Real-install E2E remains with QA (#227): this drill proves transport/auth/merge semantics over a real network between two physical hosts.
- Runner scripts committed for repro: `pickdone/scripts/cross-platform/e2e-server.mjs` / `e2e-client.mjs` (refuse-to-run without explicit opt-in flags).
