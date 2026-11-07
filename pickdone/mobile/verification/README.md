# Mobile UI comparison at 375 × 812

The `before` images were captured from the initial mobile MVP (5adf0522) before changing `mobile/src`; the `after` images use the shared UI package. The capture script opens a fresh browser context and creates one sample project, task and work episode in that context's IndexedDB. No production data is read.

| Screen | Initial | Shared UI |
| --- | --- | --- |
| Today | [before/today-sample.png](before/today-sample.png) | [after/today-sample.png](after/today-sample.png) |
| Project | [before/projects-sample.png](before/projects-sample.png) | [after/projects-sample.png](after/projects-sample.png) |
| Work episode | [before/history-sample.png](before/history-sample.png) | [after/history-sample.png](after/history-sample.png) |
| Today empty | [before/today-empty.png](before/today-empty.png) | [after/today-empty.png](after/today-empty.png) |
| Project empty | [before/projects-empty.png](before/projects-empty.png) | [after/projects-empty.png](after/projects-empty.png) |

The initial screen uses a dark green action color and a text checkmark logo. The shared version uses the desktop `favicon.svg`, teal semantic tokens and shared Vue card/button/empty components. The bottom navigation remains fixed, and completion targets are at least 44 × 44 CSS pixels. The script checks those claims alongside 375px overflow and the actual `#0f9d8f` token.

Recreate with a local preview server, then `node tests/capture-ui.mjs after`. Images are local browser evidence, not Android device screenshots or claims of cross-client release readiness.