# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Card deck view for the schedule: center-aligned carousel with peekable, clickable side cards (today page)
- `npm run clean:env`: one-command cleanup of temp data dirs created by tests/debugging (never touches real user data)

### Fixed
- Fixed a regression where undo/redo stopped working under specific operation timing
- Dev environment is isolated from real user data by default (`npm start` runs an isolated instance; connecting to the real database requires explicit `npm run start:real`)
- Search supports multiple keywords (space-separated, all must match)
- "Add to bottom" sorting landed mid-list in some scenarios
- Attachment cleanup order and per-item fault tolerance when permanently deleting/emptying the recycle bin
- Recurring tasks deleted as "this event only" no longer leave an orphaned repeat rule
- Initialization failures now show an error dialog and exit (previously a silent zombie process)
- Removed ~220 lines of unreferenced dead code (orphan utilities, legacy achievement-wall styles, unwired IPC channels and image assets)

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
