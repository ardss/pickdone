/**
 * JSON-LD metadata patch for the pickdone-site pages (index.html / en-index.html), used by
 * release-finalize.mjs. Extracted into a pure function so a regression test can pin the output
 * shape: the dateModified rewrite used to splice the bare JS expression text
 * `new Date().toISOString().slice(0, 10)` into the document (no quotes, never evaluated),
 * producing invalid JSON-LD that search engines could not parse. Both values are now
 * interpolated as quoted JSON strings; the caller passes today's date explicitly.
 */
export function patchJsonLd (html, version, date) {
  return html
    .replace(/"softwareVersion": "[^"]*"/, `"softwareVersion": "${version}"`)
    .replace(/"dateModified": "[^"]*"/, `"dateModified": "${date}"`)
}
