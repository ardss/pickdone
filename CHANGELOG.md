# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versioning follows [Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-09-10

### Added
- Projects gain an explicit status field (active / paused / done / cancelled), replacing the name-prefix habit: overview cards carry a click-cycle status pill with All/Active/Paused/Done/Cancelled filter chips, the project detail header gets a selector, and the CLI mirrors the same field via `project <name> --status` (with a `--status` filter on `projects`).
- Schedule-load warning: a new per-day threshold setting (pomodoro tab, 0 = off). When today's planned pomodoro estimate exceeds it, the today rail shows a compact overload pill with the exact numbers, and each project card shows a per-project today-load chip.
- App operations now land in the same audit trail as the CLI (`userData/cli-audit.jsonl`): every mutating renderer operation is recorded — task saves are refined to add/done/undo/delete/restore/subtask with real before/after snapshots, and plan/tomato/meta/view operations map onto the CLI action vocabulary — so `pickdone log` shows app and CLI history in one stream.
- CLI: `batch done/date/category/tag` over explicit task ids (with `--dry-run`, per-task failure reporting and chip migration on reschedule); saved views shared with the app's saved filters (`view list/add/rm`, `list --view <name>`); category folder hierarchy (`category add --folder/--parent`, `category move` with cycle guard, tree-style `categories` listing); `list --lunar` (lunar-date annotation in text and JSON output).
- Project detail view gains a bottom milestone strip: one marker per milestone under the timeline, hover shows the date and linked-task progress (done/total plus the first few task titles).
- Today page project association: task rows show a project-colored badge that opens the project detail, a compact filter-by-project dropdown joins the toolbar, and `#/todo-list/today?project=<id>` deep-links into a filtered today view (the dropdown mirrors the filter back into the URL).
- CLI `edit --date none|clear` clears a task's date and moves it back to the todo box with exact app parity (main reminder dropped with the date, that day's schedule chips removed, friendly no-op when already undated) — replacing the old create-new-then-delete-old workaround.

### Fixed
- CLI `category add --parent <folder>` always rejected the parent (it read `.folderIs` off the bare id instead of the category row) — folder parenting now works.
- Backup content-dedup compared the OLDEST snapshot instead of the newest (the sort was newest-first but the comparison indexed the tail): dedup never fired in the common case and a stale snapshot could be returned as the current backup.
- A CLI `project --status`/`--deadline` write now reaches a running app — the project metadata loader re-reads both unconditionally instead of keeping the first load's values sticky.
- `list --view` no longer truncates matching tasks at the fetch cap: the view's date/category conditions are pushed into the query (and results are undone-only, matching the app's smart lists).
- CLI hardening: nested folder creation is rejected (`category add --folder --parent`), `project --status X --deadline Y` applies both flags, `list --view X --on <date>` is a usage error, `batch done` on already-complete tasks is an idempotent skip that no longer rewrites `completedAt`, app-side CSV imports land an explicit audit line, and the app-side audit appender retries across rotation windows so concurrent CLI/app rotation no longer swallows lines.

### Fixed
- Reliability batch: the quick-add window now self-heals after a renderer crash (the global quick-add shortcut used to keep summoning a dead transparent bar until app restart); a failed security-password decryption no longer locks the user out forever (it fell through to comparing against the ciphertext); the quit-time flush broadcast now reaches every window, so pending pomodoro ledger entries from the float window and pending task upserts survive quitting when the main window was closed to tray; renderer task rows sent through batch upsert (drag-reorder, Ctrl+S sync) are de-proxied first — nested reactive arrays could fail structured cloning and silently drop the whole batch; purging the recycle bin can no longer be undone into resurrecting physically deleted rows (attachments and chip snapshots were already destroyed); a corrupted legacy pomodoro-ledger blob is never deleted by the migration (previously unrecoverable history loss).
- Consistency batch: one-click pomodoro backfill now derives its date key from the end time and shares the CLI's idempotent id shape and the 600-minute cap (midnight-crossing backfills no longer split between app and database, duplicate ledger rows from App+CLI backfilling the same slot are prevented); completing a task-bound pomodoro no longer clears the undo history via a broadcast echo; completing/reordering/restoring no longer merge into one undo step within the 400ms coalesce window; CLI `overview`/`stats` gain a completed-today caliber aligned with the app (planned-day caliber kept for compatibility); CLI-created and imported tasks insert with proper sort order instead of a constant 0; CLI `repeat off --all` cascades schedule-chip cleanup to future instances (no more ghost schedule entries); backfill accepts up to the database's 600-minute cap with a usage error beyond it; `--remind-offset 0` no longer reports a fake success; Todoist imports keep subtask completion states; imported completed tasks fall back to due/create time instead of stamping everything with the import moment; the browser debug shim implements getById/deleteMeta.
- UX/a11y batch: schedule-chip deletion joins the global 5s-undo contract (was a silent delete); plan chips whose task was deleted show a localized label instead of a raw internal id; keyboard access across the board — search clear button, habit weekday selector (now real buttons with aria-pressed), habit interval input label, todo-box sort/filter dropdowns, quadrant drag-over highlight now covers the whole quadrant (the over class had no CSS at all), subtask up/down buttons are actually focusable and subtask text click toggles it, quick-add's hidden date picker no longer traps Tab focus, the today-experimental drawer no longer leaks focusable elements when collapsed, quick-add estimate −/+ buttons get distinct labels, dependency candidate list says when it truncates at 8, calendar month arrows get titles (and the previously missing year-arrow keys now exist), habit 30-day grid tooltips show formatted dates, aria-keyshortcuts no longer announces keys that are no-ops for undated tasks, category/tag rename gets a hover hint; deleting an attachment no longer deletes the disk file if the task save failed; switching a custom white-noise file takes effect immediately (cache invalidation via a new main→renderer broadcast, preload binding included).

