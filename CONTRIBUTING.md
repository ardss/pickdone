# Contributing

Thanks for your interest in PickDone! A local-first todos · schedule · pomodoro focus desktop app (Electron + Vue 3 + SQLite).

## Development setup

Requirements: Node.js ≥ 20 (22 recommended), Windows 10/11 (macOS/Linux unverified).

```bash
git clone https://github.com/ardss/pickdone.git
cd pickdone
npm install            # installs pickdone dependencies
cd pickdone && npm start
```

See the [README](README.md) for a full tour.

## Before you submit

```bash
cd pickdone
npm run check          # ESLint + unit tests + CLI smoke
```

Commits that fail `npm run check` do not land on main (CI runs the same suite).

## Guidelines

- **Code style**: ESLint (`npm run lint`); enforced by the pre-commit hook (run `npm run setup:hooks` once after cloning)
- **Tests**: new features need tests; bug fixes need a regression test. Test files live in `pickdone/tests/`; see `package.json` scripts for runners
- **i18n**: all user-facing copy goes through `$t()` locale packs; zh-CN and en-US must stay in sync (`npm run check:i18n`); zh-CN values are the baseline
- **Data safety**: SQLite is the single source of truth; schema changes require idempotent migrations verified against an old database; never touch data files from the renderer process
- **Visuals/interaction**: keep existing layout and interaction conventions; styles must use the design tokens in `assets/css/base.css` (colors/radii/spacing/motion durations)
- **Accessibility**: new components pass `npm run check:a11y` (axe scan)

## Commit conventions

- Commit messages follow `type(scope): description` with type in `feat / fix / chore / docs / refactor / test / ci`
- Split large changes into small commits; one commit does one thing

## Reporting issues

Use the [issue templates](.github/ISSUE_TEMPLATE): bugs should include reproduction steps, expected/actual behavior, and the app version (Settings → General → current version). Do not paste the contents of `todos.db` (it may contain personal schedule data).

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
