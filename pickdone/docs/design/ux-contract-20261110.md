# PickDone UX Contract — 2026-11-10 (S3, Wave 1)

Owner: Dev-3 (DESIGN line). Branch: `lr/ux-20261110`.
Status: CODE_READY (desktop baseline captured; Android/Web implementation deferred to Wave 2).

**Baseline rule (from MEGA-MISSION §05):** the user-approved desktop app is the single UX
baseline. Android and Web must be "the same product, different layouts" — never a redesign
from a color palette. This document derives the contract FROM the real desktop build
(v0.4.0-beta.29-ui2, captured 2026-11-10 in an isolated instance). The screenshot set in
`ux-evidence/desktop/` is the only visual reference; where this document and the screenshots
disagree, the screenshots win.

Evidence set (all 1440x900 dpr=1, light+dark, real `Page.captureScreenshot` pixels via CDP,
manifest with viewport/theme/nav-path/timestamp per file: `ux-evidence/desktop/manifest.json`):

| File | Screen |
|---|---|
| 01-today | Today (timeline + day strip + pomodoro bar) |
| 02-todox | TodayX push/planning view |
| 03-inbox-todobox | Inbox / TodoBox (capture inbox) |
| 04-projects | Projects overview (first-class nav) |
| 05-project-detail | Project detail incl. Work-handoff section, list/board/timeline switcher |
| 06-statistics | Statistics / data dashboard |
| 07-completed | Completed / archive |
| 08-settings | Settings modal (left tab rail: General/Appearance/Calendar/Shortcuts/Pomodoro/Sync/Capture/Data/Feedback) |
| 09-settings-sync | Settings > Sync & Devices (LAN sync toggle, device name) |
| 10-empty-recycle-bin | Empty state (Recycle Bin) |

---

## 1. Design tokens — current state (extracted, not invented)

Source of truth: `assets/css/base.css` `:root` (light) and `assets/css/theme-dark.css`
`html[data-theme="dark"]` overrides. These gates already exist and MUST keep passing:
`npm run check:tokens`, `npm run check:css-freeze`.

### 1.1 Color

| Token | Light | Dark | Semantic |
|---|---|---|---|
| `--brand` | `#0f9d8f` | same | brand fill / icons / borders (never text on white) |
| `--brand-dark` | `#0c8172` | same | brand emphasis |
| `--brand-text` | `#0a6f62` | same | brand as TEXT (5.5:1 on white, 4.6:1 on tinted bg) |
| `--brand-hover` / `--brand-active` | `#0a6f62` / `#085d53` | same | interactive states |
| `--brand-light` | `#e2f4f1` | `#143430` | tinted surface |
| `--brand-focus-ring` | `rgba(15,157,143,.18)` | same | focus outline halo |
| `--brand-contrast` | `#ffffff` | `#ffffff` | text/icon ON brand fill |
| `--text-1..4` | `#303133` `#606266` `#6d7278` `#c0c4cc` | `#e8eaed` `#b8bdc7` `#8b919c` (4 unset — fall back to light values, a known gap) | primary / secondary / tertiary (4.85:1 AA) / placeholder-disabled |
| `--line`, `--line-strong` | `#f3f3f3`, `#e4e7ed` | `#2a2f38` (strong falls back to light) | hairlines, control borders |
| `--bg` | `#ffffff` | `#17191e` | page |
| `--panel` | `#ffffff` | `#1c1f26` | cards, popovers |
| `--gray-bg` | `#f8f8f8` | `#22262e` | recessed surface |
| `--hover-bg` / `--active-bg` | `#fbfbfb` / `#f6f6f6` | `#262b34` / `#20242c` | list row states |
| `--danger` / `--danger-strong` / `--danger-soft` | `#f56c6c` / `#d9534f` / `#fef0f0` | falls back to light (gap) | destructive |
| `--ok` / `--warn` | `#67c23a` / `#e6a23c` | falls back to light (gap) | success / warning |
| `--tomato-bg` | `#ebf2f3` | `#1d2b2d` | pomodoro bar surface |
| `--tt-*` accent set | work=brand-dark, rest=`#fe9933`, reached=`#1f7a33`, open=`#0a6f62` | same | tomato-bar status (contrast-fixed set) |

Theme mechanism: `html[data-theme="dark"]` attribute + persisted `colorMode` setting.
Dark theme is an OVERRIDE layer of ~15 core tokens plus explicit component rules in
`theme-dark.css` (365 lines); anything not overridden silently stays light — this is the
documented drift risk Android/Web must not inherit (Wave 2 rule: every surface resolves via
token, never via hardcoded light value).

### 1.2 Geometry, spacing, elevation, motion, z-scale

