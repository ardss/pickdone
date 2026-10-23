
### D9 appendix - evening burst-load evidence (2026-10-23 17:00-22:15)

Three full-gate runs under the day's worst ambient bursts red'd ROTATING
timing-sensitive suites (unit tier and live pool), every one green in
isolation immediately after: J4 lan-sync-journey (4/4, 66s gate-equivalent),
C4 transport-buffer-budget (3/3), F1 e2e-exit-close (3/3, 12s) - none of
them touched by the wave. Robustness fixes landed from the diagnoses:
- visual readiness probe 5s fetch / 90s window (vite first-transform
  starved the 2s budget in-gate only).
- shared-pool CDP resets 8s -> 20s (Runtime.enable round-trip stalled past
  8s under burst).
- lan-sync-journey global watchdog 300s -> 900s (in-gate suite wall is
  ~2-3x solo under burst; budget-must-cover-worst-path law).
- core concurrency default re-reverted to 4 (tally at 8: 2 green / 1 red
  depending on load - not a safe default on a family box; 8 stays available
  via TEST_CONCURRENCY for quiet windows).
Doctrine confirmed: full-gate reds under burst load are triaged by victim
(green-in-isolation = load class, documented; red-in-isolation = RED-first
fix). The 31/31 single-run stamp belongs to a quiet window, not a dice-roll
rerun under burst.
