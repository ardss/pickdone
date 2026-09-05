/**
 * Audio asset registry (single source of truth) — ids, files, copy keys, and playback params for confirmation sounds/white noise are defined only here.
 * Adding a sound: 1) put the file into assets/media/ 2) register it here 3) document the source in SOURCES.md. Never build media prefixes inside components.
 */
const MEDIA_BASE = 'app://app/assets/media/'

/** Completion confirmation sounds (valid enum for settings.completeSound; order matches the settings-page dropdown) */
export const CONFIRM_SOUNDS = [
  { id: 'confirm1', labelKey: 'statsE.SettingsModal.soundChime' },
  { id: 'confirm2', labelKey: 'statsE.SettingsModal.soundSoftConfirm' },
  { id: 'confirm3', labelKey: 'statsE.SettingsModal.soundWoodenClick' },
  { id: 'confirm4', labelKey: 'statsE.SettingsModal.soundLowBell' }
]

/** Focus white noise (valid enum for settings.whiteNoiseAudio; order is the recommended order)
 *  Rejected and not included: thunderstorm/boiling/mechanical cabin/ambient soundscapes (transients and variation trigger attentional orienting, contrary to focus goals) */
export const NOISES = [
  { id: 'rain', file: 'rain.mp3', labelKey: 'statsH.TomatoBar.noiseRain' },
  { id: 'rain_to_glass', file: 'rain_to_glass.mp3', labelKey: 'statsH.TomatoBar.noiseRainOnGlass' },
  { id: 'whitenoise', file: 'whitenoise.ogg', labelKey: 'statsH.TomatoBar.noiseWhitenoise' },
  { id: 'waterflow', file: 'waterflow.ogg', labelKey: 'statsH.TomatoBar.noiseWaterflow' },
  { id: 'train', file: 'train.ogg', labelKey: 'statsH.TomatoBar.noiseTrain' },
  { id: 'cave', file: 'cave.ogg', labelKey: 'statsH.TomatoBar.noiseCave' }
]

export const DEFAULT_CONFIRM = 'confirm1'

/** id → full playback URL (confirmation sounds); unknown id falls back to the default sound (safe fallback for old saves/dirty data) */
export function confirmUrl (id) {
  const known = CONFIRM_SOUNDS.some(s => s.id === id)
  return MEDIA_BASE + (known ? id : DEFAULT_CONFIRM) + '.ogg'
}

/** id → full playback URL (white noise); unknown id returns null (caller chooses not to play) */
export function noiseUrl (id) {
  const n = NOISES.find(x => x.id === id)
  return n ? MEDIA_BASE + n.file : null
}
