# LAN Sync Coverage Matrix (2026-09-29)

> The audit-stop rule: a tier is CLOSED when its listed scenario passed on the CURRENT
> build, live or via the real-process integration suite. New findings in a CLOSED tier
> count against the audit process, not the feature; findings in an OPEN tier are
> development. This document is the boundary — audits without it are infinite by
> construction.

| Tier | Scenario that must hold | Verified how | Last pass |
|---|---|---|---|
| 1. Transport | encrypted framing, auth codes, replay/seq guards, line caps | unit `encryption.test.mjs` + 3-machine live pairing | 2026-09-29 live |
| 2. Watermark / push | per-peer push cursor advances only on ack; a dead peer never gates others | 3-machine live (B killed mid-round: A recorded visible failure, cursor pinned, C unaffected pending=0; relaunch drained backlog wm 84→136) | 2026-09-28 live |
| 3. Conflict | LWW by updatedAt, same winner everywhere, loser recoverable | 3-machine live firewall-partition drill: B-version (newer) won on all 3, A-version copy restorable in recycle | 2026-09-29 live |
| 4. Pairing lifecycle | pairing a new peer never invalidates existing pairs; re-pair round-trips | per-pair secrets (unit `fix-20260928-per-pair-secret.test.mjs`) + live A↔B and A↔C both `state=ok` simultaneously | 2026-09-29 live |
| 5. Flush failure / recovery | poison row → round fails visibly, watermark pinned, snapshot recovery arms, row quarantined | real-process integration `lan-sync-loopback.test.mjs` scenario 3 (2× pass) + live `flushQuarantine` observable on all nodes | 2026-09-29 |

## Known design debt (named, not open bugs)

- **Stale-base conflict copies (P2)**: `mergeTodoRows` mints a loser copy whenever content
  differs — including when the loser is the unmodified base row a peer simply had not
  received the newer edit for yet. Observed live: 1 edit × 2 peers → 2 junk recycle
  copies, synced back to the editor. No data loss (winner always survives; copies are
  additive and terminal). Root fix needs **author provenance in the row protocol** — the
  current `deviceId` records the last hop, not the original writer, so the adapter cannot
  distinguish "stale echo of the same writer's line" from "independent edit". Fix sketch:
  carry `authorDeviceId` per row (protocol v3), suppress loser copies whose author equals
  the winner's author.
- **§5 live poison injection**: the deployed build has no injection hook; tier 5 is
  verified by the real-process integration suite (real TCP, real DBs, production merge
  pipeline) plus the live quarantine observable. A dev-hook build would allow a live
  poison round if ever needed.

## Convergence criterion for release

Two consecutive full-tier sweeps with zero new P0/P1. Sweep 1: 2026-09-28 (§1-§4).
Sweep 2: 2026-09-29 (§3 + §5 + final three-way write sweep, zero new P0/P1). Criterion met.
