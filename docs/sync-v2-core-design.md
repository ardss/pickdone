# Sync v2 Core Design — Steps 3/4/5: Data Model, HLC + Causality, Merge

Reference spec: the 82-section Sync v2 document (2026-09-29). Problem list:
`docs/sync-v2-old-architecture-problems.md`. This document defines the replacement
protocol core. English only; all code/identifiers final.

## Step 3 — Data model

### 3.1 New table: `sync_revisions` (immutable)

```sql
CREATE TABLE sync_revisions (
  revisionId    TEXT PRIMARY KEY,   -- ULID-encoded (hlcPhysical, hlcLogical, authorDeviceId, hash prefix)
  entityId      TEXT NOT NULL,
  entity        TEXT NOT NULL,      -- 'todo' | 'settings_row' | 'category' | 'plan_chip' | 'filter' | 'tomato_record' | 'meta'
  authorDeviceId TEXT NOT NULL,
  hlcPhysical   INTEGER NOT NULL,
  hlcLogical    INTEGER NOT NULL,
  parents       TEXT NOT NULL,      -- JSON array of revisionIds this revision supersedes ([] = initial)
  payloadHash   TEXT NOT NULL,      -- SHA-256 of canonical payload (after encryption-stripped serialization)
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | synced | quarantined
  createdAt     INTEGER NOT NULL
);
CREATE INDEX idx_revisions_entity ON sync_revisions(entityId, hlcPhysical, hlcLogical);
```

Immutable by rule: INSERT only. No UPDATE on any column except `status`
(pending → synced/quarantined tracks *delivery*, never content).

### 3.2 New table: `sync_revision_payloads`

```sql
CREATE TABLE sync_revision_payloads (
  revisionId TEXT PRIMARY KEY REFERENCES sync_revisions(revisionId),
  payload    TEXT NOT NULL          -- canonical JSON of the entity at that revision (encrypted only in transit/storage on relay)
);
```

Payloads are pruned per retention policy (§29 of spec): keep all `pending`;
keep the latest N per entityId (N=8 initial); always keep revisions referenced by
an unresolved conflict copy. Payload pruning is safe: pruning only loses
*ancestry depth* for peers that are far behind, and those peers bootstrap from
snapshot instead (spec §23).

### 3.3 Existing tables change minimally

- `todos.syncAuthor` (v7) stays as a column but is **deprecated**: written for
  legacy-peer compatibility only, never read by the v2 merger.
- `updatedAt` / `createdAt` / `deletedAt` remain user-facing fields only; excluded
  from all sync ordering decisions (they remain inside the payload for display).
- `sync_oplog` becomes the **local dirty queue**: gains no new columns, may keep
  the ring buffer (P1-3 is fixed because durability now comes from
  `sync_revisions.status='pending'`, not from the oplog — a trimmed pointer for a
  pending revision is re-derived from the revisions table at egress).

### 3.4 Entity identity

`entityId` is already globally unique (existing id scheme). No change.

## Step 4 — HLC + causal model

### 4.1 Hybrid Logical Clock (`shared/sync-core/clock/hlc.mjs`)

```
hlc = { physical: number, logical: number, nodeId: string }
```

Rules (spec §6, all mandatory):
1. Local event: `if (now > physical) { physical = now; logical = 0 } else { logical++ }`.
2. Receive remote `hlcR`: `physical' = max(now, physical, hlcR.physical)`;
   logical resets to 0 iff physical advanced, else `max(logical, hlcR.logical) + 1`.
3. Wall-clock rollback can never lower the HLC (physical is monotone by rule 1/2).
4. Total order: `(physical, logical, nodeId)` — nodeId is the deviceId, stable.
5. Persistence: HLC state persisted in `settings_rows` key `sync.hlc` on every
   bump batch (crash may lose ≤ the last batch's logical counter; recovery rule:
   on load, if stored physical > now, adopt stored physical with logical+1).
6. `Date.now()` is allowed ONLY inside the HLC module; nowhere else in sync code.

### 4.2 Revision identity and parents

Every local write produces exactly one revision:

```
revision = {
  revisionId, entity, entityId,
  authorDeviceId,        // = HLC nodeId of the writing device
  hlc,                   // assigned at commit time inside the SQLite transaction
  parents: [...],        // revisionIds of the entity's current revision(s) at write time
  payloadHash, payload
}
```

- **Single-parent (sequential)**: normal edit — parents = [currentRevisionId of
  that entity]. Stored on the entity row as `currentRevisionId` (new column,
  nullable, added per entity table via one migration).
- **Multi-parent (merge result)**: when a concurrent incoming revision is merged,
  the *materializing* device writes a new revision whose parents =
  [local current, incoming] — only when the merge produces content different from
  both inputs. LWW materialization without content change does NOT mint a
  revision (peers converge by applying the same LWW rule deterministically).
- **Causal visibility**: a device's per-entity "version vector" is implicit —
  ancestry is checked by walking `parents` links available in
  `sync_revisions`; peers exchange recent revision envelopes so the common case
  (depth ≤ 3) resolves locally without graph fetches. Depth-bounded: if a needed
  ancestor is payload-pruned locally, classify conservatively as `concurrent`
  (falls back to deterministic LWW — same outcome as today, never data loss
  because loser materialization still applies).

## Step 5 — Merge model (`shared/sync-core/causality/merge.mjs`)

### 5.1 Classification (replaces compareRecency entirely)

Given incoming revision R against local current C (per entityId):

| Case | Condition | Action |
|---|---|---|
| duplicate | R.revisionId seen (revisions table or seen-set bloom) | ignore, ack |
| ancestor | R ∈ ancestors(C) | ignore (stale), ack |
| descendant | C ∈ ancestors(R) | fast-forward: apply R payload |
| concurrent | otherwise | LWW materialization + loser history (5.2) |

### 5.2 Concurrent resolution

```
winner = deterministicMax(R, C)   // (hlc.physical, hlc.logical, authorDeviceId)
```

- Loser (the non-winning side) is preserved: if loser content differs from winner
  content (existing `contentFingerprint`, minus bookkeeping), mint conflict copy
  (existing loser-materialization machinery, unchanged behavior contract).
- If loser content is identical or loser is a tombstone already reflected → no copy.
- The `syncAuthor`-based `sameLineage` heuristic is deleted; causality replaces it.
  Legacy rows without revisions classify as `concurrent` (conservative — today's
  behavior), so the migration path is behavior-preserving for old data.

### 5.3 Determinism guarantees

Merge is a pure function of (local revision graph, incoming revision) — no wall
clock, no local seq, no map iteration order. Two devices applying the same
revision set in different orders reach identical state (spec §50 convergence
property). Tomato-ledger special rule (larger focusDuration wins) is retained as a
domain comparator applied *after* causal classification, only on concurrent.

### 5.4 What is explicitly NOT in v1 of the core

No Merkle-DAG, no CRDT document model (spec §62/§63 respected), no server-side
merge (§61), no second merger — `mergeRevision()` is the single entry point
(§60).
