# Command-Bus Refactor — Spec & As-Built (Phases 1–3, complete)

Status: **DONE** (P1 #104, P2 #106, P3 this document's implementation). Every mutation in the
codebase — renderer, CLI, main-process writers — commits through a single, manifest-driven write
door. The engine (db.js) and its oplog capture are untouched; the bus is a dispatch/validation/
stamping layer on top.

## The single write door

```
renderer actions ──► renderer/js/utils/commandBus.js commit(entity, verb, payload)
                        │  (VERB_TO_OP mirror, cross-checked against the manifest by the gate)
                        ▼
                  IPC 'commands:commit' ──┐
pending-queue replay paths ──► todoAPI.dbCall ──► IPC 'todo-db:call' ──┤
CLI writers (cli/import.js bus facade) ────────────────────────────────┤
main-process writers (purges, receipt writes) ──► bus.commit() ────────┤
                                                                       ▼
                          src/main/command-bus.js  commit / commitOp
                            · resolve(entity, verb) via command-manifest.js
                            · validate payload shape · stamp LWW age (lwwField)
                            · run localKeys classifiers (machine-local keys never egress)
                            · db.call(row.op, payload)   ← oplog capture happens inside db.call
                            · onCommit fanout hooks: 'ls-mirror' (sync kick), 'undo-barrier'
```

`src/main/command-manifest.js` is the single source of truth: one row per command
(`entity.verb → { sync, lwwField, tombstone, localKeys, op, internal? }`). A newcomer reading the
manifest can predict every command's sync behavior: whether the row egresses (`sync`), which age
the bus stamps (`lwwField`), what a delete means (`tombstone`), and which keys stay
machine-local (`localKeys`). Rows with `internal: true` are main-process/CLI-surface only (no
renderer facade row; the todo-db:call whitelist rejects them).

## Exemption ledger (deliberate twin door, not drift)

The gate (`cli/check-command-bus.cjs`, check 4) scans **every** `.js`/`.cjs`/`.mjs`/`.vue` under
`src/` and `cli/` for write-shaped `.call('op'`/`dbCall('op'` literals — including quote variants —
and for dynamic (variable-op) write dispatch, failing on any hit outside this EXHAUSTIVE ledger and
the exact-line anchors below. Each exempt file carries a write-call-count RATCHET that may only
shrink (db.js/command-bus.js ratchet 0 — zero literal write sites forever; tomato-announce.js 1);
adding an entry requires a spec-level justification in the commit message.

| File | Why it may call db.call directly for writes |
|---|---|
| `src/main/db.js` | The engine itself — the bus and every op implementation dispatch here. |
| `src/main/command-bus.js` | The single write door — `commit()` is the only caller that maps commands to ops. |
| `src/main/tomato-announce.js` | Announce meta row written through the init()-injected db surface (`(op,p) => state.db.call(op,p)`), so the announce travels the oplog like every local write. Unit suites stub the injected surface; routing here would bypass the injected contract. |

Since PR #115 the sync ingress no longer needs an exemption: `src/main/sync-apply.js` and
`src/main/lan-sync-bootstrap.js` route their writes through the **injected hookless bus**
(`createBus((op, p) => state.db.call(op, p))` → `bus.commitOp` with `preserveStamp` — payload-
verbatim, peer-carried stamps, and no onCommit fanout, which is correct: subscribers are never
second writers, so ingress commits must not kick ls-mirror/undo-barrier). Their four remaining
mixed read/write dynamic-dispatch closures are pinned to exact source lines (see anchors below).

Plus **6 exact-line anchors** the gate tolerates (each pin tolerates only THAT literal line):

- 2 bus-facade literals in `cli/import.js` (`upsertMany`, `upsertCategory`) — zero-test-edit rule;
  each call is still bus-routed through import.js's bus facade.
- 4 dynamic wholesale-dispatch anchors: 2 in `src/main/lan-sync-bootstrap.js`
  (sync-conflict-backups ops surface, `dbCall` surface) and 2 in `src/main/sync-apply.js`
  (the `createBus` ingress door, and the localKeys readback map). These closures pass the op
  through a variable — mixed read/write injected surfaces that cannot route wholesale through the
  manifest (reads would throw USAGE).

On the renderer side, 3 write-shaped `dbCall` literals are pinned for the same zero-test-edit
reason (`renderer/js/utils/repeat.js` deleteMeta, `renderer/js/components/ProjectDocs.vue` setMeta,
`renderer/js/utils/leftovers.js` setMeta) — all bus-routed: the main-side `todo-db:call` handler
(`handlers/todo.js` `execDbCall`, `viaBus = bus.commandForOp(op)`) routes every manifest write op
through the bus **regardless of channel**, so a write cannot dodge the door by choosing a channel.

## As built (Phase 3 close-out, 2026-09-21)

**Final manifest census** — 38 commands:

| Dimension | Count |
|---|---|
| Total commands | 38 (34 renderer-scope + 4 `internal`) |
| `sync: full` (egresses via oplog) | 27 |
| `sync: local` (machine-local identity/bookkeeping) | 9 |
| `sync: none` (GC markers) | 2 (`plan.prune`, `tomato.migrateFromMeta`) |
| `tombstone: row` / `pointer` / `gc` / none | 15 / 2 / 2 / 19 |

**Census (all write sites → door):**

- Renderer write-shaped `dbCall`/`commitOp` literals: **0** (3 pinned, bus-routed — above).
- Renderer facade `VERB_TO_OP` mirror vs manifest reverse index: **identical, 34 rows** (gate-checked).
- `src/` + `cli/` (including `.cjs`/`.mjs`, quote variants covered) out-of-door write-shaped
  `.call` literals and dynamic-op writes: **0** outside the 3-file exemption ledger and the
  6 exact-line anchors (2 bus-facade + 4 dynamic dispatch).
- Every manifest op exists in db.js `OPS` / db-sync-ops (no dead rows); every op in the renderer
  whitelist ∩ db.js `WRITE_OPS` has a manifest row (the door covers the whole surface it replaced).
- db.js op census: **zero dead ops** — every op in `OPS` retains at least one live caller
  (sync-apply reads, CLI, main writers), so no op wrappers were removed in P3.

**As-built additions (arch hardening, PR #115 — verified against `node cli/check-command-bus.cjs` PASS):**

- **`capture` manifest column**: rows declare `capture: 'oplog' | 'none' | 'gc'` (arch review
  2026-09-22 rec #2). `capture: 'none'` (e.g. `todo.commitBatch`) DECLARES db.call's deliberate
  oplog-capture suppression in the manifest itself, so the bus/gates can reason about capture
  without reading db-oplog.js.
- **Shared stamp-clamp twin door**: the future-stamp clamp window is one constant —
  `src/main/stamp-clamp.js` `STAMP_CLAMP_MS` — consumed by BOTH `command-bus.js` (explicit-stamp
  forgery guard in `stampPayload`) and `src/main/sync-apply.js` (`clampSkew` ingress clamp at the
  single choke point for all inbound rows). The gate asserts the twin consumption.
- **Gate tightening**: the scanner now walks `.cjs`/`.mjs` (not just `.js`), normalizes string
  quote variants so `"dbCall"` with double quotes cannot dodge the literal match, enforces the
  per-exempt-file write-call ratchets described above, and cross-checks the manifest's
  `localKeys` classifiers against sync-apply's filters over a **48-key parity corpus** (every
  key family, matching AND non-matching shapes).

**Demolished in P3** (bypassed-era plumbing physically gone):

- Preload write-alias routing: `routeDbCall`/`opCommandMap` + the `commands:manifest` warm-up
  IPC channel — the preload no longer mirrors the manifest; bus routing is enforced solely
  main-side (see above).
- Preload `commands.commitOp` migration shim (zero callers).
- Renderer facade `commitOp` export (zero callers; `commit()` is the only renderer mutation entry).

**Gate proof:**

```
node cli/check-command-bus.cjs              # wired into cli/check-all.js
node cli/check-command-bus.cjs --selftest   # negative self-test (unit suite drives it)
```

Behavior contract: the full unit wall — 1571 tests, **zero assertion edits** across P1–P3.

## Acceptance (the 3 questions)

1. **New feature touch count.** A new synced mutation = 1 manifest row + 1 db.js op + (renderer)
   1 facade mirror line + 1 whitelist entry; the gate fails until the census closes. One row
   predicts sync/tombstone/local-key behavior — no per-callsite discipline to remember.
2. **Bug classes structurally eliminated.**
   - *Dual-write races*: one commit pipeline; fanout hooks are subscribers, never second writers.
   - *Sync-discipline bypass*: the gate proves 0 out-of-door write sites; the ledger is exhaustive
     and documented; the engine ingress twin door is deliberate and census-tied (bulk variants are
     manifest rows).
   - *Undo-stale-snapshot*: the `undo-barrier` onCommit hook re-baselines the external-write
     watcher on every bus commit (previously each writer had to remember to re-baseline).
   - *Echo churn*: `localKeys` classifiers live once in the manifest; machine-local commits kick
     nothing (`ls-mirror` skips them), and the sync engine's identical-content no-op plus
     wire-carried stamps stay outside the bus's re-stamp path.
3. **Onboarding path.** Read `docs/refactor-command-bus.md` (this file), then
   `src/main/command-manifest.js` top-to-bottom — the manifest + the exemption ledger table above
   are the whole mental model. The gate enforces whatever the docs claim.
