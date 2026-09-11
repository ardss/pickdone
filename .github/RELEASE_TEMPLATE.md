<!-- Release notes template: after the release pipeline produces the Draft, paste this into the Release body and fill in the version number and highlights -->
<!-- Maintenance rule: every release must fill in "Installation notes" and "Known issues"; the body must not expose implementation details (redaction red line) -->

## PickDone vX.Y.Z

<!-- Highlights: 2-4 items, framed as user value; no implementation vocabulary (refactor/gates/IPC etc. are internal words) -->
### Highlights
- 

### Installation notes (Windows)
- The installer in this release is **not code-signed**, so Windows SmartScreen may show "Windows protected your PC" on first run.
  Click "More info" → "Run anyway" to install normally. Existing users updating in-app are not affected.
- The portable build extracts and runs as-is; the same SmartScreen prompt may appear.

### Known issues
- (verify item by item before publishing; write "None" if empty)

### Feedback
- Please report issues on GitHub Issues, including the version shown in Settings → About.
