# Journey Audit — the 4th mining path

> 2026-10-10, born from a user's (justified) complaint: "when will you solve problems
> systematically instead of fixing whatever bug you happen to trip over?"
>
> The three existing daily-loop mining paths (UX / data-consistency / defects) all read CODE.
> They can find suspicious code; they cannot find a feature that is ASSEMBLED WRONG — every
> layer plausible, the hand-off between layers broken. The 2026-10-09 session lost a whole
> `discovered[]` field exactly that way: node had it, the payload reassembly dropped it, the
> renderer never saw it, three plausible layers and zero end-to-end proof. This document makes
> journey-walking a first-class maintenance path.

## Doctrine

A feature is not "done" because its code is plausible; it is done when a user can walk its
journey end to end. For each major feature below, the audit walks the journey — in the real
app, not in mocks — and asserts every step's OBSERVABLE outcome. Code-level suspicion still
belongs to mining paths 1-3; this path verifies existence and assembly.

Two mechanical aids exist and MUST be run when touching their area:

- `node cli/journey-sync.cjs` — the LAN-sync journey across two real packaged instances
  (boot → enable → mutual discovery → pair → bidirectional convergence → quiesce → unpair).
  Requires `npm run pack` first. Exit 0 = journey passes.
- `tests/unit/lan-sync/status-payload-contract.test.mjs` — the status-payload hand-off
  contract: every `status.<field>` the renderer/CLI reads must be provided by the payload
  reassembly. A new read without a provider fails CI.

## Journey checklists (walk each, tick with evidence)

### 1. LAN sync (automated: journey-sync.cjs + payload contract)
- [ ] enable (settings switch AND cli sync enable) → listening, port shown
- [ ] discovery: another enabled device appears under 附近的设备 without manual IP
- [ ] one-click pair from a discovered card; code-based pair as fallback
- [ ] bidirectional convergence: task created on A appears on B (syncAuthor correct), and B→A
- [ ] rounds quiesce: pending=0 both sides
- [ ] unpair: initiator's list drains; the OTHER side keeps a zombie card in the
      "unpaired by the other device" state (P2c design — never a silent vanish); re-pair recovers
- [ ] sync off: kill switch works, no stale remote state in UI
- [ ] payload contract test green (no field lost between node/payload/UI/CLI)

### 2. Recycle bin / delete-restore
- [ ] delete from list → appears in recycle bin with source metadata
- [ ] restore → returns to original day/category; sort order preserved
- [ ] purge (--yes) irreversible; dry-run previews exactly what would go
- [ ] delete-wins sync: deletion propagates to peers, restore propagates too

### 3. Tomato focus
- [ ] start (App + cli tomato start) → timer visible, attachable to a task
- [ ] stop records by focused minutes; give-up path records too
- [ ] record fix / rm recover a wrong ledger row
- [ ] remote-running chip appears on peers and clears when the run ends

### 4. Tasks CRUD + scheduling
- [ ] add (App quick-add AND cli add) with date/reminder/category/tag
- [ ] edit moves date; reminder and plan chips move with it (no orphaned chips)
- [ ] complete → cascade to subtasks; undo restores
- [ ] cross-day move keeps time-of-day (drag AND cli batch date)

### 5. CLI parity (spot-check on any write command changed that day)
- [ ] the App-visible result and the CLI-visible output describe the same DB state
- [ ] isolation gate: write commands refuse the real DB without TODO_DB_DIR/--yes-i-know

### 6. Settings surface (any touched tab)
- [ ] every switch/input persists, survives reload, and hot-applies to a running App (~2s)
- [ ] no empty-label form items; collapsed sections read as intentional header rows

## Cadence

- Touch a feature that day → run its automated journey (if one exists) + walk its checklist.
- No automation for that feature yet → the manual walk IS the audit; writing the automation
  for it is the standing follow-up, one feature per maintenance day until coverage is complete.