- Radius: `--radius-xs 2 / sm 4 / md 8 / lg 10 / xl 14 / pill 999`.
- Spacing grid: 4px base — `--space-1..5` = 4/8/12/16/20.
- Type scale (exactly six steps, nothing larger tokenized):
  `--fs-2xs 10 / xs 11 / sm 12 / md 13 / base 14 / lg 15` px. >=20px is display-number
  territory (stats cards), intentionally untokenized.
- Opacity (reveal tiers): `--opacity-dim .45 / muted .6 / hover .75`.
- Shadow: single elevation token `--shadow-pop: 0 8px 28px rgba(0,0,0,.14)` for all floating
  layers. No multi-level elevation system exists yet (gap G-8).
- Motion: `--dur-fast .15s` (hover/reveal), `--dur-mid .25s` (movement/expand),
  `--dur-slow .35s` (large transitions). Legacy `--t-fast/base/slow .15/.2/.3` still present.
- Layout constants: `--sidebar-w: 250px` (desktop side nav), `--panel-w: 360px` (right edit
  drawer), custom window titlebar (`--z-titlebar: 2000`).
- Z-index scale is FROZEN and documented in `:root` (row 3 → float 6-11 → list-pop 60 → pop
  600/700 → tomato 900 → panel 800 → modal 1500 → titlebar 2000 → notify 3000 → overlay 3500
  → viewmenu 4500 → ctxmenu 5000 → fc-popover 6000 → lock 9999). Cross-client ports MUST
  keep relative order, not raw values.

## 2. Information architecture and navigation adaptation

### 2.1 Desktop IA (captured)

Primary nav = persistent left sidebar (250px): Search, Today (`今日待办`), Calendar
(`日程概览`), Inbox/TodoBox (`待办箱`), Completed (`已达成`), Statistics (`数据复盘`),
Projects (`项目`, first-class since afeae379); then category groups (with color dots),
Filters, Tags; footer: account chip + sync + recycle + settings gear.

Route map (`renderer/js/router.js`, hash router): `/todo-list/today|today-x|todo-box|
statistics|search|calendar|completed|recycle-bin|projects|project/:id|category/:id|
tag/:id|all-tags|filter/:id|habit`; aux windows `/__tomato-float`, `/__quick-add`.
Unknown hash redirects to `/todo-list/today` (never a blank main area).

Module mapping to §05's canonical modules:

| §05 module | Desktop surface | Notes |
|---|---|---|
| Today | TodayView + TodayXView | two modes of the same day plane |
| Inbox (capture) | TodoBoxView + QuickAdd (global hotkey + `试速` command bar) | capture-first |
| Projects | ProjectOverviewView + ProjectView (tabs: Overview / Docs; handoff section, milestone track, list/board/timeline) | first-class |
| Work Continuity | ProjectHandoff section inside ProjectView + Tomato focus records | Episode/decision/handoff history renders per project |
| Activity & Source | StatisticsView + CompletedView | aggregates; per-task SourceRef/account modal (`TaskAccountModal`) |
| Sync & Devices | Settings > 同步 tab (LAN sync toggle, device name) | device pairing UI lives here |
| Settings | Settings modal, left tab rail (General/Appearance/Calendar/Shortcuts/Pomodoro/Sync/Capture/Data Management/Feedback & About) | modal, not a page |

### 2.2 Adaptation rules (contract for Wave 2)

1. Same seven modules, same order of priority: capture → today → continuity. Android:
   bottom navigation with the five highest-frequency destinations (Today, Inbox, Projects,
   Continuity, More). "More" holds Calendar/Completed/Statistics/Settings. Web >=1024px:
   keep the desktop sidebar; 768-1024px: collapsible icon-only sidebar (72px); <768px:
   bottom navigation, same as Android. Desktop keeps the dense sidebar unchanged — this
   contract does not touch mature desktop features.
2. Route names are the cross-client identity: every screen maps 1:1 to a hash route name
   (`todo-list-today`, `todo-list-projects`, ...). Android/Web deep links must resolve to
   the same logical names so J3 (capture → open on another end) works.
3. The right edit drawer (`--panel-w 360px`) becomes a bottom sheet on mobile and a modal
   on narrow web. Content semantics (title, date, project, tags, notes, continuity records)
   are identical.
4. Settings stays a modal on desktop; on Android it is a screen reached from "More"; on web
   it follows the viewport rule in (1).

## 3. §05 design-contract items — current vs target

