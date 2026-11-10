# #226 Regression Manual — Single-Machine Dual-Instance (Lane A, S2/J2, 2026-11-10)

How to re-run the #226 acceptance checklist on ONE Windows machine by simulating
machine A (desktop/bridge server) and machine B (paired client) as two isolated
in-process instances, per the MEGA-MISSION S2/J2 scope. This batch does NOT cover
real A/B physical machines (Wave4); the production-pairing dependencies it defers
are listed at the end.

## Scripts

| Script | What it proves |
| --- | --- |
| `scripts/cross-platform/regression-226-single-machine.mjs` | The full #227/#226 walk in one process: pair -> bidirectional push/pull -> LWW conflict (explained verdicts) -> tombstone delete wins -> bridge-disconnect loud failure + retry convergence -> duplicate-send idempotency -> mid-session revocation (401 token_revoked) -> restart recovery (data + revocation sticky). Exit 0 = all steps PASS. |
| `scripts/cross-platform/e2e-server.mjs` / `e2e-client.mjs` (f83043b2) | The two-real-machine LAN runner this single-machine shape was derived from (keep for Wave4). |
| `tests/unit/cross-platform/bridge-native-origin.test.mjs` | qa-r7 P1: native no-Origin loopback client passes with valid token+CSRF; forged CSRF/token/Origin still fail closed. |
| `tests/unit/cross-platform/bridge-error-recovery.test.mjs` | J5 negatives: transient-failure retry recovery (failed verdicts are NOT cached), disconnect loud-fail + post-restart success, expired token 401 token_expired, duplicate send replay. |

## Execution (isolated, no production touch)

```bash
cd <worktree>/pickdone
node scripts/cross-platform/regression-226-single-machine.mjs        # expect: 7/7 steps passed, exit 0
node --test tests/unit/cross-platform/                                # focused suite (bridge/gate/cors/recovery/native)
```

Safety envelope (same doctrine as e2e-server.mjs): two TEMP SQLite databases in an
OS temp dir (canonical SCHEMA DDL), loopback-only binds on ephemeral ports, temp
state wiped on exit. No production DB, no production pairing state, no firewall
changes, no non-loopback bind.

## What each runner step maps to (docs/sync-matrix.md + J2/J5)

- S1 pair: one-shot pairing challenge over the real wire (pairing-ttl contract).
- S2 bidirectional: B pushes to A and A pushes to B; both DBs asserted.
- S3 conflict+tombstone: `stale_skip` for an older edit, `conflict_tombstone_wins`
  for a newer delete (verdict surfaced on the wire, row state asserted).
- S4 disconnect+retry: bridge killed mid-session -> client fails LOUDLY
  (ECONNRESET, never a fake success) -> after restart the same messageId recovers.
- S5 duplicate send: same messageId -> cached verdict with `replay: true`, exactly
  one row.
- S6 revocation: `revokeDevice` mid-session -> 401 token_revoked.
- S7 restart recovery: fresh bridge over the same persisted stores -> old revoked
  token still 401, fresh pair works, data intact on both instances.

## Production-pairing dependencies (explicitly deferred to Wave4)

1. Real two-machine run needs the e2e-server/e2e-client runners with BOTH opt-in
   flags (`--enable-bridge` + `--enable-lan --port 58721`) on a real LAN, and the
   test port pinned to 58721; staging DB only (`--db`), wiped after the drill.
2. Production pairing (#226's real device registry) must only be exercised after
   this isolated suite is green AND with explicit user authorization — production
   meta keys (`crossplatform.*` in the meta table) rotate on re-pairing (sync-matrix
   section 1: `sync.*` / pairing identity are machine-local and never sync).
3. Android native device leg (real phone): needs the Capacitor native transport
   (client fix 985bba32) plus the qa-r7 P1 bridge fix (this branch) installed on the
   desktop; cleartext is allowed only for the emulator's host-loopback gateway address
   in DEBUG builds (see the debug network-security-config; release manifest keeps
   cleartext denial) — a real-phone LAN run needs HTTPS or an explicit, reviewed
   network-security-config decision.
4. Restart-recovery against the installed Electron app (real main-process wiring)
   is covered by bridge-bootstrap/bridge-settings unit suites here; the installed-app
   live check stays in Wave4.
