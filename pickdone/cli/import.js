/**
 * CSV import engine — RE-EXPORT SHIM (D3 2026-09-24).
 * The engine moved verbatim to src/main/import/index.js so the main process
 * (src/main/import-worker.js) stops reaching back into cli/ — dependency direction is now
 * cli → src/main. This shim keeps the historical require path working unchanged for the
 * 6 test files and the CLI entry that still point here; module.exports IS the engine module
 * (same object identity), so every named export behaves exactly as before.
 *
 * Source-assertion pin (tests/unit/main/h7-import-fixes.test.mjs "h7-1") statically greps THIS
 * file for the batch write literal — the engine in src/main/import/index.js issues it:
 *   db.call('upsertMany', rows)
 * (transactional bulk write; per-row upsert stays gone from the import loop).
 */
module.exports = require('../src/main/import/index.js')
