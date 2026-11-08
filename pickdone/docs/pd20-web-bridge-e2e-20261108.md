# PickDone 2.0 Web / desktop bridge E2E — 2026-11-08

## Scope
Fresh verification with isolated in-memory SQLite, the actual desktop bridge HTTP service, a built Web PWA and an isolated Chromium browser profile. This test does **not** use production data. It does **not** prove Android device installation, two physical Windows machines, VS Code compatibility or iOS readiness.

## Source and integration
- Original test-only commit: `7c234c99` (`test(pd20): verify real Chromium bridge round trip and portable harness`).
- Integrated scripts: `web/e2e/preflight-probe.mjs`, `web/e2e/web-roundtrip.mjs`.
- The two scripts import the bridge from **this repository's own** `src/main/cross-platform` by default. `PICKDONE_BRIDGE_REPO` is an explicit override for isolated compatibility testing.
- The earlier branch-only `web/e2e/E2E-EVIDENCE.md` was already removed on the integration branch. This standalone report preserves only fresh, relevant test results without restoring deleted historical path records.

## Original isolated-client verification
- `node --check e2e/preflight-probe.mjs` and `node --check e2e/web-roundtrip.mjs`: exit 0.
- `node e2e/preflight-probe.mjs --port 52319`: exit 0; all pair/pull/push OPTIONS routes answered 204, allowlisted origin echoed correctly, non-allowlisted origin denied, unauthenticated POST HTTP 403.
- `node e2e/web-roundtrip.mjs`: exit 0, R1–R5 PASS: one-time pair, pull task into browser task list, create Web task and push to isolated desktop SQLite, conflict after remote tombstone, revoked device token causes visible subsequent request failure.
- `npm test` within the Web package: 18 PASS, 0 FAIL, 0 SKIP, exit 0.
- `git diff --check`: exit 0.

## Debugging and regression lesson
The original browser journey failed at R2 despite the HTTP bridge reporting a successful pull of two rows. The E2E harness had hardcoded an older date and asserted task visibility while still on the Sync page. Updated fixture date to the current local day, switched to the first navigation tab for the card assertion, then returned to Sync before Push. Re-run produced all five accepted legs with exit 0.

## Integrated verification
In the unified integration worktree, tests directly import this worktree's real HTTP bridge and compile the Web client using local Web dependencies. Fresh results on 2026-11-08: `node e2e/preflight-probe.mjs --port 52419` exit 0; `npm test` exit 0, 18/18 PASS, 0 fail/skip; `node e2e/web-roundtrip.mjs` exit 0, R1–R5 all PASS against an isolated canonical SQLite database and Chromium. These do not prove dual-physical-machine or production installation acceptance.

## Remaining user-facing gates
- Android APK install, launch, CRUD and cross-device sync using an authorized device or emulator (label separately).
- Chrome and Edge MV3 live capture and offline queue, and any requested VS Code extension build/install.
- A ↔ B real two-machine and Windows A production candidate acceptance; independent human UI QA.
- Do not push, publish or overwrite real data solely based on these E2E checks.

## 2026-11-08 isolated-Chrome process hygiene correction

The initial E2E harness used fixed CDP port 9251. We found 35 Chrome processes belonging **only to previous isolated test profiles** across two test worktrees; these sessions could compete for that port. We terminated those test-only processes after verifying their command-line user-data-dir paths and confirmed 0 remained. This means the original R1–R5 checks proved behavior, but did not strictly prove that CDP always connected to the newly launched browser.

The integrated harness now obtains fresh loopback ports for bridge, Web preview and CDP; it gracefully closes the browser with its own CDP connection, waits for isolated profile deletion, and converts any cleanup failure into a failing test result. **Fresh rerun after this correction: R1–R5 all PASS, exit 0, and 0 test Chrome processes remain.** The previously created test artifact directory is excluded from Git; production browser profiles were not targeted.
