# Vendor native driver: `better-sqlite3-multiple-ciphers` — risk & rebuild runbook

R9 nightly (2026-10-10, CTO sweep): this module is the single highest vendor risk in the
project — the app's entire data layer and the headless CLI both depend on it, it is
vendored (not a registry dependency), and it carries a native ABI contract with Electron.

## Why it is vendored, and where it lives

- Source of truth: `pickdone/vendor/better-sqlite3-multiple-ciphers/` (v13.0.3,
  upstream: https://github.com/m4heshd/better-sqlite3-multiple-ciphers).
- Ships N-API prebuilds for 8 targets (`prebuilds/*.node`: win32/darwin/linux ×
  x64/arm64 + linuxmusl × x64/arm64) — no compilation on user machines, ever.
- Packaged layout (see `src/main/db.js` `loadDriver()`): the driver is NOT in app.asar;
  it ships once via `extraResources` → `resources/vendor/…`, and BOTH the app and the
  bundled CLI resolve that same copy (one authoritative driver per package).
- Dev/CLI fallback: repo-relative `vendor/better-sqlite3-multiple-ciphers` (plain node).

## Upgrade / rebuild procedure

1. Check upstream releases + the Electron ABI note: the prebuilds are N-API (stable
   across Electron majors), so an Electron upgrade usually needs NOTHING here — verify
   by running the unit suite, which loads the driver through the same `loadDriver()`
   path (`node --test tests/unit/main/` — any ABI break fails at require time).
2. To bump versions: replace the vendored dir from the upstream release artifact
   (keep `prebuilds/` complete — all 8 targets, or the packaging step silently ships a
   driver other platforms cannot load).
3. After any vendor change, run on EVERY platform you can reach before tagging:
   - `npm run check:all` (unit suite includes driver-load + encryption ATTACH paths)
   - the real-device SSH drill (see docs/lan-sync-live-drill.md) exercises the CLI on
     a second machine — the CLI resolves the vendor copy through its own relative
     require, which is exactly the path that breaks first.
4. Rebuild-from-source (only if a target prebuild is missing/does not load):
   `npm rebuild` inside the vendored dir against the matching Node ABI; the produced
   `.node` must be placed back into `prebuilds/` and committed. Windows needs the
   VS Build Tools; keep upstream's prebuilds as the default and treat source builds
   as a last resort (they diverge silently from upstream bytes).

## Failure signatures (seen in real incidents)

- `ERR_DLOPEN_FAILED` at boot / CLI start = ABI mismatch or missing prebuild target —
  check `process.arch`/`process.platform` against `prebuilds/` contents first.
- App boots but CLI fails (or vice versa) = the two resolvers diverged (asar pruning vs
  extraResources vs repo-relative) — that class is exactly what the shared
  `resources/vendor` layout (db.js `loadDriver()`) was built to end; do not reintroduce
  a second resolution path.
- `ATTACH DATABASE ... KEY` failures after an upgrade = cipher/name change upstream;
  the encryption key file (`db.key`) does not change, but the default cipher might —
  pin the cipher explicitly rather than relying on upstream defaults.

## Red lines

- Never add `better-sqlite3-multiple-ciphers` to package.json dependencies as a
  registry install alongside the vendor copy — two drivers in one package is the bug
  class this layout exists to prevent.
- Never commit a partial `prebuilds/` set; CI is x64-only today and would not catch a
  missing arm64 target until a user's machine fails.
