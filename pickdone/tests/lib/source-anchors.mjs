/**
 * Central registry of source files pinned by source-anchored (regex/static) tests.
 * Single source for the "read production source and assert on its shape" test class:
 * tests import ANCHORS instead of hand-writing '../../../src/...' literals, so a file
 * move is a one-line change here rather than a sweep across ~a dozen test files.
 * Existence of every registered anchor is itself guarded by tests/unit/w4-source-anchors.test.mjs.
 */
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Repo root = pickdone/ (this file lives at tests/lib/) */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export const ANCHORS = {
  /** Electron main process */
  mainIndex: 'src/main/index.js',
  mainDir: 'src/main',
  handlersTodo: 'src/main/handlers/todo.js',
  handlersBackup: 'src/main/handlers/backup.js',
  externalDbWatch: 'src/main/external-db-watch.js',
  preloadIndex: 'src/preload/index.js',
  installerNsh: 'build/installer.nsh',
  /** CLI */
  cliLib: 'cli/lib.js',
  /** Renderer (non-view) */
  rendererMain: 'renderer/js/main.js',
  /** Day-caliber single source (dayShift/dayStart/today0) + its enforcement scan root */
  todayBounds: 'renderer/js/utils/todayBounds.js',
  rendererJsDir: 'renderer/js',
  browserShim: 'browser-dev/todo-browser-shim.js',
  settingsStore: 'renderer/js/store/settings.js',
  /** Renderer views/components/i18n (anchored by contract/guard tests only) */
  onboardingVue: 'renderer/js/components/Onboarding.vue',
  recycleBinView: 'renderer/js/views/RecycleBinView.vue',
  i18nZhC: 'renderer/js/i18n/locales/zh-CN-C.js',
  i18nEnC: 'renderer/js/i18n/locales/en-US-C.js'
}

/** Resolve an anchor key to an absolute path (optionally against a custom base for tmp-dir tests) */
export function anchorPath (key, base = REPO_ROOT) {
  const rel = ANCHORS[key]
  if (!rel) throw new Error(`unknown source anchor: ${key}`)
  return path.join(base, rel)
}

/** Read an anchored source file as utf8 text */
export function readAnchor (key) {
  return fs.readFileSync(anchorPath(key), 'utf8')
}

/**
 * Ordered file-SET anchors (2026-10-24, GPT-adjudicated P1): one logical unit that spans
 * several files after a split (store + extracted pure module, facade + factory family...).
 * Before this registry, each consumer hand-built its own `read(a) + read(b)` concatenation
 * with ad-hoc separators and hand-written sibling paths — six call sites, six slightly
 * different shapes. Consumers now call readAnchorSet(key) and get ONE canonical joined text
 * (files in declared order, '\n'-separated — the explicit newline also kills the old bare-
 * concatenation hazard where the last char of file A could glue onto the first of file B).
 */
export const ANCHOR_SETS = {
  /** settings store + extracted DEFAULT_SETTINGS/keys-manifest module (split 2026-10-24) */
  settingsStoreFamily: ['renderer/js/store/settings.js', 'renderer/js/store/settings-schema.js'],
  /** tomato store + extracted pure helpers (split 2026-10-24) */
  tomatoStoreFamily: ['renderer/js/store/tomato.js', 'renderer/js/store/tomato-pure.js'],
  /** db recovery facade + restore family module (split 2026-10-24) */
  dbRecoveryFamily: ['src/main/dbRecovery.cjs', 'src/main/db-recovery-restore.cjs'],
  /** db DDL module + facade (split 2026-10-24; SCHEMA = require('./db-schema').SCHEMA + tail) */
  dbSchemaFamily: ['src/main/db-schema.js', 'src/main/db.js'],
  /** CLI entry + chips family module (split 2026-10-24) */
  cliChipsFamily: ['cli/lib.js', 'cli/lib-chips.cjs'],
  /** statistics csv helpers + the view that absorbs them */
  statisticsViewFamily: ['renderer/js/views/statistics/csv.js', 'renderer/js/views/StatisticsView.vue'],
  /** english + chinese E-wave locale bundles (media-language pairing scans read both) */
  i18nLocaleE: ['renderer/js/i18n/locales/en-US-E.js', 'renderer/js/i18n/locales/zh-CN-E.js']
}

/** Validate + resolve an ANCHOR_SETS key to absolute paths. Throws on: unknown key, empty
 * set, duplicate entries, non-repo-relative or path-escaping entries. */
export function anchorSetPaths (key, base = REPO_ROOT) {
  const set = ANCHOR_SETS[key]
  if (!set) {
    throw new Error(`unknown source anchor set: ${key} (known: ${Object.keys(ANCHOR_SETS).join(', ')})`)
  }
  if (!Array.isArray(set) || set.length === 0) {
    throw new Error(`source anchor set ${key} must be a non-empty array of repo-relative paths`)
  }
  const seen = new Set()
  return set.map(rel => {
    if (typeof rel !== 'string' || rel.length === 0) {
      throw new Error(`source anchor set ${key} contains a non-string/empty entry`)
    }
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
      throw new Error(`source anchor set ${key} entry must be repo-relative without '..' escapes: ${rel}`)
    }
    if (seen.has(rel)) {
      throw new Error(`source anchor set ${key} contains duplicate entry: ${rel}`)
    }
    seen.add(rel)
    return path.join(base, rel)
  })
}

/** Read an anchor SET as one canonical utf8 text: files in declared order, '\n'-joined. */
export function readAnchorSet (key) {
  return anchorSetPaths(key)
    .map(p => {
      if (!fs.existsSync(p)) {
        throw new Error(`source anchor set ${key} references a missing file: ${p} (did a split/move land without updating ANCHOR_SETS?)`)
      }
      return fs.readFileSync(p, 'utf8')
    })
    .join('\n')
}
