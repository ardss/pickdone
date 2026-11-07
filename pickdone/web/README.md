# PickDone Web MVP

Independent Vue 3 / Vite PWA. All data is stored in this browser's IndexedDB. It does not read or migrate any desktop database and does not use Electron `window.todoAPI`.

## Run

Requires Node 22.12+. From `pickdone/web`:

```sh
npm ci
npm test
npm run build
npm run preview
```

Open the URL printed by Vite on the same computer. The production build registers a service worker on localhost or HTTPS. Open it once online, wait for the service worker to activate, then it can load offline. Development mode does not register the service worker. A LAN HTTP address is not an installable PWA secure context; use HTTPS for devices on a LAN. No LAN server or sync API is included.

## Data and recovery

Today tasks support create, read, edit, completion and deletion. Project records use the desktop `categories` shape with integer `id`, `isFolder: 0`, and `categoryId` on tasks. The explicit `desktopSnapshot` boundary emits `projectCategoryFlag:<id> = 1` meta DTOs for live project categories; it does not send data anywhere. Work episodes use `work_episodes` shape with `id`, `taskId`, `startedAt`, `endedAt`, and `note`. Display aliases are `episodeId` and `summary` only. Deletes retain `deleted`, `deletedAt`, and `updatedAt` tombstones. Task title maps to `content`; unknown optional fields survive edits and backup round trips.

Use **备份与恢复 → 导出 JSON 备份** regularly and save the JSON outside the browser. **从 JSON 恢复** replaces this browser's three local collections after confirmation. Export the current copy before restoring. Clearing browser site data or switching profiles/devices removes the local copy; the JSON is the recovery source. Backups are plain text and may contain sensitive task content, so store them privately.

This version has no desktop pairing, LAN sync or relay sync. A future transport must require expiring scoped pairing credentials, origin and CSRF checks, and merge tests for duplicates, tombstones, order and version before accepting writes. Never expose an unauthenticated LAN write endpoint.

## Acceptance

`npm test` checks the contract mapping and backup shape. For browser acceptance, use the built preview: create/edit/complete/delete a task; create/edit/delete a project; create/edit/delete an episode; reload and inspect IndexedDB persistence; disconnect network and reload under the active service worker. Screenshots and exact results belong to the branch delivery evidence.

## Shared interface

Web imports Vue components and semantic tokens from `pickdone/shared/ui` for task, project and work episode cards, action buttons, and empty states. A theme switch in the header stores the browser's light or dark choice locally. Web keeps its own responsive page layout and IndexedDB adapter; the shared package contains presentation code only. Desktop pairing and authenticated LAN/Relay transport remain future work.
