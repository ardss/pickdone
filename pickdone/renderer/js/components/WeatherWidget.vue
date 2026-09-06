<template>

  <div class="weather-widget" :class="{ 'is-loading': loading }" v-if="enabled"
       role="button" tabindex="0" :title="$t('statsD.WeatherWidget.refresh')"
       @click="refresh" @keydown.enter.prevent="refresh">
    <span class="w-icon">{{icon}}</span>
    <span class="w-temp">{{ temp !== null ? temp + '°' : (loading ? '…' : '--') }}</span>
    <span class="w-desc" v-if="error">{{error}}</span>
    <span class="w-desc" v-else>{{desc}}</span>
    <!-- City outline sits next to the city name (user-finalized), not occupying the widget's leftmost position -->
    <svg v-if="shape" class="w-shape" :viewBox="shape.vb" aria-hidden="true">
      <path :d="shape.d"/>
    </svg>
    <span class="w-city" v-if="city">{{city}}</span>
  </div>
</template>

<script lang="ts">
/** Weather widget -- Open-Meteo, free without a key; city = province/city cascade selection in Settings, IP-based location if left empty. Works only when enabled in Settings.
 *  City outline mini icon: fetches the boundary polygon once from OSM Nominatim (free, no key), simplifies it to an outline, and caches locally per city,
 *  rendered as a 26px SVG stroked icon. Refresh = click anywhere on the widget.
 *
 *  Stability contract (user-finalized in the 2026-08-29 release review, fixing "this top block is unstable"):
 *  1. When enabled, the shell always stays mounted -- loading/failure no longer unmounts the component (the old v-if unmount caused sidebar collapse jitter);
 *  2. The last successful result is cached persistently (localStorage weatherCache), showing cached data at startup then refreshing in the background;
 *  3. All fetches time out at 8s (AbortController); on failure the old data is kept and an error state shown;
 *  4. Auto-refresh every 30 minutes (timer cleaned up in beforeUnmount). */

// Values are i18n key tail segments (statsD.WeatherWidget.wmo*), resolved with $t at render time
const WMO = {
  0: 'wmo0', 1: 'wmo1', 2: 'wmo2', 3: 'wmo3',
  45: 'wmo45', 48: 'wmo48',
  51: 'wmo51', 53: 'wmo53', 55: 'wmo55',
  61: 'wmo61', 63: 'wmo63', 65: 'wmo65',
  71: 'wmo71', 73: 'wmo73', 75: 'wmo75',
  80: 'wmo80', 81: 'wmo81', 82: 'wmo82',
  95: 'wmo95', 96: 'wmo96', 99: 'wmo99'
}
const ICON = {
  0: '☀', 1: '🌤', 2: '⛅', 3: '☁',
  45: '🌫', 48: '🌫',
  51: '🌦', 53: '🌧', 55: '🌧',
  61: '🌧', 63: '🌧', 65: '⛈',
  71: '🌨', 73: '🌨', 75: '❄',
  80: '🌦', 81: '🌧', 82: '⛈',
  95: '⛈', 96: '⛈', 99: '⛈'
}

const CACHE_KEY = 'weatherCache'
const FETCH_TIMEOUT = 8000
const AUTO_REFRESH_MS = 30 * 60 * 1000

import { lookupCity, geocodeOnline } from '../utils/cnCities.js'
import CITY_SHAPES from '../utils/city-shapes-data.js'

/** fetch with timeout (AbortController) */
function fetchWithTimeout (url, ms = FETCH_TIMEOUT) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  return fetch(url, { signal: ac.signal }).finally(() => clearTimeout(timer))
}

/** Outline simplification: sample points from the first GeoJSON ring, compressed to within ~60 points (enough at icon size) */
function ringToPath (ring) {
  const step = Math.max(1, Math.ceil(ring.length / 60))
  const pts = []
  for (let i = 0; i < ring.length; i += step) pts.push(ring[i])
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity
  for (const [x, y] of pts) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y) }
  // Normalize to 0 0 60 60: the scale factor must subtract the padding on both sides, otherwise a shape spanning full width/height
  // would reach 63 and be clipped by the viewBox (showing as the outline's lower/right half being cut off); Y is flipped because geographic Y points up
  const PAD = 3
  const span = Math.max(maxX - minX, maxY - minY) || 1
  const k = (60 - PAD * 2) / span
  const d = pts.map(([x, y], i) => {
    const nx = ((x - minX) * k + PAD).toFixed(2)
    const ny = (60 - PAD - (y - minY) * k).toFixed(2)
    return (i ? 'L' : 'M') + nx + ' ' + ny
  }).join('') + 'Z'
  return { d, vb: '0 0 60 60' }
}

