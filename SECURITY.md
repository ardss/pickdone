# Security Policy

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public issues.**

Report privately via [Security Advisories](https://github.com/ardss/pickdone/security/advisories/new). You can expect a response within 7 days.

When reporting, please include affected versions, reproduction steps, and an impact assessment. For issues involving local data (`todos.db` encryption, backups, key storage), please state explicitly whether data could be read by another application.

## Security model

PickDone is a local-first, offline-first app:

- Task data is stored in SQLite under `%APPDATA%`, encrypted with a SQLCipher-family cipher (the key is stored in the same directory) — the threat model protects against a copied/forensically-inspected single file, not a local attacker who can read the entire user profile
- Weather is the only optional network feature and is off by default
- In-app updates go through GitHub Releases (HTTPS + electron-builder signature verification)

Before reporting, you may also want to read [NOTICE.md](NOTICE.md) and the encryption notes in `src/main/db.js`.
