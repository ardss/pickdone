/** Offline coordinate table of Chinese cities + fallback geocoding
 *  Table: cn-cities-data.js (~340 prefecture-level cities, generated at build time by scripts, static after release) —
 *  the Open-Meteo geocoding library has no Chinese entries for most prefecture-level cities, and Photon/Nominatim is unreliable on mainland networks,
 *  so Chinese city resolution must work locally; this is the main path for weather city lookup.
 *  lookupCity(name): table hit → { name, lat, lon }; miss (district-level/overseas) → null, caller falls back to online geocoding. */
import CN_CITIES from './cn-cities-data.js'

/** Strip administrative-division prefix/suffix: "山西省运城市" "新疆维吾尔自治区吐鲁番地区" → "运城" "吐鲁番" */
function normalize (input) {
  let s = String(input || '').trim()
  s = s.replace(/^.*?(省|自治区|特别行政区)/, '')
  return { base: s.replace(/(市|地区|盟|自治州|旗)$/, ''), raw: s }
}

export function lookupCity (input) {
  if (!input) return null
  const { base, raw } = normalize(input)
  const t = CN_CITIES[base] || CN_CITIES[raw] || CN_CITIES[String(input).trim()]
  if (t) return { name: base, lat: t[0], lon: t[1] }
  return null
}

/** Online fallback: Photon (OSM, no key required, reachable from mainland networks). Only accepts place-type results to avoid hitting stations/POIs */
export async function geocodeOnline (input) {
  const s = String(input || '').trim()
  if (!s) return null
  const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(s)}&osm_tag=place:city&osm_tag=place:town&limit=1`)
  const j = await r.json()
  const f = j.features && j.features[0]
  if (!f || !f.geometry) return null
  const p = f.properties
  return { name: p.name || s, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }
}
