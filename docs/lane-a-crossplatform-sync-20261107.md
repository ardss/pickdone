# Lane A — Cross-platform sync & pairing security adapter (2026-11-07)

Worktree: `.wt-pd20-zcode-sync-20261107` · branch `feat/pd20-zcode-sync-20261107` · baseline `ad76628a`.

## Delivered modules (new directories only)

| Module | Role |
| --- | --- |
| `pickdone/shared/cross-platform/dto.mjs` | Unified DTO v0 mapping over the authoritative desktop tables (todos / categories / work_episodes / source_refs / task_source_links). Aliases: `taskId↔id`, `title↔content`, `episodeId↔id`, `summary↔note`. `isProject` is a view flag on category DTOs, stripped before persistence — projects remain categories, **no second data model**. Unknown client-private fields survive decode; device-private fields (e.g. `fileAttach` paths) never leave on encode. |
| `pickdone/shared/cross-platform/capability-token.mjs` | HMAC-SHA256 short-lived bearer tokens `{deviceId, scope READ|WRITE, iat, exp, jti}`; 15 min default TTL; jti/device revocation; constant-time verify; fail-closed machine-readable codes. Reuses the desktop pairing secret as the single trust root. |
| `pickdone/shared/cross-platform/pairing-challenge.mjs` | One-shot pairing challenge bound to deviceId + scope. TTL reuses `shared/pairing-ttl.mjs` (10 min desktop contract); code derivation reuses `shared/sync-core/pairing.mjs` (HMAC mod 1e6) — one scheme, no drift. Single-use consume (replay → `challenge_burned`), per-challenge attempt throttle (5 bad tries burn), wrong-device probe burns the challenge. Tokens are minted ONLY here. |
| `pickdone/shared/cross-platform/auth-gate.mjs` | Request gate, fail-closed order: origin allowlist → CSRF custom header (`x-pickdone-request` == session nonce) → per-device rate limit (fixed window, 429 + retryAfterMs) → idempotent replay cache on `(deviceId, messageId)` (cached verdict, handler runs once) → token + per-op scope map (`sync.push`/`*.put`/`*.delete` need WRITE; `sync.pull` accepts READ). |
| `pickdone/shared/cross-platform/dto-service.mjs` | Inbound apply over an injected repo shaped exactly like the existing db abstraction door `(entity, op, row)`. Verdicts: applied / idempotent_skip / stale_skip / conflict_tombstone_wins / conflict_edit_wins / rejected. Newer timestamp wins; delete-vs-edit collisions always return a surfaced conflict record (never a silent destroy). Batch apply is per-row independent. |

## Security constraints honored

- **No listener**: pure modules with injected clock/transport; no HTTP/TCP server was started, no `0.0.0.0` binding anywhere in the lane. A real HTTP layer can be wired later by marshaling through `AuthGate.handle` only.
- **No second model**: DTO fields map 1:1 onto `db-schema.js` columns at `ad76628a`; entity allowlist = the five authoritative tables.
- **No production data touched**: all tests run on in-memory/temp structures; no `TODO_DB_DIR`, no real user DB, no other worktree, no renderer/mobile/web files modified.

## Evidence

```
node --test pickdone/tests/unit/cross-platform/*.test.mjs
# tests 54  pass 54  fail 0   -> exit code 0
```

Files: `dto-mapping.test.mjs` (9), `capability-token.test.mjs` (7), `pairing-challenge.test.mjs` (8), `auth-gate.test.mjs` (14), `dto-service.test.mjs` (10), `lane-a-integration.test.mjs` (5+ covering full chain: pair → token → gate → apply, replay idempotency, revoke/re-pair, stale tombstone guard, origin/CSRF/no-creds rejections).

Acceptance matrix coverage: no-credential denial ✓ · expiry ✓ · revocation (jti + device) ✓ · Origin ✓ · CSRF ✓ · duplicate messages (gate replay + dto-service idempotent skip) ✓ · task/project(category)/episode/source field mapping ✓ · tombstone conflicts (delete-vs-edit both directions + stale guard) ✓.

## Not done (explicitly out of scope)

- No push / merge / release. No real HTTP listener enablement. Android/Web client-side callers are other lanes; this lane is the desktop-side contract they code against.
