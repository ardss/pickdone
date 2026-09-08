# Changelog

All notable changes to PickDone are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org/).

Generated per release from the real commit range (`git log vPREV..vNEW`), split into user-facing vs internal. Never invent entries; if a release has no user-facing changes, say so plainly.

## [Unreleased]

### Fixed

- Edit panel Esc no longer closes it through an open top-level overlay (repeat-delete confirm / account modal / abandon-focus / focus-record dialogs); the pomodoro bar's give-up button is brand teal per the 2026-09-03 decision, and the countdown text no longer pretends to be clickable.
- Habits can be renamed again (the rename entry was never reachable from the template); frequency forms reject an empty weekday set and clamp the every-N-days interval to 2-30.
- Tomato account edit form gained the "abandoned" toggle so a record can be corrected back and forth; matrix-grid quadrant drops now show an undo toast (with a full important/urgent/priority snapshot revert) instead of silently rewriting three fields.
- Calendar popover in the date strip now honors the week-start setting (headers and leading blanks rotate with it) instead of always hardcoding Monday; collapsed expired-day groups no longer leak dead `expired-<ts>` keys into settings forever.
- Search results past the 200-item render cap show an explicit "showing first 200 of N" notice; clearing search returns to the originating view via deterministic navigation instead of a history-dependent `$router.back()`.
- Mobile move announcements are standalone sentences (no more English "Completed Moved down: xxx"); every `role="checkbox"` toggle in the task views responds to Space as well as Enter, and the todo-box batch check is keyboard-focusable; the due-date clear button gained an accessible name.
- First-run onboarding tour crashed (TDZ reference) and leaked a poller when no task existed yet; "replay journey" from Settings was reliably broken on an empty workspace.
- Dangerous-operation double-confirm dialogs (backup restore / demo-data purge) showed unrelated texts — body read "syncs with the pomodoro panel in real time" and the confirm button read "Break length (minutes):"; both now use dedicated copy (en/zh).
- Meta garbage collection never ran since launch: the startup routine called a nonexistent DB op, so orphan meta keys (deleted repeat rules, removed categories) accumulated forever; failed schema migrations no longer get skipped forever by a later migration advancing the version.
- White-noise player could play two sources simultaneously when switching quickly; focus timer no longer accepts a stray completion with a zero start time, and abandoned sessions no longer book the full planned rest as if it happened.
- Give-up accounting now records zero actual rest; completed focus records the actually elapsed minutes instead of whatever the current setting says; per-day focus totals in CLI `stats` now exclude abandoned pomodoros, matching the in-app statistics page.
- Pomodoro ledger writes are retried (pending queue + quit-flush restore) instead of being silently dropped on transient DB failures; task edits gained the same pending-queue reliability; a failing save in the edit panel no longer clears its dirty flags silently.
- Attachments/uploads can no longer land on a different task when switching tasks mid-upload; float-window toggle reflects the real shown state instead of an optimistic flip.
- Drag-and-drop now inserts at the position the drop indicator promised; sub-task checkboxes keep identity on duplicate names; quick-delete button is keyboard-reachable; search filter values no longer stick forever; manually picked quick-add date survives clearing the text.
- Fixed the stale job applying an old project's dependency layout to the newly selected one; removed two always-on polling timers (dependency-view redraw, day-rail fit) that burned CPU while idle.
- Data safety: permanently deleted tasks no longer leak their schedule-snapshot meta keys (the GC that should have caught them was the one that never ran); habit/moment ids no longer collide within the same millisecond.
- Dark theme: settings dialog titles use the brand color instead of a hardcoded blue; recycle-bin header icon is visible on dark backgrounds.
- Scheduled single-task writes no longer rebuild the whole reminder schedule on every save; CLI `tomato start -m N` no longer permanently rewrites your focus-length preference.
- Repeating-task instances generated in bulk start with unchecked subtasks (matching auto-renewal); un-completing a parent no longer bounces back to completed when its subtasks are all checked; deleting the last instance of a repeat group no longer strands the rule silently.
- Misc: valid `autocomplete="off"`, focus-visible outlines where `outline: none` killed keyboard navigation, real search-result count behind the 200-item render cap, updater notice no longer depends on an unrelated API being present.

### Changed

- Developer-mode experiment gating hardened (dependencies/projects modules stay hidden by default); internal reliability hardening across renderer stores and the main process; cache stamps bumped.

## [0.1.2] - 2026-09-06

Internal quality release; no user-facing feature changes.

- Test infrastructure: live UI gates pinned to an English (en-US) app surface; the full 26-gate suite passes on Windows and Ubuntu CI runners (headless Linux under xvfb).
- Release pipeline hardening: the tag-triggered pipeline (gates -> build -> packaged verification -> live boot -> checksums) runs end to end; this is the first version shipped entirely by it.
- Fixed vendored-library checksum drift caused by git line-ending normalization on Windows checkouts.
- Fixed a real-mouse drag test that could be swallowed by an open edit panel on narrow layouts.

## [0.1.1] - 2026-09-06

Release-engineering patch; no user-facing feature changes.

- Fixed the release workflow (a bare colon in a step name broke YAML parsing, so every push showed a failed run).
- CI-adaptive gate concurrency: the full gate suite fits GitHub-hosted 4-core runners.
- Package metadata completed (repository, author, copyright); commit identity pinned to the GitHub noreply address.

## [0.1.0] - 2026-09-06

First public release.

- Local-first todo / pomodoro / habit / project workspace (Electron, encrypted local SQLite).
- Pomodoro ledger: focus records as the single source of truth, day timeline with dual lanes (facts vs plan), one-click manual back-fill.
- Statistics redo: review-narrative-first stats page with personal baseline comparison, 24h focus timeline, attention attribution.
- AI-ready CLI for external agents; calendar, Eisenhower matrix, card deck day view; dark mode; i18n (en/zh).
- Auto-update feed, Windows installer + portable builds.