## [0.2.3] - 2026-09-09

### Fixed
- Undo/redo (Ctrl+Z/Ctrl+Y) now replays schedule chips correctly: undoing a soft delete restores the pre-delete chip snapshot, undoing a create clears/snapshots its chips, and undoing a reschedule migrates chips back with the task (previously snapshot replay bypassed the chip-sync chain, leaving chips stranded on the wrong day); a corrupt history snapshot no longer vanishes into an unhandled rejection (parse-before-pop, shortcut handler catches failures).
- Critical-state backup: float/quick-add windows no longer spam unhandled rejections on every pomodoro completion (backup is main-window-only by design and now guarded); manual sync with nothing to write no longer skips the backup.
- Clearing demo data by id-prefix no longer wipes the in-memory ledger when the DB reload fails.
- Quit-time data-loss race: quitting closed the database immediately after asking the renderer to flush its debounced writes, so edits/pomodoro ledger entries still inside the 2s debounce window were silently dropped. Quit now holds a bounded 500ms flush window before persisting and closing.
- "Reset data and relaunch" silently failed on Windows: deleting the open SQLite file always hit EPERM which was swallowed, so the data survived while the app reported a reset. The handle is now closed first, undeletable files are renamed aside for next-start cleanup, and residual failures are reported instead of hidden.
- Renderer crashes no longer leave a dead main window: the window reloads automatically (up to 3 times) after a non-clean render-process-gone, and relaunches the app beyond that; the pomodoro float window destroys-and-recreates on crash too.
- Auto-backup list/read failures are no longer silent: the settings dialog now distinguishes "no backup directory yet" from a real read failure and shows an error hint.
- A failed security-lock window load used to lock the app permanently (blank lock window with `isLocked()` always true); it now falls back to disabling the lock and forcing a password reset.
- Purging demo data now also cascades its plan-chip rows (previously left ghost chips on the timeline).
- Pomodoro ledger appends from the float window during lock screen are restricted to records ending today, matching the update path (no forging historical ledger rows).
- CSV import preview now rejects files over 20MB before a synchronous read could freeze the whole app; running an in-app import now refreshes reminders and the task list immediately.
- Attachment uploads validate base64 strictly (charset, length, decode roundtrip) instead of silently decoding corrupted payloads.
- Reminder sound no longer stays silent on macOS/Linux when no live window exists (system beep fallback).
- The white-noise file picker survives a destroyed/recreated main window instead of throwing on a stale reference.
- CLI/browser-debug fixes: `pickdone done` now honors the `isCompleteWithSubtasks` setting (and `undo` unchecks subtasks symmetrically, so the app no longer instantly re-completes an undone parent); repeat generation re-derives each instance's reminder time onto its own day instead of copying the template timestamp (reminders no longer fire on the wrong date), defaults its generation cap to the `maxRepeat` setting (was a hardcoded 24), and no longer collapses an absent `--count` to a single occurrence; recycle-bin purge now also deletes the purged tasks' attachment files from `files/`; focus-record fix rejects durations over the DB's 600-minute clamp with a usage error instead of reporting 720 while storing 600; project focus stats exclude abandoned pomodoros; the browser debug shim re-derives the ledger `dateKey` from `endTime` like the desktop DB; the renderer `DbCallOp` type now includes `deleteMeta`.

