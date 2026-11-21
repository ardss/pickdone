/** Main-process entry point for text sanitization.
 *
 *  The implementation lives in shared/sanitize-text.mjs — the renderer imports the same module.
 *  This file used to carry a byte-identical CJS copy, and a test existed solely to prove the two
 *  copies stayed equal (a test that could only ever fail for the reason it existed). It is now a
 *  re-export; main requires .mjs elsewhere already (shared/machine-local-keys.mjs).
 */
module.exports = require('../../shared/sanitize-text.mjs')
