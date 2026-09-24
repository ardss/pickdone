/**
 * CSV import engine — RE-EXPORT SHIM (D3 2026-09-24).
 * The engine moved verbatim to src/main/import/index.js so the main process
 * (src/main/import-worker.js) stops reaching back into cli/ — dependency direction is now
 * cli → src/main. This shim keeps the historical require path working unchanged for the
 * 6 test files and the CLI entry that still point here; module.exports IS the engine module
 * (same object identity), so every named export behaves exactly as before. The h7-1 source
 * assertion greps the engine body directly (src/main/import/index.js) — no pinned literal
 * needs to live in this shim.
 */
module.exports = require('../src/main/import/index.js')
