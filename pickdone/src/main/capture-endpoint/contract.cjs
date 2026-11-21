/**
 * capture-endpoint/contract — the ONE literal for the browser-extension delivery door.
 *
 * The extension's service worker posts to DEFAULT_CAPTURE_ENDPOINT; the desktop server binds
 * CAPTURE_HOST:CAPTURE_PORT and answers CAPTURE_PATH. A contract test asserts the extension's
 * own shared constant (extension/shared/endpoint-contract.js — the extension cannot import
 * this CJS file from its MV3 package) carries the SAME literal, so the two can never drift
 * apart again (QA defect: extension shipped `127.0.1:8741/api/capture` vs the real
 * `127.0.0.1:7789/capture`).
 */
const CAPTURE_HOST = '127.0.0.1'
const CAPTURE_PORT = 7789
const CAPTURE_PATH = '/capture'
const DEFAULT_CAPTURE_ENDPOINT = 'http://' + CAPTURE_HOST + ':' + CAPTURE_PORT + CAPTURE_PATH

module.exports = { CAPTURE_HOST, CAPTURE_PORT, CAPTURE_PATH, DEFAULT_CAPTURE_ENDPOINT }
