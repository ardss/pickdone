# Changelog

All notable changes to PickDone are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org/).

Generated per release from the real commit range (`git log vPREV..vNEW`), split into user-facing vs internal. Never invent entries; if a release has no user-facing changes, say so plainly.

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
