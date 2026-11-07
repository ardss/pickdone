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


## Phase 2 (same lane, 2026-11-07): REAL desktop wiring — commit after 85d5f3c1

The pure-module layer is now wired to actual transports in the Electron main process:

| Module | Role |
| --- | --- |
| `pickdone/src/main/cross-platform/desktop-repo.js` | Maps the five authoritative entities onto EXISTING `db.call` ops (`getById/getAll/upsert`, `upsertCategory/getAllCategories`, `episodePut/episodeRemoveIds`, `sourcePut/sourceRemoveByIds`, `taskSourcePut/taskSourceRemove`, raw `*AllRows`). Inbound tombstones go through the stamp-preserving `*RemoveIds` path (same doctrine as the LAN sync-apply ingress) — no direct SQL at the boundary, no second model. |
| `pickdone/src/main/cross-platform/http-bridge.mjs` | REAL `node:http` server, binds **127.0.0.1 only**, started ONLY on explicit `start()`. Routes: `POST /crossplatform/pair` (one-shot challenge → capability token), `POST /crossplatform/pull` (all entities as DTOs, READ), `POST /crossplatform/push` (`{ops:[{entity, rows}]}`, WRITE, per-op rows ceiling 500, shape validation INSIDE the gate so unauthenticated probes learn nothing). Every request passes the 85d5f3c1 AuthGate (origin allowlist → CSRF header → rate limit → idempotent replay cache → token+scope). Explicit JSON error codes; 404 on any other route — no SQLite/file/command surface on the wire. |
| `pickdone/src/main/cross-platform/bridge-bootstrap.js` | Electron main wiring. **Disabled by default** (meta `crossplatform.enabled`); pairing secret / session nonce / revocations persisted in the existing db meta store via `db.call` so restart keeps tokens valid and revocations sticky. Exposes `issuePairing` / `revokeDevice` / `setBridgeEnabled` for the desktop settings surface. |

### Evidence

```
node --test pickdone/tests/unit/cross-platform/*.test.mjs
# tests 70  pass 70  fail 0   -> exit code 0   (was 54 module tests; +16 real-wiring tests)
node cli/check-environment-boundary.mjs   -> PASS
eslint (new files)                        -> 0 problems
```

`http-bridge.test.mjs` (13 tests) runs a REAL temp SQLite (canonical SCHEMA DDL from `db-schema.js` via node:sqlite) + REAL `node:http` on 127.0.0.1 ephemeral port + REAL `fetch()` round trips, covering: unpaired/missing-token 401, forged CSRF 403, foreign origin 403, one-shot pairing replay 410, wrong code 401, WRITE-scope push landing in desktop SQLite, duplicate-messageId retry = cached verdict + no double write, tombstone conflict surfaced + stale-delete guard, episode/source/link round trip + stamp-preserving tombstone ingress, mid-session revoke over the wire, **desktop restart recovery** (same persisted meta → old tokens still valid, revocations sticky, pairing secret survives), malformed JSON 400, over-ceiling batch 400, READ-scope cannot push, audit trail. `bridge-bootstrap.test.mjs` (3) proves default-disabled, meta persistence, idempotent start, real pair→pull through the bootstrapped singleton, and teardown.

### Endpoint contract for the Android/Web lanes (integration handoff)

- `POST http://<host>:<port>:<port>/crossplatform/pair` `{challengeId, code, deviceId}` → `200 {ok, token, expiresAt, scope, deviceId, csrfHeader}` | `401 challenge_bad_code` | `410 challenge_burned/expired` | `429 challenge_throttled`
- `POST .../crossplatform/pull` `{deviceId, messageId}` + `Authorization: Bearer <token>` + `X-PickDone-Request: <csrfHeader>` + browser `Origin` allowlisted → `200 {ok, result:{entities:{todos,categories,work_episodes,source_refs,task_source_links}, pulledAt}}`; DTO field aliases per dto.mjs (`taskId/title`, `episodeId/summary`)
- `POST .../crossplatform/push` `{deviceId, messageId, payload:{ops:[{entity, rows:[dto]}]}}` (≤500 rows/op, ≤500 ops) → `200 {ok, result:{results:[{entity, outcomes:[{verdict, conflict?}], decodeErrors}]}}`; verdicts: applied / idempotent_skip / stale_skip / conflict_tombstone_wins / conflict_edit_wins / rejected
- Errors are machine-readable codes: `origin_rejected`, `csrf_rejected`, `rate_limited(+retryAfterMs)`, `token_missing/bad_signature/expired/revoked/bad_scope/bad_payload`, `message_id_required`, `invalid_json`, `not_found`, `method_not_allowed`
- Retry/idempotency: on any ambiguous failure re-send with the SAME `messageId` — the bridge returns the cached verdict and never re-applies.

