# PickDone VS Code extension (MVP)

Talks to the local PickDone desktop app through the same loopback capture door the browser
extension uses (`http://127.0.0.1:7789`, `X-PickDone-Key` handshake, kill switch honored).
Nothing is sent anywhere except the loopback door.

## Commands

- **PickDone: Set Access Key** — paste the key from PickDone Settings → Capture endpoint.
  Stored in VS Code SecretStorage only (never settings.json).
- **PickDone: Revoke Access Key** — deletes the stored key; every command refuses afterwards.
- **PickDone: List Tasks** — quick-pick open tasks; picking one opens its handoff.
- **PickDone: List Projects** — quick-pick projects and their open task counts.
- **PickDone: Link Current File/Commit to Task** — links the active file (repo-relative path +
  `git rev-parse HEAD` sha) to a task as a `vscode` SourceRef. **File contents are never sent.**
- **PickDone: Show Task Handoff** — opens the task's WorkEpisode handoff markdown.

## Pairing (fail closed)

Without a stored key every command refuses. A wrong key answers 401; a disabled door answers
503 — both surface as errors, never as silent writes.

## Packaging

```
npx @vscode/vsce package --no-dependencies
```

produces `pickdone-vscode-0.1.0.vsix` (install: `code --install-extension <file>`).
