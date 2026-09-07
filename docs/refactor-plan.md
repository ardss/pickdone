# Refactor Plan: Two Architecture-Level Refactors (chartered 2026-08-31)

> This document records what, why, and current status only — implementation details evolve through discussion and get their own design docs before work starts.

## 1. Unified style system

**Problem**: after many rounds of CSS iteration, the project carries multiple sedimented style layers, two parallel token naming schemes, and some selectors defined twice — making style behavior unpredictable and small changes risky.

**Goal**: converge on a single `--color-*` token system with a layered utility/structure architecture; each component's styles owned by exactly one module file; dark-mode rules centralized; all legacy CSS files retired.

**Status**: tokenization and dark-mode centralization have landed on main (`base.css` token system + `theme-dark.css` central dark rules; radius/space/chart cssVars gridded). The component-absorption refactor (2026-09-07, commits up to b4dd6f5/2dbc6b1) retired `style-1~4.css` entirely: global CSS is now `base.css` + `theme-dark.css` only, with component rules living in SFC `<style>` blocks. Remaining on main: task-row density, three-screen adaptation, legacy token cleanup.

## 2. SFC migration

**Problem**: all 47 components are template strings inside JS files (legacy baggage) compiled at runtime; `eslint-plugin-vue` is completely ineffective on them, so template syntax errors and outdated patterns rely on manual sweeps — this has already caused 5 silent animation breakages that lurked for a week.

**Goal**: migrate to `.vue` single-file components with a Vite build layer on the renderer; retire the runtime compiler and CSP `'unsafe-eval'` (≈ -30% bundle size, hardening) and gain full static checking on templates.

**Status**: **not started**; the plan is final. Four phases, core discipline "infrastructure first, never skip steps":

1. **Phase 0 · Build infrastructure**: introduce the Vite build layer, retire vendor UMD scripts, unify Electron and the browser debug host. No component conversion in this phase; one committable, independently revertible step — this is the highest-risk step;
2. **Phase 1 · Bulk mechanical conversion**: a codemod moves all 47 component template strings into `.vue` files, one batch per day, each batch passing the full visual-regression gate;
3. **Phase 2 · Cutover**: retire the runtime compiler, tighten CSP, enable the full `eslint-plugin-vue` rule set;
4. **TS (optional)**: cover the store/utils layer with JSDoc + checkJs first; no push toward component-level TS.

Prerequisites: parallel refactors wrapped up, the style system finalized, and Phase 0 running stably for at least a week.

## Shared discipline

- Infrastructure before components; every batch passes the full visual-regression gate; every commit is independently revertible;
- No refactor work during active parallel-development windows or right before a release;
- The two refactors are ordered: a finalized style system is a prerequisite for SFC migration — the order must not be reversed.
