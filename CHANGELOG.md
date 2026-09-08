# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versioning follows [Semantic Versioning](https://semver.org/).

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
