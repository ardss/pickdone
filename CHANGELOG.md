# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
