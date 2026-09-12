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
  preloadIndex: 'src/preload/index.js',
  installerNsh: 'build/installer.nsh',
  /** CLI */
  cliLib: 'cli/lib.js',
  /** Renderer (non-view) */
  rendererMain: 'renderer/js/main.js',
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
