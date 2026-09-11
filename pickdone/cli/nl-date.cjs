/**
 * CLI natural-language date parsing — thin shell over the shared core
 * (shared/nl-date-core.mjs, architecture review item 5). The Chinese rule set
 * lives in the core, shared verbatim with renderer/js/utils/nlDate.js; the
 * renderer additionally carries the English NL branch there.
 * The CLI pins the Chinese full-date label format; renderer passes its
 * locale-aware FMT.cnFull per call.
 * The core is dependency-free ESM loaded via require(esm) (Node >= 22.12);
 * this shell owns the dayjs default base and its isoWeek plugin extension.
 */
const dayjs = require('dayjs')
try { dayjs.extend(require('../assets/vendor-lib/dayjs-plugin-isoWeek.js')) } catch (e) { /* degrade to default week start when the plugin is missing */ }

const { parseChineseNaturalDate } = require('../shared/nl-date-core.mjs')

function parseNaturalDate (text, base = dayjs()) {
  return parseChineseNaturalDate(text, base, 'YYYY年M月D日')
}

module.exports = { parseNaturalDate }