### Still BLOCKED (do not claim device-level E2E from this lane)

- Desktop settings UI/IPC to flip `crossplatform.enabled`, display the pairing code and list paired devices (this lane exposes the hooks only).
- Real-device Android (APK on hardware) and real-browser Web/PWA bidirectional flows — other lanes; the endpoints above are the contract they integrate against.
- LAN-reachability beyond loopback: the bridge binds 127.0.0.1; opening it to the LAN is a deliberate, user-enabled decision OUT of this lane's default.


## Phase 3 (2026-11-07): settings surface + LAN exposure + discovery — commits ed71f9a4 / 94e9b865

| Piece | Location |
| --- | --- |
| IPC channels | `pickdone/src/main/cross-platform/bridge-ipc.js` — `crossplatform:status / set-enabled / set-lan / pair-issue / revoke / port`; registered in `src/main/index.js` registerIpc; every channel main-window-gated (aux windows rejected, same sender-identity discipline as settings domain); responses sanitized (no secret, no token, no user rows) |
| Preload surface | `pickdone/src/preload/index.js` — `window.crossPlatformAPI` |
| Settings UI | `pickdone/renderer/js/components/settings/SettingsCrossTab.vue` + `SettingsModal.vue` ('cross' tab): enable toggle (default OFF), second explicit opt-in for LAN exposure, port/bind status line, one-time pairing code with countdown + scope choice (READ/WRITE), paired-device list with revoke, sanitized last-error; i18n zh-CN + en-US (`crossPlatform.*`) |
| LAN exposure | `http-bridge.mjs` `bindAddress` option; `bridge-bootstrap.js` binds `0.0.0.0` ONLY when meta `crossplatform.lanEnabled === '1'`, else always `127.0.0.1`; disabling the bridge resets the LAN flag (safer re-enable default) |
| Discovery | `GET /crossplatform/hello` — the only unauthenticated route, returns `{service:'pickdone-crossplatform', proto:1, pairingRequired:true}`, no user data |
| Device registry | paired devices persisted via db meta `crossplatform.devices` (`{deviceId, scope, pairedAt, revokedAt?}`); `status()` exposes the sanitized snapshot |
| Trust-root sync guard | `shared/machine-local-keys.mjs`: `crossplatform.*` added to `isMachineLocalMetaKey` — the pairing secret/nonce/revocations never replicate onto peers (a peer row would overwrite the local trust root) |
| Command-bus gate | bridge ingress surfaces registered in `cli/check-command-bus.cjs` exemption ledger (injected-contract class, write-call ratchets 8/4) |

### Default posture

Bridge OFF → no listener exists at all. Enable (settings toggle) → listener on 127.0.0.1 only; loopback clients (same-machine web PWA/extension) work, LAN devices cannot reach it. Enable LAN (second toggle) → wildcard bind; data still gated by pairing + scoped tokens + origin/CSRF/replay/rate. No system proxy/firewall changes are made by this lane; port is ephemeral unless pinned by the caller.

### Evidence (phase 3)

```
node --test pickdone/tests/unit/cross-platform/*.test.mjs  -> 76 pass / 0 fail, exit 0
  bridge-settings.test.mjs (6): discovery beacon, loopback-default status (secret-leak assert),
  LAN-mode bind answering on the machine's real LAN address, TWO independent clients
  (web WRITE / android READ: push, pull, scope deny, disconnect retry, tombstone delete,
  mid-session revoke), IPC channels incl. aux-window rejection on every channel and
  meta-state restart semantics
component gates (w5 split / structure / sfc)  -> 32 pass / 0 fail
node cli/check-command-bus.cjs -> PASS;  w33 gate green;  vite build exit 0
pre-commit full suite (last runs) -> 3148 pass / 0 fail (ed71f9a4), 5498 pass / 0 fail (94e9b865)
```

### Integration handoff for Web/Android client lanes (updated)

- Same endpoints as Phase 2, plus: discovery via `GET /crossplatform/hello`; pairing codes are minted on the desktop settings tab (user reads the 6-digit code + sees its countdown); device identity = the `deviceId` the client chose (<=64 chars).
- LAN reachability requires the desktop user to flip BOTH toggles (bridge + LAN). Clients should surface `origin_rejected` (ask desktop to allowlist the web origin) vs `csrf_rejected` (send the pairing-issued `csrfHeader` verbatim on every request) distinctly.

### Still BLOCKED (unchanged, not faked)

- Real Android device / real installed desktop E2E (other lanes / QA).
- Relay/cloud path reuse for mobile: the bridge currently serves direct HTTP; riding the existing Relay for NAT-traversal is a deliberate follow-up, not claimed here.
