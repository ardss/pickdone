/* Pure helpers for scripts/verify-packaged.cjs (M-14, 2026-09-20) — extracted so the CLI
 * require-completeness scan can be unit-tested against a fixture tree without a packaged build.
 * Scan scope (all recursive, unlike the old single-level ./ scan):
 *   - every .js/.cjs file under the CLI tree
 *   - relative requires INSIDE the tree ('./x', './lib/y')
 *   - relative requires ESCAPING the tree ('../src/main/db.js') — mapped onto resources/ where
 *     the extraResources 'src/main' copy lives
 *   - bare lazy requires ('solarlunar', 'dayjs/locale/zh-cn') — mapped onto
 *     resources/node_modules/<spec> (extraResources node_modules entries)
 */
const fs = require('fs')
const path = require('path')
const BUILTIN_MODULES = new Set(require('module').builtinModules)

/** Node builtin (fs, path, node:child_process, …): packaged lookup does not apply. */
function isNodeBuiltin (spec) {
  return spec.startsWith('node:') || BUILTIN_MODULES.has(spec) || BUILTIN_MODULES.has(spec.replace(/^node:/, ''))
}

/** Dev/diagnostic CLI files that ship in extraResources but are not part of the operational CLI
 *  surface; their dev-only bare requires (acorn/typescript/pinyin-pro) must not fail the gate. */
const DEV_FILE_SKIP = /^(check-|a11y-|ui-smoke|e2e-|cli-smoke|env-clean)/

/** Recursive list of .js/.cjs files under dir (unreadable dir → []). */
function listJsFiles (dir) {
  const out = []
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...listJsFiles(p))
    else if (e.isFile() && /\.c?js$/.test(e.name)) out.push(p)
  }
  return out
}

/** All require('...') string-literal specifiers in a source string. */
function extractRequires (src) {
  return [...String(src || '').matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1])
}

/** Classify + map one require spec to the packaged location that must exist.
 *  Returns { scope: 'cli'|'resources'|'node_modules', rel } — rel is POSIX-separated,
 *  relative to resources/ for 'resources'/'node_modules' scopes and to the CLI root for 'cli'. */
function requiredPathFor (spec, fileDir, cliRoot, resourcesRoot) {
  if (spec.startsWith('./') || spec.startsWith('../')) {
    const abs = path.resolve(fileDir, spec)
    const relFromCli = path.relative(cliRoot, abs)
    if (relFromCli.startsWith('..')) {
      // escapes the CLI tree (e.g. ../src/main/db.js): the packaged copy lives under resources/
      return { scope: 'resources', rel: path.relative(resourcesRoot, abs).split(path.sep).join('/') }
    }
    return { scope: 'cli', rel: relFromCli.split(path.sep).join('/') }
  }
  return { scope: 'node_modules', rel: spec }
}

/** Candidate packaged paths (relative to resources/) one of which must exist. */
function candidatesFor (t) {
  const base = t.scope === 'cli' ? 'cli' : (t.scope === 'resources' ? '' : 'node_modules')
  if (t.scope === 'node_modules') {
    return ['node_modules/' + t.rel, 'node_modules/' + t.rel + '.js', 'node_modules/' + t.rel + '.json',
      'node_modules/' + t.rel + '/index.js', 'node_modules/' + t.rel + '/package.json']
  }
  return [base + (base ? '/' : '') + t.rel + '.js', base + (base ? '/' : '') + t.rel + '.cjs', base + (base ? '/' : '') + t.rel]
}

/**
 * Scan a CLI tree for require targets missing from the packaged resources layout.
 * read(file) → source string (injected so tests can use in-memory files).
 * Returns human-readable missing-target descriptions (empty array = all resolved).
 */
function findMissingRequires ({ cliDir, resourcesDir, read }) {
  const missing = []
  for (const file of listJsFiles(cliDir)) {
    if (DEV_FILE_SKIP.test(path.basename(file))) continue // dev/diagnostic files: dev-only bare requires out of scope
    const fileDir = path.dirname(file)
    for (const spec of extractRequires(read(file))) {
      if (isNodeBuiltin(spec)) continue
      const t = requiredPathFor(spec, fileDir, cliDir, resourcesDir)
      const ok = candidatesFor(t).some(c => {
        try { return fs.statSync(path.join(resourcesDir, c)).isFile() } catch { return false }
      })
      if (!ok) missing.push(`${t.scope === 'node_modules' ? 'resources/node_modules/' + t.rel : t.rel} (required by ${path.basename(file)}, spec "${spec}")`)
    }
  }
  return missing
}

module.exports = { listJsFiles, extractRequires, requiredPathFor, candidatesFor, findMissingRequires, isNodeBuiltin }
