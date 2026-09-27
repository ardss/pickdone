# SOP: LAN Sync Live Drill (3 machines)

> Canonical copy: `pickdone/docs/lan-sync-live-drill.md` (in git). This `sop/` copy is
> for internal ops use only (`sop/` is git-ignored). Keep the two in sync.
>
> Automated companion: `pickdone/tests/integration/lan-sync-loopback.test.mjs`
> (`node --test tests/integration/lan-sync-loopback.test.mjs`) covers the same
> scenarios over TCP loopback with two spawned node processes. The live drill below
> remains mandatory because it exercises real mDNS discovery, real machine
> suspend/resume, and real users' data volumes — none of which the loopback suite can.

## 0. Preparation (all 3 machines)

1. Install the same build on machines A, B, C. Verify version parity in
   Settings → About (a protocol-version mismatch shows up as auth rejections later).
2. Ensure all machines are on the same LAN, multicast/mDNS (UDP 5353) allowed.
3. Put each machine's Device Center (设置 → 设备中心 / Device Center) on screen; you
   will read observable states from it during the drill.
4. Have a clock with second precision ready — round timings and backoff windows matter.

## 1. Pair (via code)

1. On A: Device Center → 局域网同步 → show pairing code.
2. On B: enter A's code, confirm on both sides. Expected: both devices show each other
   as **online**, `peerState: ok`, no `lastError`.
3. Repeat A↔C. (B↔C optional; a 3-node mesh exercises multi-peer watermark isolation.)
4. Watch the first full sync complete: on A and B the round finishes with
   `round-done`; Device Center "最近同步" shows the confirmed round.
   - If a peer shows `peerState: unpaired`, the code was rejected/revoked — re-pair.

## 2. Write both ways

1. On A create 3 todos; wait ≤ one round interval; verify all 3 appear on B and C.
2. On B create 1 todo and edit one of A's todos; verify the change lands back on A and C.
3. Check the per-peer **watermark** advanced (调试日志 / `lanSync` IPC status):
   each machine's push watermark for each peer must equal the seq of its latest row —
   if it stays `null` or lags while rounds "succeed", that is the STALLED-PUSH
   signature (see §6). A lagging-but-advancing watermark with pendingCount stuck > 0
   is NOT healthy either; capture logs.
4. Offline one machine (B) entirely (kill app, not just network toggle), write on A,
   relaunch B: the backlog must drain within the first round after B returns, and B's
   offline writes must land on A. This pins the per-peer watermark isolation (a dead
   peer must not gate others' rounds).

## 3. Force a conflict (loser's copy must survive)

1. Disconnect B (airplane mode / kill app). Note the exact second.
2. On A edit todo T ("A version"). On B (still offline or before it re-syncs) edit the
   same todo T ("B version") with a different title.
3. Reconnect B and let 2–3 rounds complete.
4. Expected: LWW by `updatedAt` — one version wins on ALL machines; the loser is
   preserved as a **recoverable conflict copy** (sync-conflict-backups; visible via the
   conflict list, never silently discarded). Verify the copy exists and its content
   matches the losing side.
5. Record which side won (newer `updatedAt`) — if the OLDER side won, stop and capture
   logs: recency comparison is broken.

## 4. Kill / reconnect mid-flight

1. With a backlog in flight (create ~50 todos on A while B is connecting), kill B's
   app **mid-round** (or kill the network interface — harder drop).
2. Expected on A: the round ends as a FAILURE (Device Center shows the peer in
   `error` with `lastError` like "connection closed before the round completed"),
   never as a silent success; the push cursor does NOT advance over undelivered rows.
3. Relaunch B. Expected: reconnect within the backoff window, backlog re-pushes
   (idempotent), all 50 rows converge on both ends, watermark advances past every
   pre-drop row, and the peer returns to `peerState: ok`.

## 5. Fault axes: flush-stall + quarantine (new observables, 2026-09 wave)

Simulate a poison row the receiver cannot flush (dev build: inject a row whose value
defeats the bulk write, e.g. a BigInt-valued settings row, then write normally on A).

1. The round in which the receiver drops the push must FAIL VISIBLY on A:
   `lastError` contains "flush failed"; the round is NOT counted as ok.
2. **Watermark guard**: A's push watermark for B must NOT advance past the poison row
   (seq check in debug status). Repeated flush-failed rounds (budget: 3 by default)
   flip the Device Center peer card to **`flush-stalled`** — user attention required,
   but the peer must stay dialable (no 10-minute hibernate from a flush stall).
3. **Recovery snapshot arms**: the flush failure force-arms the snapshot trigger on
   BOTH ends; within 1–2 rounds a full-state snapshot flows (Device Center recent ring
   shows a `snapshot` entry; debug log shows `snapshot-sync`). The peer's full state
   re-applies idempotently, restoring whatever the failed flush dropped.
4. **Quarantine surfacing**: the receiver's dropped rows are parked in the
   machine-local meta blob `sync.flushQuarantine.<op>` (per-op cap 50, newest kept).
   Device Center surfaces the flush-quarantine entries read-only — verify the poison
   row is listed there and that quarantine never syncs back to peers (`sync.*` meta is
   machine-local). Since the 2026-09-26 Layer-1 fix, a SUCCESSFUL quarantine lets the
   ack advance (watermark moves past the parked row); only failed quarantine parking
   keeps the fail-closed flushFailed behavior.
5. Recovery path: fix/remove the poison row on the sender (or clear quarantine on the
   receiver) → next clean round resets `flush-stalled` → `ok`.

## 6. Pass / fail summary

| Check | Expected |
|---|---|
| Pair via code | both sides `peerState: ok`, online |
| First round | both oplogs converge, no round-error |
| Bidirectional writes | both watermarks advance to latest seq |
| Conflict | LWW winner everywhere + recoverable loser copy |
| Mid-round kill | failed round, cursor pinned, reconnect converges |
| Poison row | round fails, watermark pinned, `flush-stalled` after budget, snapshot recovery fires, row in flush-quarantine |

Any mismatch: capture Device Center screenshot + `%APPDATA%/pickdone` logs
(TODO_USER_DATA_DIR) from all machines before touching anything, and file against the
sync wave board with the exact wall-clock times.

## 7. Never do

- Never run the drill against real user data without TODO_DB_DIR/TODO_USER_DATA_DIR
  isolation (automated runs MUST use fresh temp dirs).
- Never kill the app by image name on shared machines — use the app's own quit, or a
  dedicated test profile.
- Never "fix" a stalled peer by deleting watermarks without first capturing logs —
  that erases the evidence and the quarantine copy.
