# G2 Screenshot Matrix — Web Leg vs Desktop Leg Diff Notes

Desktop reference: `.wt-lr-ux-20261110/ux-evidence/desktop/` (Electron app, 1440x900, read-only).
Web leg: `web-evidence/matrix/` (PWA, 1280x800 + 360x800, light+dark, default+empty/error states).
Per-group: justified adaptation differences first; unjustified breaks are listed as FAIL.

## G1 Today (`01-today--web--*` vs `01-today--desktop-*`)

- ADAPTATION (responsive reflow): desktop Today is a dense day column inside a week-strip
  calendar with a persistent left module rail (今日待办/日程概览/待办箱/已达成/数据复盘/项目).
  The web leg renders the same entities (task title, project label, done state) as a
  single-column card list with a hero progress ring; at 360px everything stacks into one
  column and the sidebar collapses to a 44px icon row. Justified: viewport-driven reflow,
  no entity or state loss.
- ADAPTATION (quick capture): desktop captures tasks through a global search/command bar;
  web exposes an inline quick-add form pinned above the list. Same wording pattern
  (写下今天要完成的事…), same add outcome.
- FAIL (density/accent): web cards carry a green/olive accent palette (`#c3ef91` brand mark,
  `#2f4935` primary buttons, green check fill) while the desktop leg uses brand TEAL as the
  only accent (ux-contract §Visual hierarchy). This is color drift, not a viewport necessity —
  needs token alignment or an explicitly documented per-client brand exception.

## G2 Projects (`02-projects--web--*` vs `04-projects--desktop-*`)

- ADAPTATION (surface): desktop manages projects inside the 分类 rail of the main window;
  web gives projects a dedicated two-pane page (list + project space) because the PWA has no
  persistent category rail. Entity parity holds (project name, task count, tasks inside).
- ADAPTATION (reflow): the two-pane grid (`330px | 1fr`) collapses to one column at <=850px;
  project detail moves under the list. Verified in 360px cells.
- FAIL (same accent drift as G1: project color dot and hover states are green on web, teal
  on desktop).

## G3 Task detail (`03-task-detail--web--*`)

- ADAPTATION (surface): desktop edits in a docked EditPanel; web opens a centered modal
  (`编辑任务`) over the dimmed list. Fields are the same subset (title, description, project,
  schedule date).
- ADAPTATION (deep link): the web modal is reachable via `#/task/<id>` sharing desktop task
  ids; unknown ids render an explicit 未找到该任务 error instead of a blank main area
  (contract blank-page rule). Desktop has no hash deep-link equivalent — additive web
  capability, no parity loss.
- Density note: modal max width `min(520px, 100%)` keeps single-column fields at 360px;
  no truncation or overlap observed in the captured cells.

## G4 Episode-Handoff (`04-episode-handoff--web--*`)

- NOTE (peer pending): the desktop leg has no episode/handoff capture in
  `ux-evidence/desktop/` (contract: populated work-continuity captures are Wave 2), so
  cross-client pixel comparison for this group is deferred; wording parity was checked
  against the contract wording rules instead.
- ADAPTATION (data shape): the CLI gates (`work <id> add-episode`, `work <id> add-source`)
  store goal/outcome/next as the episode note and provenance in `source_refs` — there are no
  separate Finding/Decision entities in this build. The web Work Journal renders the note
  verbatim (goal:/outcome:/nextAction: lines visible on the card), so the handoff content is
  user-visible without inventing new entities.
- ADAPTATION (layout): episode form + feed grid collapses to one column at <=850px.

## G5 Sync-Conflict (`05-sync-conflict--web--*` vs `09-settings-sync--desktop-*`)

- ADAPTATION (surface): desktop exposes LAN sync as a toggle + device name inside the
  settings modal 同步 tab. The web leg implements the controlled-pairing flow itself
  (endpoint + one-shot challenge JSON, pull/push buttons) on a dedicated 同步 page — a
  subset rescope justified by the browser security model (no LAN discovery, loopback
  pairing only).
- ADAPTATION (conflict surfacing): conflicts that the desktop surfaces inside its sync
  settings are rendered inline on the web sync page as a list with explicit verdicts; the
  captured cells show a real roundtrip (`Conflict seed task … · conflict_tombstone_wins`)
  produced by an offline web edit vs a desktop-side sqlite tombstone.
- FAIL (mapping gap, data not pixels): desktop stores `scheduledDay` as day-start epoch ms;
  the web contract field is the `yyyymmdd` day key. A raw bridge pull leaves desktop-scheduled
  tasks off the web Today list; the capture pipeline had to normalize ms->yyyymmdd in the
  decrypted copy (same conversion the desktop UI applies at render time). This unit mismatch
  belongs in the sync DTO layer, not in a capture hack.

## G6 Settings (`06-settings--web--*` vs `08/09-settings--desktop-*`)

- ADAPTATION (scope): the desktop settings modal has nine tabs (通用/外观/日历/快捷键/
  番茄钟/同步/采集/数据管理/反馈与关于). The Web Edition deliberately exposes only the
  subset that makes sense in a browser: theme toggle (topbar, light/dark verified by
  sampled pixels) and the 备份与恢复 data-portability panel. Recorded as a scope
  adaptation, not a defect — but it means settings parity is partial by design.
- ADAPTATION (theme mechanism): desktop toggles appearance inside 外观 settings; web keeps a
  one-click topbar toggle persisted via `data-theme` + localStorage.
- FAIL (navigation break): the 备份与恢复 entry lives in `.side-bottom`, which the <=850px
  layout hides entirely — on the 360px viewport the panel is reachable ONLY via deep link
  `#/backup`, not by any on-screen control. A primary surface with no touch entry point is
  a real usability break; needs a visible mobile entry (or bottom-nav placement in a
  follow-up).

## Cross-group notes

- Web uses an icon sidebar (collapsing 250px -> 75px rail -> 44px top icon row); there is NO
  bottom navigation at 360px, unlike the Android leg plan (bottom tab bar). Reasonable for
  browser PWA, but the touch-target rule is now enforced: all sidebar buttons, task check
  controls and row actions measure >=44x44 rendered px at 360px (see assertions.log; the
  44px floor was added in this G2 pass in `web/src/style.css`).
- Dark theme: both legs ship real dark variants; web dark background sampled at
  rgb(23, 25, 30) vs light rgb(247, 246, 242) from the screenshot bytes themselves.
- Empty/error states: every group renders a real EmptyState or explicit error; no blank
  main areas anywhere in the 48 captured cells.
