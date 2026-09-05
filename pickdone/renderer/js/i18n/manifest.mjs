/**
 * i18n shard manifest (declarative source) — shard order and prefix ownership are declared only here.
 * check:i18n uses this to verify that each shard's actual key prefixes are within the declared prefixes; entries placed in the wrong shard or unregistered new shards are caught by the gate.
 * Note: due to ESM static-import constraints, index.js still hand-writes the load order (currently matching this file); the two must be kept in sync when reordering,
 * and on merge, later same-key entries override earlier ones — reordering changes conflict resolution (see the -D shard header comment for the historical incident).
 */
export const SHARDS = [
  // batch, allowed top-level key prefixes (second-level namespaces like statsA.core are matched as 'statsA.core')
  { batch: 'master', prefixes: [] }, // legacy baseline with mixed content, any prefix allowed (being migrated out gradually)
  { batch: 'A', prefixes: ['statsA'] },
  { batch: 'B', prefixes: ['statsB'] },
  { batch: 'C', prefixes: ['statsC'] },
  { batch: 'D', prefixes: ['statsD'] },
  { batch: 'E', prefixes: ['statsE', 'statsA.core', 'statsG.SideNav', 'statsE.layout'] }, // mixed-content shard: conflict keys were migrated here; do not add new ones
  { batch: 'F', prefixes: ['statsD'] }, // name/content mismatch (F holds statsD); not renamed only because merge order depends on it
  { batch: 'G', prefixes: ['statsG'] },
  { batch: 'H', prefixes: ['statsH'] },
  { batch: 'I', prefixes: ['statsI'] },
  { batch: 'J', prefixes: ['statsJ'] },
  { batch: 'K', prefixes: ['statsK'] },
  { batch: 'N', prefixes: ['onboarding', 'update'] },
  { batch: 'P', prefixes: ['statsP'] }
]
