/** Global white-noise player (main-window singleton): lifted from TomatoBar component-private state,
 *  so sound selection from any entry point (float window/CLI etc.) takes effect. Playback follows the focus lifecycle (startTomatoTime plays, everything else stops).
 *  WebAudio seamless looping: the assets are short recordings (1.9~94s); HTMLAudio's loop hard seam gives an obvious "restart" feel,
 *  so the tail is cross-faded with the head into a seamless ring, played by AudioBufferSourceNode(loop);
 *  decode results are cached per key, zero wait on switching/start-stop. Custom audio uses 'local:<key>' (the local:// protocol supports Range). */
import { noiseUrl } from './mediaRegistry.js'

const decoded = new Map() // key → AudioBuffer (after seamless processing)
let current = null // { key, src, gain }
let ctx = null
let startToken = 0 // Monotonic token guarding concurrent startNoise calls across awaits

const clamp01 = v => Math.min(1, Math.max(0, Number(v) || 0))

function srcOf (key) {
  if (!key) return null
  if (key.startsWith('local:')) return 'local://' + encodeURIComponent(key.slice(6))
  return noiseUrl(key) // Preset id; unknown ids return null (old data/invalid values don't play)
}

async function audioCtx () {
  ctx = ctx || new (window.AudioContext || window.webkitAudioContext)()
  if (ctx.state === 'suspended') { try { await ctx.resume() } catch (e) { /* Outside the user-gesture chain, first frame may be silent; playback-failure warning as backstop */ } }
  return ctx
}

/** Cross-fade the last F seconds with the head: signal energy stays continuous across the loop point, no audible seam */
function makeSeamless (buf, fadeSec) {
  const L = buf.length
  const Fs = Math.min(Math.round(fadeSec * buf.sampleRate), Math.floor(L / 3))
  if (Fs <= 0) return buf
  const out = ctx.createBuffer(buf.numberOfChannels, L, buf.sampleRate)
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const s = buf.getChannelData(c)
    const o = out.getChannelData(c)
    o.set(s)
    const start = L - Fs
    for (let i = start; i < L; i++) {
      const t = (i - start) / Fs
      o[i] = s[i] * (1 - t) + s[i - start] * t
    }
  }
  return out
}

async function getBuffer (key) {
  if (decoded.has(key)) return decoded.get(key)
  const src = srcOf(key)
  if (!src) {
    if (key && key.startsWith('file:')) console.warn('[noise] legacy custom audio path is no longer playable, please re-select it in settings:', key)
    return null
  }
  const c = await audioCtx()
  const raw = await c.decodeAudioData(await (await fetch(src)).arrayBuffer())
  const buf = makeSeamless(raw, Math.min(1.5, raw.duration / 4))
  decoded.set(key, buf)
  return buf
}

export async function startNoise (key, volume = .55) {
  if (current && current.key === key) { current.gain.gain.value = clamp01(volume); return } // Same sound: sync volume only, don't replay
  stopNoise()
  // Bump the token: a concurrent call that was awaiting before us becomes stale and must not start
  const token = ++startToken
  let buf
  try { buf = await getBuffer(key) } catch (e) { console.warn('[noise] load failed:', key, e && e.message); return }
  if (!buf) return
  if (token !== startToken || current) return // A newer call (or one that finished while we awaited) owns playback
  const c = await audioCtx()
  if (token !== startToken || current) return // Re-check after the second await
  const src = c.createBufferSource()
  src.buffer = buf
  src.loop = true
  const gain = c.createGain()
  gain.gain.value = clamp01(volume)
  src.connect(gain).connect(c.destination)
  src.start()
  current = { key, src, gain }
}

export function stopNoise () {
  if (current) { try { current.src.stop() } catch (e) { /* */ } current = null }
}

export function setNoiseVolume (v) { if (current) current.gain.gain.value = clamp01(v) }

/** Drop the cached decode for a key (undefined/null = all keys): the user replaced a custom white-noise file,
 *  and the permanent decoded cache would keep playing the old audio until restart. Passing the key that is
 *  currently playing also stops it so the next startNoise re-decodes. */
export function invalidateNoise (key) {
  if (key == null) {
    decoded.clear()
    if (current) stopNoise()
    return
  }
  decoded.delete(key)
  if (current && current.key === key) stopNoise()
}

// Default export = for main.js's `import noisePlayer from ...` usage (with only named exports, that import blows up the whole chain into a white screen under browser ESM)
export default { startNoise, stopNoise, setNoiseVolume, invalidate: invalidateNoise }