/** Extract the largest ring from the Nominatim boundary GeoJSON and simplify it -> { d, vb } */
function geojsonToShape (gj) {
  let ring = null
  const g = gj.geometry || gj
  if (g.type === 'Polygon') ring = g.coordinates[0]
  else if (g.type === 'MultiPolygon') {
    let best = 0
    for (const poly of g.coordinates) {
      if (poly[0].length > best) { best = poly[0].length; ring = poly[0] }
    }
  }
  if (!ring || ring.length < 8) return null
  return ringToPath(ring)
}

/** City outline: built-in China dataset first (zero network, mainland-reliable) -> local cache -> Nominatim online fallback
 *  (Nominatim is DNS-poisoned on mainland networks but reachable from US/EU, so overseas cities resolve there) */
async function loadShape (city) {
  for (const name of cityVariants(city)) {
    // World city keys are lowercase English names, so do a lowercase fallback (sources may be "New York"/"New York City" etc. with mixed casing)
    const builtin = CITY_SHAPES[name] || CITY_SHAPES[name.toLowerCase()] || CITY_SHAPES[name.toLowerCase().replace(/\s+city$/, '')]
    if (builtin) return builtin
    const key = 'geoShape-v2-' + name
    try {
      const cached = localStorage.getItem(key)
      if (cached) return JSON.parse(cached)
    } catch {}
    const r = await fetchWithTimeout(`https://nominatim.openstreetmap.org/search?city=${encodeURIComponent(name)}&format=json&polygon_geojson=1&limit=1&accept-language=zh`)
    const j = await r.json()
    const shape = j[0] ? geojsonToShape(j[0].geojson) : null
    if (shape) {
      try { localStorage.setItem(key, JSON.stringify(shape)) } catch {}

      return shape
    }
  }
  return null
}

/** City name candidate variants: original name first, then successively strip 市/地区/盟/自治州 and 省/自治区/特别行政区 suffixes --
 *  Open-Meteo geocoding and Nominatim fail to resolve suffixed names like "北京市"; stripping the suffix hits */
function cityVariants (city) {
  const list = [city]
  const t1 = city.replace(/(市|地区|盟|自治州)$/, '')
  if (t1 && t1 !== city) list.push(t1)
  const t2 = t1.replace(/(省|自治区|特别行政区)$/, '')
  if (t2 && !list.includes(t2)) list.push(t2)
  return list
}

/** Persistent cache of the last successful result: show cached data at startup then refresh in the background, avoiding "fetching from scratch on every launch" */
function readCache () {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null') } catch { return null }
}
function writeCache (data) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ...data, at: Date.now() })) } catch {}
}

