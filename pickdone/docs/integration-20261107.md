# pd20 integration ledger (2026-11-07)

Single integration candidate branch `feat/pd20-integ-20261107`, base = `ad76628a`
(feat/pd20-complete-zcode-20261105 tip; verified superset of the desktop P1 commit
`4c225668` — see `git merge-base --is-ancestor` evidence in EVIDENCE).

## Cherry-pick order (dependency-driven, all `-x`-recorded)

| # | lane SHA | picked SHA | parent dependency | result |
| --- | --- | --- | --- | --- |
| 1 | 799afece (shared UI tokens/primitives) | 2f496d33 | (lane base) | clean |
| 2 | 22289e86 (web offline PWA MVP) | dcc773ee | (lane base) | clean |
| 3 | 5adf0522 (Capacitor mobile MVP base) | eb0dc814 | ad76628a | clean — **initially missed**: the mobile chain's files are DU-conflicts without it |
| 4 | acc5b180 (mobile adopts shared UI) | 7fbd469e | 5adf0522 + 799afece | clean after #3 |
| 5 | ade52b3b (mobile LWW stamps + tombstone guard) | d5fa6724 | acc5b180 | clean |
| 6 | 441c6284 (mobile desktop sync contract client) | 381b638b | ade52b3b | clean |
| 7 | ca758834 (MV3 capture queue hardening) | 31d67d84 | ad76628a | clean |

Conflict inventory: exactly ONE real conflict class occurred — picking the mobile chain
without its base commit 5adf0522 (DU on mobile/index.html, mobile/src/App.vue,
mobile/src/main.js). Resolved by adding the base commit, not by hand-editing hunks.
No file-level overlap exists between the lanes themselves (web/, mobile/, extension/,
shared/ui/ are disjoint; none of the picks touched desktop renderer/main sources).

## Gate compensation

`core.hooksPath` is per-worktree config and was not set in this fresh worktree, so the
picks above did not run the pre-commit gates (recorded honestly; content is identical to
the lane tips, which passed their own hooks). The commit that adds THIS file runs the full
pre-commit suite on the integrated tree as the compensation gate; per-lane bounded builds
and tests were executed separately (see task-dir EVIDENCE):
- shared/ui: tests 5/5 exit 0
- web: vite build exit 0 + tests 5/5 exit 0
- mobile: vite build exit 0 + tests 7/7 exit 0
- extension: `node --check` sw.js + popup.js OK

## Explicitly NOT claimed here
- The mobile/web layers are local/offline-first (IndexedDB/local PWA); the mobile
  "desktop sync contract client" is a CONTRACT client only. This is NOT cross-machine
  sync: real two-device sync stays the desktop LAN sync v1 pipeline (Lane A's real
  Electron HTTP interface is not merged yet — 85d5f3c1 is a pure-module adapter with no
  real routes and is deliberately NOT picked).
- No push/merge/PR #225 action; production A/B installs and user data untouched.
