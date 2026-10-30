# Round-2 red ledger (journey-audit battle 2)

Purpose: gate-red classification for the round-2 deep audit, per the round-1
documented-reds merge precedent. Classification rule: a red is OURS (fix now,
RED-first) only if a round-2 batch commit introduced it; everything else is
pre-existing main debt (ledger here, fix opportunistically or in a dedicated
wave) or live-tier contention noise (re-verify in a quiet window).

## Fast tier (24 gates, 2026-10-22 21:52-22:15 run): 21 green / 3 red

### RED: 结构尺寸棘轮 (file-size ratchet)

5 files over. Classification:

| File | Over by | Introduced by | Class |
|---|---|---|---|
| renderer/js/store/todo.js | 834 > 829 baseline | **81b5aaf8 (J15, round-2)** | **OURS — FIXED** 6481dce1 comment-only trim back to 829=baseline, J15 pin `# fail 0` |
| renderer/js/main.js | 802 > 800 | b31aec05 (J6 v2, round-1, already on main) | round-1 merged debt |
| src/main/index.js | 862 > 860 baseline | 71380bd3 (F1, round-1, already on main) | round-1 merged debt |
| renderer/js/views/StatisticsView.vue | 802 > 800 | 333f9ec7 era (round-1, on main) | round-1 merged debt |
| renderer/js/views/TomatoFloatPage.vue | 816 > 800 | 0a7a0766 (J2/J3, round-1, on main) | round-1 merged debt |

The four debt files need real extraction work (comment-trim saturations mostly
spent in e31d651f), out of round-2 audit scope. Tracked for a dedicated
size-ratchet wave.

### RED: 单元测试 (unit suite, run-all)

Full-run TAP (unit-full.log, 2026-10-22 22:14-22:50) named 17 not-ok entries.
Per-case classification (rule: isolated re-run decides contention artifact vs
real red):

| # | Failing case | Suite | Class | Disposition |
|---|---|---|---|---|
| 1 | [A2] completeAction undo only toasts success after the dispatch resolves | d21-domc-fixes | **OURS** — anchor pinned the pre-J17 dispatch shape (`todo/toggleComplete`); J17 re-aimed undo to `todo/updateTodoFields` snapshot-revert | **FIXED** — anchor re-pinned to the new observed-dispatch contract, intent unchanged; green |
| 2 | F4-9 completeAction undo has a re-entry guard (behavior) | f4-ux-fixes-20261019 | **OURS** — behavior test counted `todo/toggleComplete` dispatches only; guard itself intact in J17's code | **FIXED** — counter follows the dispatch type the undo actually sends; green |
| 3 | GOLDEN harness hygiene: fixture env carries NO git pointers | gate-must-fail-golden | PRE-EXISTING env-fragility — `{...process.env}` spread keeps Windows-native `Path` casing; hardcoded `scrubbed.PATH` went undefined under a native-shell parent | **FIXED** — case-insensitive PATH resolution; green under both casings |
| 4-7 | purgeIds/purgeAllRecycle/purgeExpiredRecycle predecessor-strip ×4 | f2b-moments-union-purge-preds | contention cascade — `cancelledByParent` (pending-promise kill), isolated re-run 8/8 green in 0.6s | no product defect; full-run-only |
| 8-9 | runPool flake-event ×2 | check-all-flake-metrics | contention artifact — isolated 6/6 green | no product defect |
| 10 | c1-parse-ux (file-level crash) | c1-parse-ux | contention cascade — isolated 17/17 green | no product defect |
| 11 | E2E F1 exit-mode quits / tray-mode hides | e2e-exit-close | contention artifact — isolated re-run both subtests ok (57s live electron); trailing exit 1 is the file's own watchdog cleanup | no product defect |
| 12-17 | J4 reconnect, drill ×2, S2 offline, encrypted-TodoDB restart, category-tombstone catFiltersBak | lan-sync suites | KNOWN pre-existing debt — lan-sync journey suite's runner-cap/flakiness class documented since round-1 (300s cap at J5+) | ledgered, needs the dedicated quiet-window lan-sync wave |

Coverage-ratchet red stays a consequence red (aborts on any unit fail); it
clears with the suite.

NOTE (process): the first attempt at this re-run produced a 0-byte TAP in the
fast gate and my manual redirect also stayed empty for 26min — run-all.mjs
buffers output to completion, and a duplicate hook-spawned suite (aborted
pre-commit, orphaned) doubled CPU load. Not a product bug; harness/process note.

### RED: 覆盖率棘轮 (coverage ratchet)

Consequence red, not independent: the gate aborts with
"ignoring coverage-summary.json: 9 failing test(s) — aborted runs overstate
coverage". Clears automatically when the unit suite is green.

## Full tier (36 gates, earlier 23.5min run): 23 green / 13 red

13 reds = the 3 fast-tier reds above + 10 live-tier gates (更新链路活体,
UI集成, UI交互冒烟, UI冒烟回归, 端到端用户流, 键盘端到端, CSSOM完整性,
全功能覆盖走查, 视口/遮挡活体, Web视觉回归). Live-tier reds ran inside the
parallel-session contention window (old electrons on 9377/9333 + their gate
runs) and must be re-verified in a quiet window before the round-2 final merge;
per-case triage lands here after that re-run.

## Merge disposition

Batch-1 merge gate = fast tier green. Status after 6481dce1: size ratchet
clear (ours), unit suite pending classification, coverage consequence-pending.
Batch-1 (round-2 fixes J15/J17/J7/dw3/F1-anchor/html-lang/D2 set + driver v2
docs + evidence) merges once the unit reds are classified per the rule above;
documented-reds --no-verify applies only to the ledgered non-ours classes.