export default {
  name: 'WeatherWidget',
  data () {
    const cached = readCache()
    return {
      temp: cached ? cached.temp : null,
      code: cached ? cached.code : null,
      city: cached ? cached.city : '',
      shape: null as any,
      loading: false,
      error: ''
    }
  },
  computed: {
    enabled () { return !!this.$store.state.settings.weatherEnabled },
    manualCity () { return String(this.$store.state.settings.weatherCity || '').trim() },
    source () { return this.$store.state.settings.weatherSource === 'wttr' ? 'wttr' : 'open-meteo' },
    desc () { const k = WMO[this.code]; return k ? this.$t('statsD.WeatherWidget.' + k) : '' },
    icon () { return ICON[this.code] || '🌡' }
  },
  watch: {
    enabled (v) { if (v) this.fetchWeather(); else this.reset() },
    manualCity () { if (this.enabled) this.fetchWeather() },
    source () { if (this.enabled) this.fetchWeather() }
  },
  mounted () {
    if (this.enabled) this.fetchWeather()
    // Auto-refresh every 30 minutes (skipped while the tab is hidden, reducing needless network traffic)
    this._autoTimer = setInterval(() => {
      if (this.enabled && document.visibilityState === 'visible') this.fetchWeather()
    }, AUTO_REFRESH_MS)
  },
  beforeUnmount () {
    clearInterval(this._autoTimer)
    clearTimeout(this._retryTimer)
  },
  methods: {
    reset () {
      this.temp = null; this.code = null; this.city = ''; this.shape = null; this.error = ''
    },
    /** City outline mini icon (async, may fail -- failure just means no icon) */
    async loadCityShape (city) {
      this.shape = null
      try { this.shape = await loadShape(city) } catch (e) { /* outline fetch failure does not affect weather display */ }
    },
    /** wttr.in (j1 JSON) current weather, weatherCode matches the WMO table */
    async fetchWttr (cityQuery) {
      const r = await fetchWithTimeout(`https://wttr.in/${encodeURIComponent(cityQuery)}?format=j1`)
      const j = await r.json()
      const cur = j.current_condition && j.current_condition[0]
      if (!cur) throw new Error('no data')
      const area = j.nearest_area && j.nearest_area[0]
      return {
        temp: Math.round(+cur.temp_C),
        code: +cur.weatherCode,
        city: (area && (area.areaName[0].value || area.region[0].value)) || cityQuery
      }
    },
    /** Open-Meteo current weather */
    async fetchOpenMeteo (lat, lon, city) {
      const wr = await fetchWithTimeout(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&timezone=auto`
      )
      const wj = await wr.json()
      return wj.current_weather
        ? { temp: Math.round(wj.current_weather.temperature), code: wj.current_weather.weathercode, city }
        : null
    },
    async fetchWeather () {
      if (!this.enabled || this.loading) return // re-entry guard: triggers during a fetch are ignored
      this.loading = true
      try {
        // 1) Location: manual city from Settings takes priority (wttr source passes the city name directly; open-meteo geocodes first), otherwise IP location
        let lat, lon, city
        const manual = this.manualCity
        if (manual && this.source === 'wttr') {
          city = manual // wttr.in resolves cities itself; fall back to IP on query failure
          const local = lookupCity(manual)
          if (local) { lat = local.lat; lon = local.lon } // coordinates ready for fallback when wttr fails
        } else if (manual) {
          // Primary path: offline city table (full Chinese coverage, zero network); next, Photon online as fallback;
          // only then try Open-Meteo geocoding (incomplete Chinese entries for prefecture-level cities, used only as the last line of defense)
          const local = lookupCity(manual)
          if (local) {
            lat = local.lat; lon = local.lon; city = local.name
          } else {
            try {
              const on = await geocodeOnline(manual)
              if (on) { lat = on.lat; lon = on.lon; city = on.name }
            } catch (e) { /* on network failure, continue with the open-meteo geocoding fallback */ }
          }
          if (!lat) {
            for (const name of cityVariants(manual)) {
              const gr = await fetchWithTimeout(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=zh&format=json`)
              const gj = await gr.json()
              const hit = gj.results && gj.results[0]
              if (hit) { lat = hit.latitude; lon = hit.longitude; city = hit.name; break }
            }
          }
          if (!lat) {
            this.error = this.$t('statsD.WeatherWidget.cityNotFound', { city: manual })
            this.city = '' // clear the stale old city name to avoid showing it next to the error message, which would be contradictory
            this.loading = false
            return
          }
        } else {
          try {
            const r = await fetchWithTimeout('https://ipapi.co/json/')
            const j = await r.json()
            lat = j.latitude; lon = j.longitude
            city = j.city || j.region || ''
          } catch (e) { /* IP failure -> default coordinates */ }
          if (!lat) { lat = 39.9; lon = 116.4; city = city || this.$t('statsD.WeatherWidget.fallbackCity') } // fallback
        }

        // 2) Query by data source (every step has a fallback: wttr <- open-meteo coordinates, open-meteo <- wttr lat/lon)
        let cur = null
        if (this.source === 'wttr') {
          try { cur = await this.fetchWttr(city) } catch (e) {
            if (!lat) throw e
            cur = await this.fetchOpenMeteo(lat, lon, city)
          }
        } else {
          try {
            cur = await this.fetchOpenMeteo(lat, lon, city)
          } catch (e) {
            const w = await this.fetchWttr(`${lat},${lon}`)
            cur = { temp: w.temp, code: w.code, city }
          }
        }
        if (cur) {
          this.temp = cur.temp
          this.code = cur.code
          this.city = cur.city
          this.error = ''
          this._retryCount = 0
          clearTimeout(this._retryTimer)
          writeCache({ temp: this.temp, code: this.code, city: this.city })
        }
        // 3) City outline mini icon (async, fails independently)
        if (city) this.loadCityShape(city)
      } catch (e) {
        // On failure keep the already-displayed old data, only mark the error state + auto retry (up to 2 times, at 15s/30s intervals)
        this.error = this.$t('statsD.WeatherWidget.fetchFailed')
        // City outline is decoupled from weather success (user feedback: the outline also vanished on failure) — with a city name it loads as usual (local cache hits mean zero network)
        const c = this.city || this.manualCity
        if (c && !this.shape) this.loadCityShape(c)
        this._retryCount = (this._retryCount || 0) + 1
        if (this._retryCount <= 2) {
          clearTimeout(this._retryTimer)
          // Increment only, never decrement: only a monotonically growing counter can truly stop after two failures
          this._retryTimer = setTimeout(() => {
            if (this.enabled) this.fetchWeather()
          }, this._retryCount === 1 ? 15000 : 30000)
        }
      } finally { this.loading = false }
    },
    refresh () { this.fetchWeather() }
  },

}
</script>