| Item | Current (desktop, captured) | Target (contract) | Gap class |
|---|---|---|---|
| Visual hierarchy | Brand teal as the only accent; text 4-step gray ramp; 6-step type scale | Keep; document per-screen heading order in matrix checklist | small |
| Information density | Dense desktop: 250px sidebar, hour-rail timeline, multi-column day strip | Mobile uses single column, one primary action per screen; web reflows at 2 breakpoints | adaptation |
| Content alignment | Left-aligned lists, right-aligned meta (dates, counts), consistent 4px grid | Same rules cross-client | none |
| State components | Checkbox `.td-check`, badges `WinBindBadge`, tomato status bar, toggle switches | Extract to primitives (Wave 2) | primitives missing |
| Blank pages | `EmptyState` component (icon + text + optional action slot, e.g. `去新建任务`) | Reuse as shared primitive; every empty list MUST render it | extraction |
| Icons | `AppIcon.js` inline SVG registry | Shared icon set must be a build artifact, not per-client copies | extraction |
| Menus | Context menu (right-click, `--z-ctxmenu`), ViewMoreMenu, settings tab rail | Mobile: long-press = same menu content; document per-screen menu entries in matrix | adaptation |
| Touch targets | Mouse-oriented; no enforced minimum; small close-x buttons exist | ALL interactive targets >=44x44dp mobile / >=24px desktop with 44dp hit-slop on mobile; audit in matrix checklist | NEW requirement |
| Motion | Three duration tokens, no choreography system | Keep three tokens; transitions only on opacity/transform; respect `prefers-reduced-motion` | small |
| Light/dark theme | `data-theme="dark"` override layer; known fallback gaps (text-4, line-strong, danger/ok/warn unset in dark) | Dark must define EVERY core token; close gaps listed in §1.1 before Wave 2 ports | fix in desktop tokens first |
| Internationalization | vue-i18n legacy mode, zh-CN + en-US locales, `check:i18n` gate, locale switchable in Settings | All new screens ship both locales in the same PR; i18n gate extends to Android/Web string tables | gate exists |
| Accessibility | Partial: aria-labels on nav/gear, aria-pressed on tab-like buttons (tab roles were deliberately downgraded to honest button groups), brand-text contrast fixes (5.5:1), focus ring token | WCAG 2.1 AA: visible focus on all interactives, keyboard-complete desktop flows, screen-reader labels on all icon-only buttons, contrast >=4.5:1 text | NEW requirement |
| Primitives + tokens + semantics | Tokens exist and are gate-enforced (`check:tokens`, `check:css-freeze`); NO shared component library — renderer components are Vue SFCs under `renderer/js/components`, shared logic lives in `shared/*.mjs` (non-UI) | Establish `shared/ui` token contract + primitive specs (see §4); clients may implement natively but MUST consume the same token values and content semantics | the core Wave 1→2 handoff |

## 4. Mobile first screen (§05 requirement, normative)

The mobile home screen is a WORK CONTINUITY cockpit, not a generic "organize your day"
todo list. Four zones, in order, each collapsible when empty except zone 1:

1. **Push now (待推进)** — tasks the user committed to advancing today (today queue +
   today-x push results). Max 5 visible, "show all" → Today. Each row: title, project dot,
   next action if any, one-tap complete.
2. **Waiting on me (待我接手)** — tasks with a Handoff addressed to this user/device that
   have no ack yet (from the Work-Continuity Episode/Handoff model, S1 DTOs). Row shows
   previous agent/human, one-line summary, [Take over] action. Deep-links to task detail.
3. **Agent working (Agent 处理中)** — tasks with a live agent episode (started, not
   finished). Row shows agent identity (per S1 role audit), started-at, and a passive
   progress note; tapping opens the episode timeline read-only.
4. **Blocked / conflict (阻塞冲突) + next step** — sync conflicts, revoked tokens, failed
   captures, source-invalid findings. Each row names the blocker in one sentence and offers
   exactly one next-step action (e.g. [Resolve conflict], [Re-authenticate]). Zero items
   here must render an explicit "no blockers, sync healthy" confirmation line with last
   sync time — silence is not allowed.

Rules: zone order fixed; a zone with zero items collapses to its header; the screen must
render within 2s cold on a mid-range Android device; every zone row is a touch target
>=48dp; pull-to-refresh refreshes all four zones in one pass.

## 5. Empty / loading / error / offline states (normative)

| State | Contract |
|---|---|
| Empty list | `EmptyState` primitive: icon + one sentence + optional single action. Wording states what IS empty ("该暂时没有日程"), never blames the user. |
| Loading | Skeleton of the target layout (no spinners for >300ms waits); first paint of any screen must not exceed 1.5s on desktop baseline hardware. |
| Error | Inline, adjacent to the failed action, with a retry button; destructive failures use `--danger`; errors are never silent and never fake success (J5 rule). |
| Offline | Banner pinned under the titlebar (mobile: top, web: top) reading "offline — changes are local, will sync"; queued-write indicator on affected rows; sync state from the same store desktop uses (Settings > Sync tab fields). |
| Conflict | Row in zone 4 of the mobile first screen + dedicated conflict sheet: both versions side by side, timestamps, [Keep mine] [Keep theirs] [Keep both]. |

