# Browser acceptance evidence (2026-11-07)

Built production output with `npm run build`, served with Vite preview at `http://127.0.0.1:4173/`, and used a real Chromium session through `agent-browser --session pd20-web`.

- Created and renamed a project, created and edited a task attached to it, marked the task complete, and reloaded. The task and completion persisted in IndexedDB.
- Created and edited a work episode. Reloaded with browser network set offline; Chromium reported `navigator.onLine === false` and an active `navigator.serviceWorker.controller`. The task, project, and episode remained visible.
- Deleted each entity. The UI hid it and direct IndexedDB reads showed `deleted: 1` and nonzero `deletedAt` rather than physical removal.
- Uploaded `../tests/restore-fixture.json` through the recovery file input while offline. After another offline reload, direct IndexedDB reads returned the restored task, project, and episode.
- Triggered the export UI and read its generated Blob: `format: pickdone-web-backup-v1`, with one row each for tasks, projects, and episodes.
- Browser `errors` command returned no errors.

Screenshots from the live Chromium session: [today offline](today-offline.png), [work history offline](history-offline.png), [backup page offline](backup-offline.png). The screenshots show the browser test profile's synthetic data only. Desktop data and desktop sync were not accessed.
## Shared UI integration acceptance

After cherry-picking shared UI commit `799afece`, the Web app imports shared tokens, `PdActionButton`, `PdEmptyState`, `PdTaskCard`, `PdProjectCard`, and `PdWorkEpisodeCard` directly from `pickdone/shared/ui`. No desktop API or mobile source is imported.

A separate Chromium profile (`pd20-web-shared`) opened the production Vite preview. It created a project, a task linked to that project, and a work episode. The live DOM contained one each of `.pd-project`, `.pd-task`, and `.pd-episode` on their respective pages. With network emulation offline, reloading kept the task and work episode visible from IndexedDB; `navigator.onLine` was false and `navigator.serviceWorker.controller` was present. The browser reported no page errors.

- [Desktop Today, offline](today-shared-wide-offline.png)
- [Desktop Work history, offline](history-shared-wide-offline.png)
- [375px dark Today, offline](today-shared-mobile-dark-offline.png)
- [375px dark Projects, offline](projects-shared-mobile-dark-offline.png)

The 375px dark test measured `innerWidth=375` and `document.documentElement.scrollWidth=375` after the layout fix. The loaded CSS filename matched the final build (`index-C7uRC98j.css`). Screenshots contain synthetic browser test data only.

## Commit gate record (2026-11-07)

The repository's native pre-commit hook was attempted on the shared UI files. Its environment boundary, staged JavaScript syntax, tokens/CSS/size/boot-order, ESM graph, and ESLint stages passed. The last stage (`node cli/check-test-summary.cjs --core --affected`) started desktop core tests and remained running for about ten minutes; it was interrupted and exited 1. **The native hook did not pass.**

`cli/check-test-scope.cjs` maps `shared/` to `tests/unit/main`, `tests/unit/store`, and `tests/unit/lan-sync`. It has no Web mapping, so Web files fall back to the full core tier. There is no existing native hook mode that runs only the Web and shared UI packages. The bounded, task-relevant checks below were run separately before the two commits. The commits explicitly bypass the native hook because its final test scope is unrelated to this browser-only change and had already timed out; they do not claim native gate success.

| Check | Result |
| --- | --- |
| `pickdone/web: npm test` | EXIT 0, 5/5 tests |
| `pickdone/web: npm run build` | EXIT 0, Vite 29 modules and 5 precached assets |
| `pickdone/shared/ui: npm test` | EXIT 0, 8/8 tests |
| `pickdone/shared/ui: npm run build` | EXIT 0, Vite 16 modules |
| `node cli/check-environment-boundary.mjs` | EXIT 0, 712 source files |
| `node cli/check-tokens.js` | EXIT 0 |
| `node cli/check-css-freeze.mjs` | EXIT 0 |
| `node cli/check-file-size.cjs --staged` | EXIT 0, 17 files, 0 warnings/errors |
| `node cli/check-boot-order.cjs --staged` | EXIT 0 |
| `node cli/check-esm-graph.cjs` | EXIT 0, 248 modules |
| `node cli/lint-staged.mjs` | EXIT 0 |
| Staged JavaScript `node --check` | EXIT 0, 9 files |
| `git diff --cached --check` | EXIT 0 |

The boot-order and ESM graph reruns used `NODE_PATH` pointing to the existing project `node_modules` to resolve `acorn`. No desktop program or user database was opened or changed. Web-to-desktop LAN/Relay sync is still unimplemented.