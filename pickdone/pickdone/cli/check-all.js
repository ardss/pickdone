#!/usr/bin/env node
/**
 * Path-robust delegation shim (2026-09-23): external gate runners have been observed invoking
 * `node pickdone/cli/check-all.js` while their shell cwd is ALREADY inside pickdone/, which makes
 * Node resolve pickdone/pickdone/cli/check-all.js and die with MODULE_NOT_FOUND before any check
 * runs. This file makes that doubled path resolve to the real entry. The real module's __dirname
 * is unchanged (Node resolves the required file's own path), so all internal cli/ references keep
 * working.
 * Usage: node cli/check-all.js [--a11y] [--fast] — see cli/check-all.js for flags.
 */
// The real entry uses top-level await (async ESM-flavoured .js), so it must be import()ed, not
// require()d; its non-zero exit signalling happens via process.exitCode/exit inside the module.
import('../../cli/check-all.js').catch(err => { console.error(err); process.exit(1) })