No state may be represented by a blank main area (route catch-all already redirects
unknown hashes — replicate on all clients).

## 6. shared/ui inventory (read-only audit) and gap table

Finding: **`shared/ui` does not exist today.** `shared/` contains only non-UI logic modules
(sync-core, sync-crypto, sync-transport, date/sort/filter/repeat cores, settings-manifest,
format-mmss, sanitize-text, ...). Desktop UI = Vue SFCs (`renderer/js/`) styled by global
CSS (`assets/css/base.css` 2298 lines + `theme-dark.css` 365 lines), gates: `check:tokens`,
`check:css-freeze`, `check:i18n`.

| Layer | shared/ui target (Wave 2) | Desktop counterpart today | Gap |
|---|---|---|---|
| Theme tokens | `shared/ui/tokens.json` (single machine-readable source) | CSS custom properties in `assets/css/base.css` `:root` | desktop is authoritative; needs extraction + dark-gap fixes (§1.1) |
| Color primitives | semantic color roles resolved per platform | `--brand/-text/-light`, `--text-1..4`, `--danger/-soft`, `--ok`, `--warn`, surfaces | dark fallback gaps; name normalization |
| Type / space / radius / motion scales | same six-step, 4px grid, three durations | present (§1.2) | none — port values verbatim |
| Z/order scale | relative layer order contract | frozen 16-step z-scale | port order, not values |
| Icon primitive | named SVG set | `AppIcon.js` registry | move to shared build artifact |
| EmptyState | primitive spec (§5) | `EmptyState.vue` | spec already matches; document props |
| Checkbox/toggle/badge | primitive specs | `.td-check`, EP toggles, `WinBindBadge.vue` | extract specs, do not move desktop code (frozen) |
| Edit drawer / bottom sheet | responsive container contract | `EditPanel.vue` (360px drawer) | mobile/web re-implement to contract §2.2-3 |
| Settings tab rail | content semantics (setting keys from `shared/settings-manifest.mjs`) | `SettingsModal.vue` + `settings/*Tab.vue` | manifest already shared — extend to clients |
| Continuity rendering | Episode/Handoff/Decision/SourceRef display semantics (S1 DTOs) | `ProjectHandoff.vue` + project tabs | spec display contract; screenshot 05 is the reference |
| Sync & Devices UI | pairing/status state machine | `SettingsSyncTab.vue` + `sync-tab-helpers.js` | Android/Web implement same states |

Rule (unchanged from mission §07): Dev-3 alone edits shared/ui; Wave 2 client lines consume
frozen contracts. This batch changed nothing in `shared/` or desktop sources.

## 7. Screenshot matrix contract (for Android/Web implementers)

See `scripts/ux-capture/` — `capture-desktop.mjs` (runnable today, produced
`ux-evidence/desktop/`) and `matrix-skeleton.mjs` (skeleton for the 6-group × device ×
theme matrix). Six groups required by §05: Today, Projects, Task detail, Episode/Handoff,
Sync/Conflict, Settings. Each group: desktop 1440x900 + Android 360x800dp & 390x844dp +
web 1440/768/390, light+dark, plus pre/post-click and empty/loading/error/offline states.

Hard acceptance rules (no pseudo-acceptance):
1. Real pixels only: screenshots from a real renderer (`Page.captureScreenshot` / adb
   screencap / browser screenshot). A CSS-variable-diff or token-diff "equal" claim is NOT
   acceptance evidence.
2. Every matrix cell ships: viewport, theme, nav path (clickable steps, not just URL),
   timestamp, app/build version.
3. Pixel assertions on key results: e.g. task title string actually rendered (OCR or DOM
   text at real coordinates), checkbox state flip visible between pre/post click captures,
   zone-4 blocker row present on mobile first screen when a conflict is seeded.
4. Click-path assertions: the evidence must show before AND after for each interaction step.
5. State coverage: empty, loading, error, offline captured per group, not just the happy path.
6. "Same product, different layout" check per group: same entities, same wording (i18n
   keys), same state colors across clients; layout differences must be justified in writing.

## 8. BLOCKED / limitations (honest)

- Historical "Chrome exit 21" toolchain failure did NOT apply here: capture ran through the
  app's own Electron (CDP `--remote-debugging-port=9333` + `Page.captureScreenshot`), no
  external Chrome needed. Nothing BLOCKED in this batch.
- Work Continuity screens captured on an empty seeded project, so Episode/Handoff lists show
  their empty states; populated-state captures require an S1 journey and belong to the Wave 2
  matrix runs.
- Android/Web cells of the matrix are intentionally absent (Wave 2 scope).
