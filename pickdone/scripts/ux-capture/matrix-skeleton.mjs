#!/usr/bin/env node
/* eslint-env node */
/**
 * 6-group screenshot MATRIX skeleton — S3 handoff to Android/Web implementers.
 *
 * NOT runnable as-is for Android/Web: fill in `clients` adapters. The desktop
 * adapter is real (capture-desktop.mjs in this folder already produced
 * ux-evidence/desktop/). Android needs an adb screencap adapter; Web needs a
 * CDP adapter against a real browser instance.
 *
 * Matrix (MEGA-MISSION §05, normative):
 *   groups × clients × viewports × themes × states
 *
 * Naming convention (machine-parseable, REQUIRED):
 *   {NN}-{group}--{client}--{viewport}--{theme}--{state}.png
 *   e.g. 03-today--android--360x800dp--dark--empty.png
 *
 * Acceptance: see docs/design/ux-contract-20261110.md §7. Real pixels only;
 * CSS-variable equality is NOT acceptance.
 */
import fs from 'node:fs';
import path from 'node:path';

// ---- Matrix definition ------------------------------------------------
export const GROUPS = [
  { id: '01', name: 'today', desktopRoute: '#/todo-list/today' },
  { id: '02', name: 'projects', desktopRoute: '#/todo-list/projects' },
  { id: '03', name: 'task-detail', desktopRoute: '#/todo-list/today + EditPanel open' },
  { id: '04', name: 'episode-handoff', desktopRoute: 'project detail > work-handoff section' },
  { id: '05', name: 'sync-conflict', desktopRoute: 'Settings > Sync tab (+ seeded conflict)' },
  { id: '06', name: 'settings', desktopRoute: 'ui/toggleSettings modal' },
];

export const CLIENTS = [
  { id: 'desktop', viewports: ['1440x900@1'], adapter: './capture-desktop.mjs (real)' },
  { id: 'android', viewports: ['360x800dp@2.75', '390x844dp@3'], adapter: 'TODO Wave2: adb shell screencap' },
  { id: 'web', viewports: ['1440x900@1', '768x1024@1', '390x844@1'], adapter: 'TODO Wave2: CDP against real browser' },
];

export const THEMES = ['light', 'dark'];
export const STATES = ['default', 'pre-click', 'post-click', 'empty', 'loading', 'error', 'offline'];

export function planMatrix() {
  const cells = [];
  for (const g of GROUPS)
    for (const c of CLIENTS)
      for (const vp of c.viewports)
        for (const t of THEMES)
          for (const s of STATES)
            cells.push({ file: `${g.id}-${g.name}--${c.id}--${vp}--${t}--${s}.png`, group: g.name, client: c.id, viewport: vp, theme: t, state: s });
  return cells;
}

/**
 * Per-cell acceptance checklist (return array of {check, pass, evidence}).
 * Each implementer fills the `assert` callbacks with real pixel/DOM checks.
 * FORBIDDEN: returning pass=true because CSS custom properties match tokens.
 */
export function acceptanceChecks(cell, captures) {
  return [
    { check: 'real rendered pixels (screencap/CDP), not token diff', pass: null, evidence: captures.file },
    { check: 'viewport + theme + nav path + timestamp + build version in manifest', pass: null, evidence: '' },
    { check: 'pre/post click pair exists for interactive states', pass: null, evidence: cell.state.includes('click') ? captures.file : 'n/a' },
    { check: 'key text actually rendered at expected location (DOM text at real coords or OCR)', pass: null, evidence: '' },
    { check: 'empty/loading/error/offline states captured for this group', pass: null, evidence: '' },
    { check: 'cross-client consistency: same entities/wording/state colors; layout deltas justified in writing', pass: null, evidence: '' },
    { check: 'mobile: touch targets >=44dp; first screen has the 4 continuity zones (android only)', pass: null, evidence: '' },
  ];
}

// CLI: print the plan so implementers can diff against their output dir.
if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2] || null;
  const cells = planMatrix();
  if (out) fs.writeFileSync(path.resolve(out), JSON.stringify({ cells }, null, 2));
  console.log(`matrix plan: ${cells.length} cells (${GROUPS.length} groups x ${CLIENTS.length} clients x themes x states)`);
}
