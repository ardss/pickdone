# Contributing

Thanks for your interest in PickDone! A local-first todos · schedule · pomodoro focus desktop app (Electron + Vue 3 + SQLite).

## Development setup

Requirements: Node.js ≥ 22, Windows 10/11 (macOS/Linux unverified).

> The clone contains the app inside a `pickdone/` subdirectory — all commands below run from there.

```bash
git clone https://github.com/ardss/pickdone.git
cd pickdone/pickdone
npm install            # also wires the git hooks (prepare script)
npm start              # builds the renderer on first run, then launches Electron with an isolated data dir
```

`npm start` / `npm run dev` never touch your real data (`%APPDATA%/pickdone`); use `npm run start:real` for that.

See the [README](README.md) for a full tour, and https://pickdone.app for the live docs.

## Before you submit

```bash
npm run check          # fast loop: ESLint + unit tests + CLI smoke
npm run check:all      # full 29-stage gate CI runs — required green before your PR
```

CI runs `check:all` (lint, typecheck, unit tests, live Electron integration/smoke/e2e, packaging whitelist drift, …); a green `check` alone can still fail CI. Running a single test file: `node --test tests/<file>.test.mjs` from `pickdone/`.

## Guidelines

- **Code style**: ESLint (`npm run lint`), enforced by the pre-commit hook (auto-wired by `npm install` via the `prepare` script)
- **Tests**: new features need tests; bug fixes need a regression test. Test files live in `tests/` and are auto-discovered by `npm test`
- **i18n**: all user-facing copy goes through `$t()` locale packs; zh-CN and en-US must stay in sync (`npm run check:i18n`); zh-CN values are the baseline
- **Data safety**: SQLite is the single source of truth; schema changes require idempotent migrations verified against an old database; never touch data files from the renderer process
- **Visuals/interaction**: keep existing layout and interaction conventions; styles must use the design tokens in `assets/css/base.css` (colors/radii/spacing/motion durations)
- **Accessibility**: new components pass `npm run check:a11y` (axe scan)

## Native module note

SQLite ships as a vendored, prebuilt `better-sqlite3-multiple-ciphers` in `vendor/`; the prebuild is pinned to the Electron ABI this repo locks. If Electron is ever upgraded and a fresh clone fails on the native require, rebuild it with `node-gyp` (needs Visual Studio Build Tools on Windows) inside `vendor/better-sqlite3-multiple-ciphers/`.

## Commit conventions

- Commit messages follow `type(scope): description` with type in `feat / fix / chore / docs / refactor / test / ci`
- Split large changes into small commits; one commit does one thing

## Reporting issues

Use the [issue templates](.github/ISSUE_TEMPLATE): bugs should include reproduction steps, expected/actual behavior, and the app version (Settings → General → current version). Do not paste the contents of `todos.db` (it may contain personal schedule data).

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
