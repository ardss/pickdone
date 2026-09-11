/**
 * i18n shard manifest (declarative source) — shard order and prefix ownership are declared only here.
 * check:i18n uses this to verify that each shard's actual key prefixes are within the declared prefixes; entries placed in the wrong shard or unregistered new shards are caught by the gate.
 * Note: due to ESM static-import constraints, index.js still hand-writes the load order (currently matching this file); the two must be kept in sync when reordering,
 * and on merge, later same-key entries override earlier ones — reordering changes conflict resolution (see the -D shard header comment for the historical incident).
 * Ownership comments below state each shard's UI area (from the locale file contents); D/E/F carry historical misplacements — kept as-is because
 * merge order depends on them, guarded by the contract tests (see tests/unit/contract-mirrors.test.mjs).
 */
export const SHARDS = [
  // batch, allowed top-level key prefixes (second-level namespaces like statsA.core are matched as 'statsA.core')
  { batch: 'master', prefixes: [] }, // legacy baseline with mixed content, any prefix allowed (being migrated out gradually)
  { batch: 'A', prefixes: ['statsA'] }, // owner: statsA — statistics dashboard (DepView/StatisticsView/ChartCard/MatrixGrid/Insights/Achievements) + statsA.core
  { batch: 'B', prefixes: ['statsB'] }, // owner: statsB — tomato float page, habit view, projects list/detail/docs
  { batch: 'C', prefixes: ['statsC'] }, // owner: statsC — todo-box undo-delete / mark-done-again strings
  { batch: 'D', prefixes: ['statsD'] }, // owner: statsD — window controls, weather widget, tomato panel, quick add, repeat modal; contains historical misplacements, see contract tests
  { batch: 'E', prefixes: ['statsE', 'statsA.core', 'statsG.SideNav', 'statsE.layout'] }, // mixed-content shard: conflict keys were migrated here; do not add new ones
  { batch: 'F', prefixes: ['statsD'] }, // name/content mismatch (F holds statsD); not renamed only because merge order depends on it — historical misplacement, see contract tests
  { batch: 'G', prefixes: ['statsG'] }, // owner: statsG — SideNav, EpTomato, DayRail (statsG.SideNav conflicts live in E, see above)
  { batch: 'H', prefixes: ['statsH'] }, // owner: statsH — SettingsModal / TomatoBar / main shell / layout / TodoGroups (per shard file header)
  { batch: 'I', prefixes: ['statsI'] }, // owner: statsI — category view, project view
  { batch: 'J', prefixes: ['statsJ'] }, // owner: statsJ — TodoItem/EditPanel/CalendarView/filter views+modal/confirm dialogs
  { batch: 'K', prefixes: ['statsK'] }, // owner: statsK — feedback modal + abandon focus modal (tomato account/abandon)
  { batch: 'N', prefixes: ['onboarding', 'update'] }, // owner: first-run onboarding wizard + update notices
  { batch: 'P', prefixes: ['statsP'] }, // owner: statsP — abandon focus modal / habit view final migration
  { batch: 'Q', prefixes: ['projQ'] }, // owner: projQ — v0.2 project status field
  { batch: 'R', prefixes: ['loadR'] }, // owner: loadR — v0.2 schedule-load warning
  { batch: 'T', prefixes: ['todayT'] } // owner: todayT — v0.2 today-page project association
]
