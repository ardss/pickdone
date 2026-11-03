// PickDone capture extension — the delivery endpoint contract.
// Chrome-free pure ESM, loadable in the MV3 service worker and unit-tested in Node.
// MUST stay literally identical to src/main/capture-endpoint/contract.cjs — the contract
// test (tests/unit/main/capture-endpoint/contract.test.mjs) asserts exactly that.

export const CAPTURE_HOST = '127.0.0.1'
export const CAPTURE_PORT = 7789
export const CAPTURE_PATH = '/capture'
export const DEFAULT_CAPTURE_ENDPOINT = `http://${CAPTURE_HOST}:${CAPTURE_PORT}${CAPTURE_PATH}`
