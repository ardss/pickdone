# Sync Contract Matrix (U10 checklist)

The canonical persistence matrix for the pickdone desktop app (item counts are APPROXIMATE —
this census drifts as key families land; the authoritative enforcement is
`isMachineLocalMetaKey`/`isMachineLocalSettingKey` in src/main/sync-apply.js, mirrored in
src/main/command-manifest.js and asserted by cli/check-command-bus.cjs). Every future sync
review MUST check new keys and new IPC channels against this document before merging. The renderer-owned half of the matrix lives in
`renderer/js/store/*` + `renderer/js/utils/*`; the main-process half in `src/main/sync-apply.js`
(`isMachineLocalMetaKey`) and `src/main/sync-conflict-backups.js`.

## 1. Machine-local FINAL list (never egress, never ingress)

These keys/entities are per-device by contract. A new key that semantically belongs to this list
must be added to `isMachineLocalMetaKey` (src/main/sync-apply.js) and must NOT be treated as
syncable anywhere in the renderer:

| Key / entity | Why machine-local |
| --- | --- |
| `winBounds` | window geometry is per-machine (multi-window, monitor layout) |
| `db.key` | database encryption key material — never leaves the device |
| `sync.*` | LAN-sync pairing/transport state (rotates on re-pairing) |
| `securityLock*` | privacy-lock password/config — device-local trust boundary |
| `cliTomato*` | CLI tomato run bookkeeping on the machine that ran the CLI |
| `todosVersion` | install/update bookkeeping |
| `firedReminders:*` | per-device "already fired" ledger (each device fires its own notifications) |
| `reminderLastSeenAt` | per-device reminder cursor |
| `settingsRows.src.*` | v6 migration snapshot markers (bookkeeping only) |
| `metaConflictBackup.*` | per-device LWW conflict recovery backups (restore is a local op that re-emits a normal write) |
| pairing identity (device id / keypair) | rotates on re-pairing; syncing it corrupts the pairing graph |
| narrow-viewport forced collapse | transient UI state (SideNav `forcedCollapsed`); the synced `sidebarCollapsed` changes only via explicit user toggle (U4) |
| `gamification.bookkeeping` local parts | `gamification.deviceId`, `gamification.seq`, `gamification.folded`, `gamification.base`, `gamification.lastDeltaKey`, `gamification.baseEmitted` — fold machinery state is per-device; only the delta keys themselves sync |
| `_`-prefixed keys | leading-underscore CLI bookkeeping stamps (settings rows AND meta) — per-device command-channel state |
| `cliSync*` | CLI sync command channel slots (`cmd`/`receipt`/`seq`) — per-machine transport state; syncing them would replay stale commands on the peer (feat/cli-sync-pair) |
| `snowDedup:*` | per-device dedup watermarks (`bumpSnow`) — each device emits its own delta exactly once |
| `schemaVersion` | per-device schema-migrator stamp — a peer's row could regress or over-advance this device's migration state |
| `dayPlanState`, `dayPlanState.*` | legacy whole-package chip JSON migration sources (db.js migration reads them) — a peer's blob would re-poison a device already migrated to the plan_chips row store |
| `db.tomatoState`, `habitsState` | retired/legacy ledger + habits blobs (migration bookkeeping only) |
| `db.settingsState`, `db.habitsState` (meta entity) | the settings/habits whole blobs are EXCLUDED from meta sync (see section 2): they ride field-granular `settings_rows` sync instead; whole-blob LWW would re-stamp stale field values over newer row edits |

## 2. Syncable key contracts (meta entity, field-granular units)

| Key | Shape | Contract |
| --- | --- | --- |
| `tomatoEstimateState:<taskId>` | `"0".."20"` | per-task estimate; `n <= 0` deletes the key. Lazy read-through (`ensureEstimate`, U8) — never scan all ids at boot. Legacy blob `tomatoEstimateState` + ts key stay as the timestamped fallback/migration source |
| `projectCategoryFlag:<id>` | `'1'` / absent | THE project flag unit (U7). The legacy `projectCategoryIds` whole-array blob is READ-ONLY (read union in `category/init`, never written by the renderer) |
| `gamification.delta.<deviceId>:<seq36>` | `{snow, tomatoGain, ts, base?}` | append-only increment deltas (or one-time `base:true` migrations that fold per-field max). Folded exactly once per device via the folded guard; fold foundation is LS `gamification.base`, never the display blob (U1) |
| `gamification.delta.<deviceId>:c` | `{snow, tomatoGain, ts, gen, compacted:[keys]}` | per-device compaction subtotal (U9b); `gen` grows per compaction run, peers fold the generation delta minus individually-folded covered keys |
| `gamification.delta.index` | `JSON array of keys` | shared index, read-modify-write union by every writer; init re-adds the device's own last delta key if a race orphaned it (U9a) |
| `tomatoRunAnnounce.<deviceId>` | run announcement | per-device announce channel for running pomodoros |
| blob carriers | `db.settingsState`, `db.habitsState` | whole-blob mirrors (SQLite meta) used for restore/new-machine seeding ONLY — they are excluded from meta SYNC (both egress and ingress, `isSyncBlobMetaKey` in sync-apply.js). Field-granular settings sync rides `settings_rows`; syncing the blob itself would apply whole-blob LWW and let the receiving bridge's mergeDoc re-stamp stale field values OVER newer row edits (whole-blob LWW poison) |

## 3. Round kinds

Round kinds are the syncable entity names emitted by the main apply pipeline
(`src/main/sync-apply.js`, `SYNCABLE_ENTITIES`):

`todo`, `setting`, `tomato`, `category`, `plan`, `filter`, `meta`

`DATA_CHANNEL_KINDS = ['todo', 'category', 'plan', 'filter', 'meta']` ride the
`todos-changed` broadcast (`op` = comma-joined kinds) so the renderer re-reads external writes;
`setting`/`tomato` have their own channels. Renderer-side, `externalReload.js` parses these kinds
to decide which stores to reload (estimates ride `meta`, filters ride `filter`).

## 4. Hard rules for every sync review

1. **Any new user-data meta key must NOT enter `isMachineLocalMetaKey`** — machine-local status is
   reserved for per-device state; putting user data there silently forks it across devices.
   Conversely, new per-device bookkeeping MUST enter the list or it will egress and fight peers.
2. **New IPC channels need all three pieces: main-send + preload + renderer listener.** A channel
   with any piece missing is a silent no-op (this class of bug shipped: restore-seam payload U6,
   hot-apply bypass U5).
3. Renderer writes of main-consumed fields (shortcuts, locale) must go through the same path as
   user edits (`todoAPI.updateSettings`) so main hot-applies — raw Vuex commits desync
   renderer/main until restart (U5).
4. Partial inbound object patches merge over CURRENT LIVE STATE, not defaults (U3).
5. Viewport/system-driven UI state stays transient; synced preference keys change only via explicit
   user intent (U4).
6. Fold-once ledgers mark keys consumed only after a successful non-null read (U2); null reads are
   retried next init.