- Interaction consistency across components: Escape inside a stacked dialog (repeat-delete confirm, pomodoro account, abandon confirm, focus-record list) no longer also closes the edit panel underneath; the pomodoro "give up" button follows the decided brand teal instead of the rejected aggressive red; the countdown digits no longer pretend to be clickable; quadrants dropped in the matrix are undoable with a toast instead of silently rewriting three fields; clearing a search returns to the source view deterministically (no dead router.back()); search results beyond the 200-item render cap say so.
- Habits & records: habits can finally be renamed (the rename handler existed but was never wired); the frequency form rejects empty-weekday or out-of-range interval configs instead of silently creating never-firing habits; the pomodoro account dialog can correct an accidental "abandoned" state directly.
- Calendar & a11y: the date-strip calendar popover honors the week-start setting instead of hardcoded Monday; every self-drawn role=checkbox now responds to Space in addition to Enter; the due-date clear button has an aria-label; keyboard-move screen-reader announcements are standalone sentences (no more "Completed Moved down: ..."); stale expired-group fold keys no longer accumulate forever in settings.

- Release-review hardening: quitting after the flush window now re-issues a normal quit so auto-updates still install on exit (the previous fix's app.exit() skipped the quit event); tray → quit no longer crashes when the main window was already destroyed (close-to-tray = off); redoing a delete re-snapshots schedule chips so delete/undo/redo/undo round-trips no longer lose them; Space activation on role=checkbox elements no longer double-toggles (a local binding fought the global handler and cancelled out, making keyboard checking look dead); `pickdone undo --no-sub-cascade` is honored; the security-lock fallback no longer triggers on benign load interruptions.

## [0.2.2] - 2026-09-08

### Added
- Close-button behavior is now a choice: Settings → General exposes "minimize to tray instead of quitting", the first-run wizard gains a matching step, and the first close-to-tray shows a one-shot Windows tray notice explaining where the app went.
- `pickdone skill install` now also registers the skill into `~/.cursor/skills/pickdone/` — Cursor reads Agent Skills natively, so one command covers ZCode, Claude Code and Cursor.
- The website gains a dedicated "Connect AI" page: a copy-paste prompt your AI assistant executes to self-install the CLI contract, plus per-platform guides (Claude Code, ZCode, Cursor, Codex CLI, OpenCode, Gemini CLI).

### Changed
- Install location and executable name are now ASCII: the app installs to `%LOCALAPPDATA%\Programs\PickDone` as `PickDone.exe`. The previous Chinese directory name (`...\Programs\拾事`) broke AI-agent shells on non-Chinese codepages and read as a bug. Your data is untouched (`%APPDATA%\pickdone`, pinned independently of the program dir); the installer removes the orphaned old program directory. Users on ≤ 0.2.1 should simply run the 0.2.2 installer over the existing install.
- Release builds are pre-wired for free SignPath code signing (activates automatically once the maintainer certificate is approved; this release ships unsigned as before).

### Fixed
- Updating 0.2.0 → 0.2.1 failed with "Failed to uninstall old application files" when the app was resident in the tray; the installer now stops the running instance (both old and new exe names) before install/uninstall.
- The encrypted-backup ATTACH statement escapes quote characters in key/path values instead of breaking on them.

## [0.2.1] - 2026-09-08

### Fixed
- First-run onboarding tour crashed (TDZ reference) and leaked a poller when no task existed yet; "replay journey" from Settings was reliably broken on an empty workspace. Stage drivers no longer double-advance via a synchronous destroy callback.
- Dangerous-operation double-confirm dialogs (backup restore / demo-data purge) showed unrelated texts — body read "syncs with the pomodoro panel in real time" and the confirm button read "Break length (minutes):"; both now use dedicated copy (en/zh).
- Startup meta garbage collection never ran since launch: it called a nonexistent DB op and swallowed the error, so orphan meta keys (deleted repeat rules, removed categories) accumulated forever; failed schema migrations are no longer skipped forever by a later migration advancing the version.
- White-noise player could play two sources simultaneously when switching quickly; the focus timer no longer accepts a stray completion with a zero start time; abandoned sessions no longer book the full planned rest as if it happened.
- Give-up accounting records zero actual rest; completed focus records the actually elapsed minutes instead of the current setting; per-day focus totals in CLI `stats` exclude abandoned pomodoros, matching the in-app statistics page.
- Pomodoro ledger writes are retried (pending queue + quit-flush restore) instead of being silently dropped on transient DB failures; task edits gained the same pending-queue reliability; a failing save in the edit panel no longer clears its dirty flags silently.
- Attachment uploads can no longer land on a different task when switching tasks mid-upload; the float-window toggle reflects the real shown state instead of an optimistic flip.
- Drag-and-drop now inserts at the position the drop indicator promised, and the indicator no longer lingers on the drop-target row; sub-task checkboxes keep identity on duplicate names; the quick-delete button is keyboard-reachable; search filter values no longer stick forever; a manually picked quick-add date survives clearing the text.
- Multi-step redo works again (every redo step after the first was killed by a stack reset); rescheduling a task now actually moves its schedule chips to the new day instead of leaving them behind.
- Stale-response race fixed in the dependency view (rapid project switches applied the previous project's layout); two always-on polling timers (dependency-view redraw, day-rail fit) removed — idle CPU drop.
- Data safety: permanently deleted tasks no longer leak their schedule-snapshot meta keys (the GC that should have caught them was the one that never ran); habit/moment ids no longer collide within the same millisecond; the shortcut-conflict fallback no longer calls the electron-log object as a function (main-process crash dialog).
- Dark theme: settings dialog titles use the brand color instead of a hardcoded blue; recycle-bin header icon is visible on dark backgrounds.
- Scheduled single-task writes no longer rebuild the whole reminder schedule on every save; CLI `tomato start -m N` no longer permanently rewrites your focus-length preference.
- Repeating-task instances generated in bulk start with unchecked subtasks (matching auto-renewal); un-completing a parent no longer bounces back to completed when its subtasks are all checked; deleting the last instance of a repeat group no longer strands the rule silently.
- Misc: valid `autocomplete="off"`, focus-visible outlines where `outline: none` killed keyboard navigation, real search-result count behind the 200-item render cap, updater notice no longer depends on an unrelated API being present.

## [0.2.0] - 2026-09-07

### Added
- Projects module (experimental, off by default — enable via Settings → Developer mode): project overview with milestone rings and 7-day trend, embedded dependency graph, per-project docs with autosave
- Dependency view (experimental, off by default): auto-layout rewrite with barycenter ordering (no more wire crossings), directional drop zones on dependency linking, drag highlight and selection states
- Card deck view for the schedule: center-aligned carousel with peekable, clickable side cards (today page)
- `npm run clean:env`: one-command cleanup of temp data dirs created by tests/debugging (never touches real user data)
- Visual regression gate for the web host (14 scenes × light/dark, 0.4% pixel threshold) wired into `check:all`

### Changed
- CSS architecture refactor: the four legacy deposit stylesheets (style-1..4) are retired — component styles now live in their SFC `<style>` blocks; global CSS reduced to `base.css` (tokens/skeleton/shared, 2720→2296 lines) + `theme-dark.css` (dark tokens/patches, ~150 lines); verified by a freeze gate (global files may only shrink), exact CSSOM rule counts, and pixel-level visual regression
- Dark mode: legacy `html.dark` selectors unified to `html[data-theme="dark"]`; Element Plus dark accent ramp corrected (pastel near-white hover fills → teal family darkened toward the background)
- Internal: z-index and brand colors in component styles routed through tokens

### Fixed
- Fixed a regression where undo/redo stopped working under specific operation timing
- Dev environment is isolated from real user data by default (`npm start` runs an isolated instance; connecting to the real database requires explicit `npm run start:real`)
- Search supports multiple keywords (space-separated, all must match)
- "Add to bottom" sorting landed mid-list in some scenarios
- Attachment cleanup order and per-item fault tolerance when permanently deleting/emptying the recycle bin
- Recurring tasks deleted as "this event only" no longer leave an orphaned repeat rule
- Initialization failures now show an error dialog and exit (previously a silent zombie process)
- Removed ~220 lines of unreferenced dead code (orphan utilities, legacy achievement-wall styles, unwired IPC channels and image assets)
- Milestone ring percent text no longer clipped on project overview rings
- Dependency-graph wires no longer linger after a drag completes

## [0.1.2] - 2026-09-06

### Fixed
- CI hardening: xvfb for Ubuntu Electron gates, drag-gesture hardening and failure diagnostics, CRLF-proof vendor libraries, gated-spawn diagnostics
- i18n live gates pinned to the en-US surface

## [0.1.1] - 2026-09-06

### Fixed
- Release workflow: bare colons in step names broke YAML parsing (every push showed a startup failure)
- `check:all` auto-downshreds lanes on CI (GitHub runner 4 vCPU cannot sustain local 3+3 parallelism)
- Commit-identity gate added (personal e-mail on a public repo is rejected)

## [0.1.0] - 2026-09-03

First public release.

### Added
- Today list (list / Eisenhower matrix views), recent todos, todo box, completed, recycle bin
- Schedule month calendar: lunar dates + holidays + drag to reschedule + completed display
- Categories / tags
- Pomodoro workflow: 25+5 rotation, desktop floating timer, ambient sounds, 24h focus timeline
- Review: narrative report · charts · achievements tabs, powered by a local rules engine (no AI dependency)
- Subtasks, recurring tasks, undo/redo, attachments, Excel/PDF export
- Automatic backups + rolling cleanup; encrypted SQLite storage (SQLCipher family)
- Built-in CLI for AI assistants and scripts
- First-launch setup wizard (language / color mode / default list)
- In-app auto-update via GitHub Releases
- English & Simplified Chinese UI
